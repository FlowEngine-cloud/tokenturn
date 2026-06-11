import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectConnector, connectedRow } from "../src/lib/connectors/connect";
import { connectorHealth } from "../src/lib/connectors/health";
import { openaiConnector } from "../src/lib/connectors/openai";
import { clearConnectors, registerConnector } from "../src/lib/connectors/registry";
import { runSync } from "../src/lib/connectors/sync";
import { clearSecretKeyCache } from "../src/lib/secrets";
import { runMigrations } from "../scripts/migrate.mjs";
import { factRows, identityRows, lastRunRow, metricRows } from "./helpers/ledger";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";
import { replayFile, type ReplaySession } from "./helpers/replay";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");
const FIXTURES = path.resolve(__dirname, "fixtures", "connectors", "openai");

/** Pinned clock: fixtures are recorded against this "today" (2026-06-11). */
const NOW = new Date("2026-06-11T12:00:00Z");
const NEXT_DAY = new Date("2026-06-12T09:00:00Z");
/** Incremental fixture is recorded against today = 2026-06-13. */
const TWO_DAYS_LATER = new Date("2026-06-13T09:00:00Z");

const CONFIG = { adminKey: "sk-admin-test-key" };

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
    ctx.dataDir = mkdtempSync(path.join(os.tmpdir(), "ai-pnl-openai-"));
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

