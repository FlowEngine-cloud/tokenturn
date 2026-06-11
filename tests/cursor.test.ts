import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectConnector, connectedRow } from "../src/lib/connectors/connect";
import { cursorConnector } from "../src/lib/connectors/cursor";
import { connectorHealth } from "../src/lib/connectors/health";
import { clearConnectors, registerConnector } from "../src/lib/connectors/registry";
import { runSync } from "../src/lib/connectors/sync";
import { clearSecretKeyCache } from "../src/lib/secrets";
import { runMigrations } from "../scripts/migrate.mjs";
import { factRows, identityRows, lastRunRow, metricRows } from "./helpers/ledger";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";
import { replayFile, type ReplaySession } from "./helpers/replay";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");
const FIXTURES = path.resolve(__dirname, "fixtures", "connectors", "cursor");

/** Pinned clock: fixtures are recorded against this "today" (2026-06-11). */
const NOW = new Date("2026-06-11T12:00:00Z");
const NEXT_DAY = new Date("2026-06-12T09:00:00Z");
/** Incremental fixture is recorded against today = 2026-06-13. */
const TWO_DAYS_LATER = new Date("2026-06-13T09:00:00Z");

const CONFIG = { apiKey: "key_cursor_admin_test" };

/** Timestamps the recorded events carry (epoch ms, see the fixtures). */
const TS_DANA = Date.parse("2026-06-09T14:30:25.854Z");
const TS_DUP = Date.parse("2026-06-09T16:00:00.000Z");
const TS_INCLUDED = Date.parse("2026-06-09T10:00:00.500Z");
const TS_SA = Date.parse("2026-06-10T03:00:00.000Z");
const TS_NEW = Date.parse("2026-06-12T11:30:00.000Z");

function fixture(name: string): ReplaySession {
  return replayFile(path.join(FIXTURES, name));
}

async function seedPeople(pool: Pool) {
  await pool.query(
    `INSERT INTO people (email, name, source) VALUES
       ('dana@acme.com', 'Dana', 'manual'),
       ('omar@acme.com', 'Omar', 'manual'),
       ('lee@acme.com', 'Lee', 'manual')`,
  );
}

