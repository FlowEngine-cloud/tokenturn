import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anthropicConnector } from "../src/lib/connectors/anthropic";
import { connectConnector, connectedRow } from "../src/lib/connectors/connect";
import { connectorHealth } from "../src/lib/connectors/health";
import { clearConnectors, registerConnector } from "../src/lib/connectors/registry";
import { runSync } from "../src/lib/connectors/sync";
import { clearSecretKeyCache } from "../src/lib/secrets";
import { runMigrations } from "../scripts/migrate.mjs";
import { factRows, identityRows, lastRunRow, metricRows } from "./helpers/ledger";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";
import { replayFile, type ReplaySession } from "./helpers/replay";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");
const FIXTURES = path.resolve(__dirname, "fixtures", "connectors", "anthropic");

/** Pinned clock: fixtures are recorded against this "today" (2026-06-10). */
const NOW = new Date("2026-06-10T12:00:00Z");
const NEXT_DAY = new Date("2026-06-11T09:00:00Z");
/** Incremental fixture is recorded against today = 2026-06-12. */
const TWO_DAYS_LATER = new Date("2026-06-12T09:00:00Z");

const CONFIG = { adminKey: "sk-ant-admin01-test-key" };

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
    ctx.dataDir = mkdtempSync(path.join(os.tmpdir(), "ai-pnl-anthropic-"));
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