describe.runIf(TEST_DATABASE_URL)("openai connector", () => {
  beforeAll(() => {
    clearConnectors();
    registerConnector(openaiConnector);
  });
  afterAll(() => clearConnectors());

  describe("connect + backfill + incremental", () => {
    const ctx = scratch("openai_test", true);

    it("rejects a bad admin key with the vendor's error verbatim and stores nothing", async () => {
      await expect(
        connectConnector("openai", CONFIG, {
          db: ctx.pool,
          fetch: fixture("connect-unauthorized.json").fetch,
          dataDir: ctx.dataDir,
        }),
      ).rejects.toThrow("Incorrect API key provided");
      expect(await connectedRow("openai", ctx.pool)).toBeNull();
    });

    it("rejects an admin key missing the usage scope - both surfaces are probed on connect", async () => {
      await expect(
        connectConnector("openai", CONFIG, {
          db: ctx.pool,
          fetch: fixture("connect-missing-scope.json").fetch,
          dataDir: ctx.dataDir,
        }),
      ).rejects.toThrow("Missing scopes: api.usage.read");
      expect(await connectedRow("openai", ctx.pool)).toBeNull();
    });

    it("connects when both probes answer; the connect screen gets the vendor truths", async () => {
      const row = await connectConnector("openai", CONFIG, {
        db: ctx.pool,
        fetch: fixture("connect-ok.json").fetch,
        dataDir: ctx.dataDir,
      });
      expect(row.history_limit_days).toBe(180);
      expect(row.scopes).toEqual(["api.management.read", "api.usage.read"]);

      const health = await connectorHealth("openai", ctx.pool);
      // Per-user dollars are estimates - the connect screen must say so (spec 5).
      expect(health!.connectNotes.join(" ")).toMatch(/no user grouping/);
      expect(health!.connectNotes.join(" ")).toMatch(/always marked estimated/);
      expect(health!.connectNotes.join(" ")).toMatch(/would double count/);
      expect(health!.configFields).toEqual([
        { key: "adminKey", label: "Admin API key", secret: true },
      ]);
    });

    it("backfills 180 days: users, projects, per-project keys, per-user estimated usage, per-project invoiced costs", async () => {
      const session = fixture("backfill.json");
      const result = await runSync("openai", {
        pool: ctx.pool,
        fetch: session.fetch,
        now: NOW,
        dataDir: ctx.dataDir,
      });

      expect(result.status).toBe("success");
      expect(result.window).toEqual({ since: "2025-12-13", until: "2026-06-11" });
      // 7 usage facts + 3 kept cost facts; token line items are skipped
      expect(result.rowsSynced).toBe(10);
      // Every recorded request was made: both usage/cost pages, the paged
      // per-project key lists - window math is pinned by the recording.
      expect(session.remaining()).toHaveLength(0);

      const expected = JSON.parse(
        readFileSync(path.join(FIXTURES, "backfill-expected.json"), "utf8"),
      );
      expect(await factRows(ctx.pool, "openai")).toEqual(expected.facts);
      expect(await identityRows(ctx.pool, "openai")).toEqual(expected.identities);

      expect(JSON.parse((await lastRunRow(ctx.pool, "openai")).cursor)).toEqual({
        watermark: "2026-06-11",
      });
    });

    it("prices per-user tokens from the pinned table: cache, batch, and audio rates", async () => {
      const facts = await factRows(ctx.pool, "openai");

      // (100k input - 20k cached)*$1.25 + 20k cached*$0.125 + 10k out*$10 per MTok = 20.25c
      expect(
        facts.find((f) => f.sourceRef === "usage:2026-06-09:user-dana:key_dana:gpt-5-2025-08-07:live"),
      ).toMatchObject({
        amountCents: 20,
        tokens: 110000,
        costBasis: "estimated",
        personEmail: "dana@acme.com",
      });

      // Batch rows bill at the pinned 50% batch rates: 1M*$1 + 100k*$4 = $1.40
      // (live rates would make it 280 cents). No user -> attributed to the
      // service key, unmapped until Resolve routes it.
      expect(
        facts.find((f) => f.sourceRef === "usage:2026-06-09:none:key_svc:gpt-4.1-2025-04-14:batch"),
      ).toMatchObject({
        amountCents: 140,
        identityExternalId: "key_svc",
        personEmail: null,
      });

      // Audio tokens bill at the pinned audio rates: 5k*$2.5 + 1k*$10 + 10k*$40 + 2k*$80 = 58.25c
      expect(
        facts.find(
          (f) =>
            f.sourceRef === "usage:2026-06-10:user-dana:key_dana:gpt-4o-audio-preview-2024-12-17:live",
        ),
      ).toMatchObject({ amountCents: 58, tokens: 18000 });

      // A user OpenAI knows but People doesn't: attributed to the vendor
      // identity, person unresolved (Resolve queue), never invented.
      expect(
        facts.find((f) => f.sourceRef === "usage:2026-06-09:user-eve:none:gpt-4o-2024-08-06:live"),
      ).toMatchObject({ identityExternalId: "user-eve", personEmail: null });

      // No user and no key = the visible Unassigned bucket.
      expect(
        facts.find((f) => f.sourceRef === "usage:2026-06-10:none:none:o4-mini-2025-04-16:live"),
      ).toMatchObject({ identityExternalId: null, personEmail: null });
    });

    it("keeps non-token cost line items as invoiced project spend and skips estimated token money", async () => {
      const facts = await factRows(ctx.pool, "openai");
      const invoiced = facts.filter((f) => f.costBasis === "invoiced");
      expect(invoiced.map((f) => [f.sourceRef, f.amountCents])).toEqual([
        ["cost:2026-06-09:proj_bots:Image models", 350],
        ["cost:2026-06-09:proj_eng:text-embedding-3-small, input", 1234],
        ["cost:2026-06-10:org:Web search", 125],
      ]);
      // Token line items for pinned models ("GPT-5, input", "GPT-4o mini,
      // cached input") never land - that money is already on the ledger as
      // per-user estimates; storing both would double count.
      expect(facts.filter((f) => f.sourceRef.includes("GPT-"))).toHaveLength(0);
    });

    it("incremental sync restates the trailing window in place and a key rename re-tags", async () => {
      const result = await runSync("openai", {
        pool: ctx.pool,
        fetch: fixture("incremental.json").fetch,
        now: TWO_DAYS_LATER,
        dataDir: ctx.dataDir,
      });
      expect(result.status).toBe("success");
      // watermark 2026-06-11, re-pull widens to today-7 = 2026-06-06
      expect(result.window).toEqual({ since: "2026-06-06", until: "2026-06-13" });

      const facts = await factRows(ctx.pool, "openai");
      expect(facts).toHaveLength(12); // 10 backfilled + 1 usage + 1 cost for the new day
      const restated = facts.find(
        (f) => f.sourceRef === "usage:2026-06-10:user-dana:key_dana:gpt-5-2025-08-07:live",
      );
      expect(restated).toMatchObject({ amountCents: 44, tokens: 230000 }); // vendor restated 34 -> 44
      const fresh = facts.find(
        (f) => f.sourceRef === "usage:2026-06-12:user-omar:key_omar:gpt-4o-mini-2024-07-18:live",
      );
      expect(fresh).toMatchObject({ amountCents: 2, personEmail: "omar@acme.com" });
      const freshCost = facts.find((f) => f.sourceRef === "cost:2026-06-12:proj_bots:Image models");
      expect(freshCost).toMatchObject({ amountCents: 99, costBasis: "invoiced" });

      // key renamed omar-laptop -> omar-mbp: identity re-tags, history follows
      const identities = await identityRows(ctx.pool, "openai");
      const omarKey = identities.find((i) => i.externalId === "key_omar");
      expect(omarKey).toMatchObject({
        displayName: "omar-mbp",
        tags: ["omar-mbp"],
        personEmail: "omar@acme.com",
      });
    });

    it("replaying the exact same sync changes nothing", async () => {
      const factsBefore = await factRows(ctx.pool, "openai");
      const result = await runSync("openai", {
        pool: ctx.pool,
        fetch: fixture("incremental.json").fetch,
        now: new Date("2026-06-13T10:00:00Z"),
        dataDir: ctx.dataDir,
      });
      expect(result.status).toBe("success");
      expect(await factRows(ctx.pool, "openai")).toEqual(factsBefore);
    });

    it("health counts facts and identities live from the tables; no metrics for this vendor", async () => {
      expect(await metricRows(ctx.pool, "openai")).toHaveLength(0);
      const health = await connectorHealth("openai", ctx.pool);
      expect(health).toMatchObject({
        vendor: "openai",
        displayName: "OpenAI",
        connected: true,
        historyLimitDays: 180,
        rowCounts: { spendFacts: 12, identities: 6, metrics: 0 },
      });
    });
  });

  describe("resume mid-backfill after a vendor failure", () => {
    const ctx = scratch("openai_resume", true);

    it("a 500 mid-usage stores the vendor error verbatim and keeps committed phases", async () => {
      await connectConnector("openai", CONFIG, {
        db: ctx.pool,
        fetch: fixture("connect-ok.json").fetch,
        dataDir: ctx.dataDir,
      });
      const result = await runSync("openai", {
        pool: ctx.pool,
        fetch: fixture("backfill-usage-page2-fails.json").fetch,
        now: NOW,
        dataDir: ctx.dataDir,
      });

      expect(result.status).toBe("error");
      expect(result.error).toBe(
        "The server had an error while processing your request. Sorry about that!",
      );
      // users + projects + api_keys + usage page 1 are committed; page 2 is not
      expect(await factRows(ctx.pool, "openai")).toHaveLength(4);

      const run = await lastRunRow(ctx.pool, "openai");
      const cursor = JSON.parse(run.cursor);
      expect(cursor.inProgress).toMatchObject({ since: "2025-12-13", until: "2026-06-11" });
      // the composite token points at the exact failed phase + page
      expect(JSON.parse(cursor.inProgress.pageToken)).toMatchObject({
        phase: "usage",
        cursor: "usage_p2",
      });
    });

    it("the next run resumes the failed usage page and finishes the window", async () => {
      const session = fixture("resume-from-usage-page2.json");
      const result = await runSync("openai", {
        pool: ctx.pool,
        fetch: session.fetch,
        now: NEXT_DAY,
        dataDir: ctx.dataDir,
      });

      expect(result.status).toBe("success");
      expect(result.window).toEqual({ since: "2025-12-13", until: "2026-06-11" });
      expect(session.remaining()).toHaveLength(0);

      // the finished ledger is byte-identical to the uninterrupted backfill
      const expected = JSON.parse(
        readFileSync(path.join(FIXTURES, "backfill-expected.json"), "utf8"),
      );
      expect(await factRows(ctx.pool, "openai")).toEqual(expected.facts);
      expect(await identityRows(ctx.pool, "openai")).toEqual(expected.identities);
      expect(JSON.parse((await lastRunRow(ctx.pool, "openai")).cursor)).toEqual({
        watermark: "2026-06-11",
      });
    });
  });

  describe("vendor drift fails the sync instead of writing bad numbers", () => {
    const ctx = scratch("openai_drift", false);

    it("an unpriced model fails the usage phase with the model named", async () => {
      await connectConnector("openai", CONFIG, {
        db: ctx.pool,
        fetch: fixture("connect-ok.json").fetch,
        dataDir: ctx.dataDir,
      });
      const result = await runSync("openai", {
        pool: ctx.pool,
        fetch: fixture("drift-unknown-model.json").fetch,
        now: NOW,
        dataDir: ctx.dataDir,
      });
      expect(result.status).toBe("error");
      expect(result.error).toBe(
        'no pinned price for OpenAI model "gpt-6-preview" - add it to the pinned price file (src/lib/connectors/model-prices.json)',
      );
      expect(await factRows(ctx.pool, "openai")).toHaveLength(0);
    });

    it("an unexpected field in a cost result fails the sync verbatim", async () => {
      const result = await runSync("openai", {
        pool: ctx.pool,
        fetch: fixture("drift-cost-format.json").fetch,
        now: NOW,
        dataDir: ctx.dataDir,
      });
      expect(result.status).toBe("error");
      expect(result.error).toBe('openai cost result: unexpected field "amount_usd"');
      const facts = await factRows(ctx.pool, "openai");
      expect(facts.filter((f) => f.sourceRef.startsWith("cost:"))).toHaveLength(0);
      // and the error sits on the run for the health surface
      expect((await lastRunRow(ctx.pool, "openai")).error).toMatch(/amount_usd/);
    });
  });
});