/** One scratch DB per scenario - cursors and ledgers stay independent. */
function scratch(prefix: string, seed: boolean) {
  const ctx = { pool: null as unknown as Pool, dbUrl: "", dataDir: "" };
  beforeAll(async () => {
    ctx.dbUrl = await createScratchDb(prefix);
    await runMigrations({ databaseUrl: ctx.dbUrl, dir: MIGRATIONS_DIR });
    ctx.pool = new Pool({ connectionString: ctx.dbUrl, max: 5 });
    ctx.dataDir = mkdtempSync(path.join(os.tmpdir(), "ai-pnl-cursor-"));
    if (seed) await seedPeople(ctx.pool);
  });
  afterAll(async () => {
    await ctx.pool?.end();
    if (ctx.dbUrl) await dropScratchDb(ctx.dbUrl);
    clearSecretKeyCache();
    if (ctx.dataDir) rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  return ctx;
}

describe.runIf(TEST_DATABASE_URL)("cursor connector", () => {
  beforeAll(() => {
    clearConnectors();
    registerConnector(cursorConnector);
  });
  afterAll(() => clearConnectors());

  describe("connect + backfill + incremental", () => {
    const ctx = scratch("cursor_test", true);

    it("rejects a bad API key with the vendor's error verbatim and stores nothing", async () => {
      await expect(
        connectConnector("cursor", CONFIG, {
          db: ctx.pool,
          fetch: fixture("connect-unauthorized.json").fetch,
          dataDir: ctx.dataDir,
        }),
      ).rejects.toThrow("Invalid API key.");
      expect(await connectedRow("cursor", ctx.pool)).toBeNull();
    });

    it("rejects a team below Business - both surfaces are probed on connect", async () => {
      await expect(
        connectConnector("cursor", CONFIG, {
          db: ctx.pool,
          fetch: fixture("connect-not-business.json").fetch,
          dataDir: ctx.dataDir,
        }),
      ).rejects.toThrow("The Admin API is only available on Business and Enterprise plans.");
      expect(await connectedRow("cursor", ctx.pool)).toBeNull();
    });

    it("connects when both probes answer; the connect screen gets the vendor truths", async () => {
      const row = await connectConnector("cursor", CONFIG, {
        db: ctx.pool,
        fetch: fixture("connect-ok.json").fetch,
        dataDir: ctx.dataDir,
      });
      expect(row.history_limit_days).toBe(90);
      expect(row.scopes).toEqual(["admin_api"]);

      const health = await connectorHealth("cursor", ctx.pool);
      // The plan gates, verbatim on the connect screen (spec 5 + 9): the
      // API needs Business+, limit writes are Enterprise only.
      expect(health!.connectNotes.join(" ")).toMatch(/requires a Business or Enterprise plan/);
      expect(health!.connectNotes.join(" ")).toMatch(
        /spend limits through the API is Enterprise only/,
      );
      expect(health!.connectNotes.join(" ")).toMatch(/included usage .* never become spend/);
      expect(health!.connectNotes.join(" ")).toMatch(/Seat fees .* never invented/);
      // No Cursor invite API exists - the connect screen says so, and the
      // vendor is never offered in the invite fan-out.
      expect(health!.connectNotes.join(" ")).toMatch(/no API for adding members/);
      expect(health!.invitable).toBe(false);
      expect(health!.configFields).toEqual([
        { key: "apiKey", label: "Admin API key", secret: true },
      ]);
    });

    it("backfills 90 days in 30-day chunks: members, cycle spend, daily activity, per-event spend", async () => {
      const session = fixture("backfill.json");
      const result = await runSync("cursor", {
        pool: ctx.pool,
        fetch: session.fetch,
        now: NOW,
        dataDir: ctx.dataDir,
      });

      expect(result.status).toBe("success");
      expect(result.window).toEqual({ since: "2026-03-13", until: "2026-06-11" });
      // 7 chargeable event facts + 10 cycle-spend metrics + 51 daily counters
      expect(result.rowsSynced).toBe(68);
      // Every recorded request was made - members, both spend pages, all
      // four 30-day chunks of daily and events (empty ones included), the
      // paged ones walked page by page. The recordings match URL AND JSON
      // body, so the chunk/window math is pinned by the fixture.
      expect(session.remaining()).toHaveLength(0);

      const expected = JSON.parse(
        readFileSync(path.join(FIXTURES, "backfill-expected.json"), "utf8"),
      );
      expect(await factRows(ctx.pool, "cursor")).toEqual(expected.facts);
      expect(await identityRows(ctx.pool, "cursor")).toEqual(expected.identities);
      expect(await metricRows(ctx.pool, "cursor")).toEqual(expected.metrics);

      expect(JSON.parse((await lastRunRow(ctx.pool, "cursor")).cursor)).toEqual({
        watermark: "2026-06-11",
      });
    });

    it("books each chargeable event as billed money on the member who spent it", async () => {
      const facts = await factRows(ctx.pool, "cursor");

      // chargedCents 21.36232 (post-discount, incl. Cursor's token fee)
      // rounds to 21; tokens = input 126 + output 450 + cacheWrite 6112 +
      // cacheRead 11964 = 18652.
      expect(
        facts.find((f) => f.sourceRef === `event:${TS_DANA}:dana@acme.com:claude-4.5-sonnet`),
      ).toMatchObject({
        day: "2026-06-09",
        amountCents: 21,
        tokens: 18652,
        costBasis: "invoiced",
        identityExternalId: "101",
        personEmail: "dana@acme.com",
      });

      // Events have no vendor id: two same-millisecond events of one
      // (spender, model) get deterministic #n suffixes - both kept, never
      // collapsed into one row.
      expect(
        facts.find((f) => f.sourceRef === `event:${TS_DUP}:dana@acme.com:gpt-5`),
      ).toMatchObject({ amountCents: 30, tokens: 1200 });
      expect(
        facts.find((f) => f.sourceRef === `event:${TS_DUP}:dana@acme.com:gpt-5#2`),
      ).toMatchObject({ amountCents: 8, tokens: 400 });

      // "Included in Business" is consumption the seat already covers, not
      // billed money - it never becomes spend, so the ledger sums to what
      // Cursor bills. (Visible instead via cycle_overall_spend_cents.)
      expect(facts.some((f) => f.sourceRef.startsWith(`event:${TS_INCLUDED}:`))).toBe(false);

      // A non-token event still carries its charged cents, just no tokens.
      expect(facts.find((f) => f.sourceRef.endsWith(":auto"))).toMatchObject({
        amountCents: 34,
        tokens: 0,
        personEmail: "omar@acme.com",
      });
    });

    it("routes service-account traffic to the service account and unknown emails to Resolve", async () => {
      const facts = await factRows(ctx.pool, "cursor");
      const identities = await identityRows(ctx.pool, "cursor");

      // Agent/CI spend lands on the service account (kind api_key, name =
      // tag -> product routing), never on its pseudo-user email.
      expect(
        facts.find((f) => f.sourceRef === `event:${TS_SA}:sa:sa_nightly:claude-4.5-sonnet`),
      ).toMatchObject({ amountCents: 150, identityExternalId: "sa_nightly", personEmail: null });
      expect(identities.find((i) => i.externalId === "sa_nightly")).toMatchObject({
        kind: "api_key",
        displayName: "Nightly CI Agent",
        tags: ["Nightly CI Agent"],
        personEmail: null,
      });

      // A member Cursor knows but People doesn't: attributed to the vendor
      // identity, person unresolved (Resolve queue), never invented.
      expect(identities.find((i) => i.externalId === "104")).toMatchObject({
        email: "eve@acme.com",
        personEmail: null,
      });
      // An email the roster doesn't know still owns its spend, keyed by email.
      expect(facts.find((f) => f.sourceRef.includes(":zoe@acme.com:"))).toMatchObject({
        amountCents: 12,
        identityExternalId: "zoe@acme.com",
        personEmail: null,
      });
      // Removed members keep their history mapped (Lee left the team).
      expect(identities.find((i) => i.externalId === "103")).toMatchObject({
        personEmail: "lee@acme.com",
      });
    });

    it("stores the vendor's cycle spend as per-member metrics, never as ledger money", async () => {
      const metrics = await metricRows(ctx.pool, "cursor");
      const dana = metrics.filter((m) => m.sourceRef === "spend:2026-06-01:101");
      // The vendor's own cycle-to-date numbers (fractional cents rounded):
      // on-demand 2450.125487 -> 2450, overall 5450.725487 -> 5451, and the
      // per-user limit Cursor enforces (spec 9 shows it next to ours).
      expect(dana.map((m) => [m.metric, m.value])).toEqual([
        ["cycle_overall_spend_cents", 5451],
        ["cycle_spend_cents", 2450],
        ["spend_limit_dollars", 200],
      ]);
      // No vendor limit -> no limit metric, never an invented zero. Omar's
      // included-usage consumption stays visible (overall 1876) even though
      // his billed on-demand spend is 0.
      const omar = metrics.filter((m) => m.sourceRef === "spend:2026-06-01:102");
      expect(omar.map((m) => [m.metric, m.value])).toEqual([
        ["cycle_overall_spend_cents", 1876],
        ["cycle_spend_cents", 0],
      ]);
      // Cycle aggregates never double the ledger: all spend facts are events.
      const facts = await factRows(ctx.pool, "cursor");
      expect(facts.every((f) => f.sourceRef.startsWith("event:"))).toBe(true);
    });

    it("stores daily activity counters per member and skips inactive placeholder rows", async () => {
      const metrics = await metricRows(ctx.pool, "cursor");
      const dana = Object.fromEntries(
        metrics
          .filter((m) => m.sourceRef === "daily:2026-06-09:101")
          .map((m) => [m.metric, m.value]),
      );
      // The Tools-page accept-rate inputs, straight from the vendor.
      expect(dana).toMatchObject({
        tabs_shown: 342,
        tabs_accepted: 289,
        applies: 87,
        accepts: 73,
        rejects: 14,
        lines_added: 1543,
        accepted_lines_added: 1102,
        usage_based_requests: 5,
      });
      expect(metrics.filter((m) => m.sourceRef === "daily:2026-06-09:101")).toHaveLength(17);
      // Eve's 2026-06-10 row is an inactive all-zero placeholder - no data,
      // not a restatement; nothing is stored.
      expect(metrics.some((m) => m.sourceRef === "daily:2026-06-10:104")).toBe(false);
    });

    it("incremental sync restates the trailing window in place", async () => {
      const result = await runSync("cursor", {
        pool: ctx.pool,
        fetch: fixture("incremental.json").fetch,
        now: TWO_DAYS_LATER,
        dataDir: ctx.dataDir,
      });
      expect(result.status).toBe("success");
      // watermark 2026-06-11, re-pull widens to today-7 = 2026-06-06
      expect(result.window).toEqual({ since: "2026-06-06", until: "2026-06-13" });

      const facts = await factRows(ctx.pool, "cursor");
      expect(facts).toHaveLength(8); // 7 backfilled + 1 new event
      // Vendor restated Dana's event 21.36232 -> 25 cents: same sourceRef,
      // restated in place, never duplicated.
      expect(
        facts.find((f) => f.sourceRef === `event:${TS_DANA}:dana@acme.com:claude-4.5-sonnet`),
      ).toMatchObject({ amountCents: 25 });
      expect(
        facts.find((f) => f.sourceRef === `event:${TS_NEW}:omar@acme.com:claude-4.5-sonnet`),
      ).toMatchObject({ day: "2026-06-12", amountCents: 19, personEmail: "omar@acme.com" });

      const metrics = await metricRows(ctx.pool, "cursor");
      // Dana's 2026-06-09 applies restated 87 -> 90; Omar's new day appears.
      expect(
        metrics.find((m) => m.sourceRef === "daily:2026-06-09:101" && m.metric === "applies"),
      ).toMatchObject({ value: 90 });
      expect(metrics.filter((m) => m.sourceRef === "daily:2026-06-12:102")).toHaveLength(17);
      // The running cycle restates in place: same row, new value, no new rows.
      expect(
        metrics.find(
          (m) => m.sourceRef === "spend:2026-06-01:101" && m.metric === "cycle_spend_cents",
        ),
      ).toMatchObject({ value: 3000 });
      expect(metrics).toHaveLength(78); // 61 backfilled + 17 for Omar's new day
    });

    it("replaying the exact same sync changes nothing", async () => {
      const factsBefore = await factRows(ctx.pool, "cursor");
      const metricsBefore = await metricRows(ctx.pool, "cursor");
      const result = await runSync("cursor", {
        pool: ctx.pool,
        fetch: fixture("incremental.json").fetch,
        now: new Date("2026-06-13T10:00:00Z"),
        dataDir: ctx.dataDir,
      });
      expect(result.status).toBe("success");
      expect(await factRows(ctx.pool, "cursor")).toEqual(factsBefore);
      expect(await metricRows(ctx.pool, "cursor")).toEqual(metricsBefore);
    });

    it("health counts facts, identities, and metrics live from the tables", async () => {
      const health = await connectorHealth("cursor", ctx.pool);
      expect(health).toMatchObject({
        vendor: "cursor",
        displayName: "Cursor",
        connected: true,
        historyLimitDays: 90,
        rowCounts: { spendFacts: 8, identities: 6, metrics: 78 },
      });
    });
  });

  describe("resume mid-backfill after a vendor failure", () => {
    const ctx = scratch("cursor_resume", true);

    it("a 500 mid-events stores the vendor error verbatim and keeps committed phases", async () => {
      await connectConnector("cursor", CONFIG, {
        db: ctx.pool,
        fetch: fixture("connect-ok.json").fetch,
        dataDir: ctx.dataDir,
      });
      const result = await runSync("cursor", {
        pool: ctx.pool,
        fetch: fixture("backfill-events-page2-fails.json").fetch,
        now: NOW,
        dataDir: ctx.dataDir,
      });

      expect(result.status).toBe("error");
      expect(result.error).toBe("Internal server error");
      // members + spend + daily + events through chunk 2 page 1 are
      // committed; the failed page is not.
      expect(await factRows(ctx.pool, "cursor")).toHaveLength(4);
      expect(await metricRows(ctx.pool, "cursor")).toHaveLength(61);

      const run = await lastRunRow(ctx.pool, "cursor");
      const cursor = JSON.parse(run.cursor);
      expect(cursor.inProgress).toMatchObject({ since: "2026-03-13", until: "2026-06-11" });
      // the composite token points at the exact failed phase, chunk, and page
      expect(JSON.parse(cursor.inProgress.pageToken)).toMatchObject({
        phase: "events",
        chunk: 2,
        page: 2,
      });
    });

    it("the next run resumes the failed events page and finishes the window", async () => {
      const session = fixture("resume-from-events-page2.json");
      const result = await runSync("cursor", {
        pool: ctx.pool,
        fetch: session.fetch,
        now: NEXT_DAY,
        dataDir: ctx.dataDir,
      });

      expect(result.status).toBe("success");
      expect(result.window).toEqual({ since: "2026-03-13", until: "2026-06-11" });
      expect(session.remaining()).toHaveLength(0);

      // the finished ledger is byte-identical to the uninterrupted backfill
      const expected = JSON.parse(
        readFileSync(path.join(FIXTURES, "backfill-expected.json"), "utf8"),
      );
      expect(await factRows(ctx.pool, "cursor")).toEqual(expected.facts);
      expect(await identityRows(ctx.pool, "cursor")).toEqual(expected.identities);
      expect(await metricRows(ctx.pool, "cursor")).toEqual(expected.metrics);
      expect(JSON.parse((await lastRunRow(ctx.pool, "cursor")).cursor)).toEqual({
        watermark: "2026-06-11",
      });
    });
  });

  describe("vendor drift fails the sync instead of writing bad numbers", () => {
    const ctx = scratch("cursor_drift", false);

    it("a daily row whose epoch date contradicts its day fails with both named", async () => {
      await connectConnector("cursor", CONFIG, {
        db: ctx.pool,
        fetch: fixture("connect-ok.json").fetch,
        dataDir: ctx.dataDir,
      });
      const result = await runSync("cursor", {
        pool: ctx.pool,
        fetch: fixture("drift-daily-format.json").fetch,
        now: NOW,
        dataDir: ctx.dataDir,
      });
      expect(result.status).toBe("error");
      expect(result.error).toBe(
        `cursor daily usage row: date ${Date.parse("2026-03-13T00:00:00Z")} is not UTC midnight of day 2026-03-14`,
      );
      expect(await factRows(ctx.pool, "cursor")).toHaveLength(0);
      expect(await metricRows(ctx.pool, "cursor")).toHaveLength(0);
    });

    it("an unexpected field in a usage event fails the resumed sync verbatim", async () => {
      const result = await runSync("cursor", {
        pool: ctx.pool,
        fetch: fixture("drift-event-format.json").fetch,
        now: NOW,
        dataDir: ctx.dataDir,
      });
      expect(result.status).toBe("error");
      expect(result.error).toBe('cursor usage event: unexpected field "costCents"');
      expect(await factRows(ctx.pool, "cursor")).toHaveLength(0);
      // and the error sits on the run for the health surface
      expect((await lastRunRow(ctx.pool, "cursor")).error).toMatch(/costCents/);
    });
  });
});