describe.runIf(TEST_DATABASE_URL)("anthropic connector", () => {
  beforeAll(() => {
    clearConnectors();
    registerConnector(anthropicConnector);
  });
  afterAll(() => clearConnectors());

  describe("connect + backfill + incremental", () => {
    const ctx = scratch("anthropic_test", true);

    it("rejects a bad admin key with the vendor's error verbatim and stores nothing", async () => {
      await expect(
        connectConnector("anthropic", CONFIG, {
          db: ctx.pool,
          fetch: fixture("connect-unauthorized.json").fetch,
          dataDir: ctx.dataDir,
        }),
      ).rejects.toThrow("invalid x-api-key");
      expect(await connectedRow("anthropic", ctx.pool)).toBeNull();
    });

    it("connects when /v1/organizations/me answers; the connect screen gets the vendor truths", async () => {
      const row = await connectConnector("anthropic", CONFIG, {
        db: ctx.pool,
        fetch: fixture("connect-ok.json").fetch,
        dataDir: ctx.dataDir,
      });
      expect(row.history_limit_days).toBe(31);
      expect(row.scopes).toEqual(["admin_api"]);

      const health = await connectorHealth("anthropic", ctx.pool);
      // No key-creation API - the connect screen must say so (spec 5).
      expect(health!.connectNotes.join(" ")).toMatch(/no key-creation API/);
      expect(health!.connectNotes.join(" ")).toMatch(/per API key and workspace only, never per user/);
      expect(health!.configFields).toEqual([
        { key: "adminKey", label: "Admin API key", secret: true },
      ]);
    });

    it("backfills 31 days: users, keys (created_by auto-map), per-key estimated usage, non-token invoiced costs, Claude Code metrics", async () => {
      const session = fixture("backfill.json");
      const result = await runSync("anthropic", {
        pool: ctx.pool,
        fetch: session.fetch,
        now: NOW,
        dataDir: ctx.dataDir,
      });

      expect(result.status).toBe("success");
      expect(result.window).toEqual({ since: "2026-05-10", until: "2026-06-10" });
      // 8 facts (6 usage + 2 non-token cost) + 54 metrics (6 records x 9 counters)
      expect(result.rowsSynced).toBe(62);
      // Every recorded request was made: both usage/cost pages, all 32
      // claude_code days, the paged api_keys list - window math is pinned.
      expect(session.remaining()).toHaveLength(0);

      const expected = JSON.parse(
        readFileSync(path.join(FIXTURES, "backfill-expected.json"), "utf8"),
      );
      expect(await factRows(ctx.pool, "anthropic")).toEqual(expected.facts);
      expect(await identityRows(ctx.pool, "anthropic")).toEqual(expected.identities);

      expect(JSON.parse((await lastRunRow(ctx.pool, "anthropic")).cursor)).toEqual({
        watermark: "2026-06-10",
      });
    });

    it("Claude Code analytics land as per-user metrics, never as spend", async () => {
      const metrics = await metricRows(ctx.pool, "anthropic");
      expect(metrics).toHaveLength(54);

      // dana, 2026-06-08, via the org-user identity (email matched to /users)
      const dana = Object.fromEntries(
        metrics
          .filter((m) => m.sourceRef === "cc:2026-06-08:dana@acme.com:iTerm.app")
          .map((m) => [m.metric, m.value]),
      );
      expect(dana).toEqual({
        sessions: 5,
        commits: 3,
        pull_requests: 1,
        lines_added: 320,
        lines_removed: 40,
        tool_actions_accepted: 22,
        tool_actions_rejected: 2,
        tokens: 298000,
        estimated_cost_cents: 130,
      });
      const danaRow = metrics.find(
        (m) => m.sourceRef === "cc:2026-06-08:dana@acme.com:iTerm.app" && m.metric === "commits",
      );
      expect(danaRow).toMatchObject({
        day: "2026-06-08",
        identityExternalId: "user_01DANA",
        personEmail: "dana@acme.com",
      });

      // api_actor reports the key NAME - resolved to the key, owned by its creator
      const batch = metrics.find(
        (m) =>
          m.sourceRef === "cc:2026-06-10:key:batch-processing:headless" &&
          m.metric === "sessions",
      );
      expect(batch).toMatchObject({
        value: 12,
        identityExternalId: "apikey_01BATCH",
        personEmail: "dana@acme.com",
      });

      // an actor that is no longer an org member is auto-discovered, unmapped
      const ghost = metrics.find(
        (m) => m.sourceRef === "cc:2026-06-10:ghost@acme.com:iTerm.app" && m.metric === "sessions",
      );
      expect(ghost).toMatchObject({
        value: 1,
        identityExternalId: "ghost@acme.com",
        personEmail: null,
      });

      // subscription-seat users (no API billing) still get their metrics
      const lee = metrics.find(
        (m) =>
          m.sourceRef === "cc:2026-06-08:lee@acme.com:vscode" &&
          m.metric === "estimated_cost_cents",
      );
      expect(lee).toMatchObject({ value: 60, personEmail: "lee@acme.com" });

      // and none of those dollars are in the spend ledger (no double counting)
      const { rows } = await ctx.pool.query(
        "SELECT count(*) AS n FROM spend_facts WHERE vendor = 'anthropic' AND source_ref LIKE 'cc:%'",
      );
      expect(Number(rows[0].n)).toBe(0);
    });

    it("incremental sync restates the trailing window in place and a key rename re-tags", async () => {
      const result = await runSync("anthropic", {
        pool: ctx.pool,
        fetch: fixture("incremental.json").fetch,
        now: TWO_DAYS_LATER,
        dataDir: ctx.dataDir,
      });
      expect(result.status).toBe("success");
      // watermark 2026-06-10, re-pull widens to today-7 = 2026-06-05
      expect(result.window).toEqual({ since: "2026-06-05", until: "2026-06-12" });

      const facts = await factRows(ctx.pool, "anthropic");
      expect(facts).toHaveLength(9); // 8 backfilled + 1 new day; nothing duplicated
      const restated = facts.find(
        (f) => f.sourceRef === "usage:2026-06-10:apikey_01DANA:wrkspc_01ENG:claude-opus-4-6",
      );
      expect(restated).toMatchObject({ amountCents: 60, tokens: 88000 }); // vendor restated 38 -> 60
      const fresh = facts.find(
        (f) => f.sourceRef === "usage:2026-06-11:apikey_01OMAR:wrkspc_01ENG:claude-sonnet-4-6",
      );
      expect(fresh).toMatchObject({ amountCents: 45, personEmail: "omar@acme.com" });

      // key renamed omar-laptop -> omar-mbp: identity re-tags, history follows
      const identities = await identityRows(ctx.pool, "anthropic");
      const omarKey = identities.find((i) => i.externalId === "apikey_01OMAR");
      expect(omarKey).toMatchObject({
        displayName: "omar-mbp",
        tags: ["omar-mbp"],
        personEmail: "omar@acme.com",
      });

      const metrics = await metricRows(ctx.pool, "anthropic");
      expect(metrics).toHaveLength(63); // 54 restated in place + 9 for the new day
    });

    it("replaying the exact same sync changes nothing", async () => {
      const factsBefore = await factRows(ctx.pool, "anthropic");
      const metricsBefore = await metricRows(ctx.pool, "anthropic");
      const result = await runSync("anthropic", {
        pool: ctx.pool,
        fetch: fixture("incremental.json").fetch,
        now: new Date("2026-06-12T10:00:00Z"),
        dataDir: ctx.dataDir,
      });
      expect(result.status).toBe("success");
      expect(await factRows(ctx.pool, "anthropic")).toEqual(factsBefore);
      expect(await metricRows(ctx.pool, "anthropic")).toEqual(metricsBefore);
    });

    it("health counts facts, identities, and metrics live from the tables", async () => {
      const health = await connectorHealth("anthropic", ctx.pool);
      expect(health).toMatchObject({
        vendor: "anthropic",
        displayName: "Anthropic",
        connected: true,
        historyLimitDays: 31,
        rowCounts: { spendFacts: 9, identities: 7, metrics: 63 },
      });
    });
  });

  describe("resume mid-backfill after a vendor failure", () => {
    const ctx = scratch("anthropic_resume", true);

    it("a 500 mid-usage stores the vendor error verbatim and keeps committed phases", async () => {
      await connectConnector("anthropic", CONFIG, {
        db: ctx.pool,
        fetch: fixture("connect-ok.json").fetch,
        dataDir: ctx.dataDir,
      });
      const result = await runSync("anthropic", {
        pool: ctx.pool,
        fetch: fixture("backfill-usage-page2-fails.json").fetch,
        now: NOW,
        dataDir: ctx.dataDir,
      });

      expect(result.status).toBe("error");
      expect(result.error).toBe("Internal server error");
      // users + api_keys + usage page 1 are committed; page 2 is not
      expect(await factRows(ctx.pool, "anthropic")).toHaveLength(5);

      const run = await lastRunRow(ctx.pool, "anthropic");
      const cursor = JSON.parse(run.cursor);
      expect(cursor.inProgress).toMatchObject({ since: "2026-05-10", until: "2026-06-10" });
      // the composite token points at the exact failed phase + page
      expect(JSON.parse(cursor.inProgress.pageToken)).toMatchObject({
        phase: "usage",
        cursor: "usage_p2",
      });
    });

    it("the next run resumes the failed usage page - and the user/key maps survive", async () => {
      const session = fixture("resume-from-usage-page2.json");
      const result = await runSync("anthropic", {
        pool: ctx.pool,
        fetch: session.fetch,
        now: NEXT_DAY,
        dataDir: ctx.dataDir,
      });

      expect(result.status).toBe("success");
      expect(result.window).toEqual({ since: "2026-05-10", until: "2026-06-10" });
      expect(session.remaining()).toHaveLength(0);

      // the finished ledger is byte-identical to the uninterrupted backfill
      const expected = JSON.parse(
        readFileSync(path.join(FIXTURES, "backfill-expected.json"), "utf8"),
      );
      expect(await factRows(ctx.pool, "anthropic")).toEqual(expected.facts);
      expect(await identityRows(ctx.pool, "anthropic")).toEqual(expected.identities);
      expect(await metricRows(ctx.pool, "anthropic")).toHaveLength(54);
      expect(JSON.parse((await lastRunRow(ctx.pool, "anthropic")).cursor)).toEqual({
        watermark: "2026-06-10",
      });
    });
  });

  describe("vendor drift fails the sync instead of writing bad numbers", () => {
    const ctx = scratch("anthropic_drift", false);

    it("an unpriced model fails the usage phase with the model named", async () => {
      await connectConnector("anthropic", CONFIG, {
        db: ctx.pool,
        fetch: fixture("connect-ok.json").fetch,
        dataDir: ctx.dataDir,
      });
      const result = await runSync("anthropic", {
        pool: ctx.pool,
        fetch: fixture("drift-unknown-model.json").fetch,
        now: NOW,
        dataDir: ctx.dataDir,
      });
      expect(result.status).toBe("error");
      expect(result.error).toBe(
        'no pinned price for Anthropic model "claude-zeta-9" - add it to the pinned price file (src/lib/connectors/model-prices.json)',
      );
      expect(await factRows(ctx.pool, "anthropic")).toHaveLength(0);
    });

    it("an unexpected field in a Claude Code record fails the sync verbatim", async () => {
      const result = await runSync("anthropic", {
        pool: ctx.pool,
        fetch: fixture("drift-claude-code.json").fetch,
        now: NOW,
        dataDir: ctx.dataDir,
      });
      expect(result.status).toBe("error");
      expect(result.error).toBe('anthropic claude code record: unexpected field "speed_index"');
      expect(await metricRows(ctx.pool, "anthropic")).toHaveLength(0);
      // and the error sits on the run for the health surface
      expect((await lastRunRow(ctx.pool, "anthropic")).error).toMatch(/speed_index/);
    });
  });
});
