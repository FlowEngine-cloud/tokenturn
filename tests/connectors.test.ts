import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectConnector, connectedRow } from "../src/lib/connectors/connect";
import { connectorHealth } from "../src/lib/connectors/health";
import { clearConnectors, registerConnector } from "../src/lib/connectors/registry";
import { runSync } from "../src/lib/connectors/sync";
import { clearSecretKeyCache } from "../src/lib/secrets";
import { runMigrations } from "../scripts/migrate.mjs";
import { makeAcmeConnector } from "./helpers/fixture-connector";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";
import { replay, replayFile, type ReplaySession } from "./helpers/replay";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");
const FIXTURES = path.resolve(__dirname, "fixtures", "connectors", "acme");

/** Pinned clock: fixtures are recorded against this "today" (2026-06-10). */
const NOW = new Date("2026-06-10T12:00:00Z");
const LATER_SAME_DAY = new Date("2026-06-10T13:00:00Z");
const NEXT_DAY = new Date("2026-06-11T09:00:00Z");

const GOOD_CONFIG = { apiKey: "acme_sk_test_123" };

function fixture(name: string): ReplaySession {
  return replayFile(path.join(FIXTURES, name));
}

describe.runIf(TEST_DATABASE_URL)("connector framework", () => {
  let dbUrl: string;
  let pool: Pool;
  let dataDir: string;

  beforeAll(async () => {
    dbUrl = await createScratchDb("connectors_test");
    await runMigrations({ databaseUrl: dbUrl, dir: MIGRATIONS_DIR });
    pool = new Pool({ connectionString: dbUrl, max: 5 });
    dataDir = mkdtempSync(path.join(os.tmpdir(), "ai-pnl-connectors-"));
    clearConnectors();
    for (const vendor of ["acme", "acme_resume", "acme_crash", "acme_drift"]) {
      registerConnector(makeAcmeConnector(vendor));
    }
    // dana exists before the first sync - her vendor identity must auto-map.
    await pool.query(
      "INSERT INTO people (email, name, source) VALUES ('dana@acme.com', 'Dana', 'manual')",
    );
  });

  afterAll(async () => {
    await pool?.end();
    if (dbUrl) await dropScratchDb(dbUrl);
    clearConnectors();
    clearSecretKeyCache();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  async function connect(vendor: string, recording = "connect-ok.json") {
    return connectConnector(vendor, GOOD_CONFIG, {
      db: pool,
      fetch: fixture(recording).fetch,
      dataDir,
    });
  }

  async function factRows(vendor: string) {
    const { rows } = await pool.query(
      `SELECT f.source_ref AS "sourceRef", f.day::text AS day, f.model,
              f.tokens::int AS tokens, f.amount_cents::int AS "amountCents",
              f.currency, f.cost_basis AS "costBasis",
              i.external_id AS "identityExternalId", p.email AS "personEmail"
       FROM spend_facts f
       LEFT JOIN identities i ON i.id = f.identity_id
       LEFT JOIN people p ON p.id = f.person_id
       WHERE f.vendor = $1 ORDER BY f.source_ref`,
      [vendor],
    );
    return rows;
  }

  async function identityRows(vendor: string) {
    const { rows } = await pool.query(
      `SELECT i.external_id AS "externalId", i.kind, i.email,
              i.display_name AS "displayName", i.tags, p.email AS "personEmail"
       FROM identities i LEFT JOIN people p ON p.id = i.person_id
       WHERE i.vendor = $1 ORDER BY i.external_id`,
      [vendor],
    );
    return rows;
  }

  async function lastRunRow(vendor: string) {
    const { rows } = await pool.query(
      `SELECT id, status, cursor, error, rows_synced FROM sync_runs
       WHERE connector = $1 ORDER BY started_at DESC, id DESC LIMIT 1`,
      [vendor],
    );
    return rows[0];
  }

  describe("token scope validation on connect", () => {
    it("rejects a bad token with the vendor's error verbatim and stores nothing", async () => {
      await expect(connect("acme", "connect-unauthorized.json")).rejects.toThrow(
        "Invalid API key provided: acme_sk_****7f2 (request id: req_991)",
      );
      await expect(connect("acme", "connect-missing-scope.json")).rejects.toThrow(
        /missing the usage:read scope/,
      );
      expect(await connectedRow("acme", pool)).toBeNull();
      const { rows } = await pool.query(
        "SELECT 1 FROM settings WHERE key = 'connector:acme:config'",
      );
      expect(rows).toHaveLength(0);
    });

    it("connects when scopes validate; the token is stored encrypted only", async () => {
      const row = await connect("acme");
      expect(row.history_limit_days).toBe(31);
      expect(row.scopes).toEqual(["usage:read", "members:read"]);

      const { rows } = await pool.query(
        "SELECT value, secret FROM settings WHERE key = 'connector:acme:config'",
      );
      expect(rows[0].secret).toBe(true);
      expect(rows[0].value.startsWith("v1:")).toBe(true);
      expect(JSON.stringify(rows[0].value)).not.toContain(GOOD_CONFIG.apiKey);
    });
  });

  describe("first sync: full backfill to the vendor's history limit", () => {
    it("pages through the whole 31-day window and lands exactly the recorded ledger", async () => {
      const session = fixture("backfill.json");
      const result = await runSync("acme", {
        pool,
        fetch: session.fetch,
        now: NOW,
        dataDir,
      });

      expect(result.status).toBe("success");
      // 31 days back from the pinned today - the recorded URLs enforce it too.
      expect(result.window).toEqual({ since: "2026-05-10", until: "2026-06-10" });
      expect(result.rowsSynced).toBe(5);
      expect(session.remaining()).toHaveLength(0); // every page was fetched

      const expected = JSON.parse(
        readFileSync(path.join(FIXTURES, "backfill-expected.json"), "utf8"),
      );
      expect(await factRows("acme")).toEqual(expected.facts);
      expect(await identityRows("acme")).toEqual(expected.identities);

      const run = await lastRunRow("acme");
      expect(run.status).toBe("success");
      expect(JSON.parse(run.cursor)).toEqual({ watermark: "2026-06-10" });
    });
  });

  describe("incremental sync: trailing 7-day re-pull, idempotent upserts", () => {
    it("re-pulls the trailing 7 days and restates rows in place - never duplicates", async () => {
      // The recording only answers since=2026-06-03 (today minus 7): if the
      // framework asked for any other window, replay would throw.
      const result = await runSync("acme", {
        pool,
        fetch: fixture("incremental.json").fetch,
        now: LATER_SAME_DAY,
        dataDir,
      });
      expect(result.status).toBe("success");
      expect(result.window).toEqual({ since: "2026-06-03", until: "2026-06-10" });

      const facts = await factRows("acme");
      expect(facts).toHaveLength(6); // 5 backfilled + 1 new; u_1004 restated, not duplicated
      const restated = facts.find((f) => f.sourceRef === "u_1004");
      expect(restated.amountCents).toBe(460); // vendor restated 410 -> 460
      const fresh = facts.find((f) => f.sourceRef === "u_1006");
      expect(fresh.personEmail).toBe("dana@acme.com");
    });

    it("replaying the exact same sync changes nothing", async () => {
      const before = await factRows("acme");
      const result = await runSync("acme", {
        pool,
        fetch: fixture("incremental.json").fetch,
        now: LATER_SAME_DAY,
        dataDir,
      });
      expect(result.status).toBe("success");
      expect(await factRows("acme")).toEqual(before);
    });
  });

  describe("resume mid-sync after a failure", () => {
    it("a vendor error stores the message verbatim and keeps the committed pages", async () => {
      await connect("acme_resume");
      const result = await runSync("acme_resume", {
        pool,
        fetch: fixture("backfill-page2-fails.json").fetch,
        now: NOW,
        dataDir,
      });

      expect(result.status).toBe("error");
      expect(result.error).toBe(
        "acme internal error 8861: usage shard temporarily unavailable",
      );
      expect(await factRows("acme_resume")).toHaveLength(2); // page 1 committed

      const run = await lastRunRow("acme_resume");
      expect(run.status).toBe("error");
      expect(run.error).toBe(
        "acme internal error 8861: usage shard temporarily unavailable",
      );
      expect(JSON.parse(run.cursor)).toEqual({
        watermark: null,
        inProgress: { since: "2026-05-10", until: "2026-06-10", pageToken: "p2" },
      });
    });

    it("the next run resumes the same window at the failed page - even a day later", async () => {
      // Recording only answers page=p2/p3 of the ORIGINAL window: if the
      // framework recomputed the window for the new day, replay would throw.
      const session = fixture("resume-from-page2.json");
      const result = await runSync("acme_resume", {
        pool,
        fetch: session.fetch,
        now: NEXT_DAY,
        dataDir,
      });

      expect(result.status).toBe("success");
      expect(result.window).toEqual({ since: "2026-05-10", until: "2026-06-10" });
      expect(result.rowsSynced).toBe(3);
      expect(session.remaining()).toHaveLength(0);
      expect(await factRows("acme_resume")).toHaveLength(5); // all pages, no dupes
      expect(JSON.parse((await lastRunRow("acme_resume")).cursor)).toEqual({
        watermark: "2026-06-10",
      });
    });

    it("after the resume, syncing continues incrementally from the watermark", async () => {
      const result = await runSync("acme_resume", {
        pool,
        fetch: replay([
          {
            request: {
              method: "GET",
              url: "https://api.acme.test/v1/usage?since=2026-06-04&until=2026-06-11",
            },
            response: { status: 200, body: { records: [], next_page: null } },
          },
        ]).fetch,
        now: NEXT_DAY,
        dataDir,
      });
      expect(result.status).toBe("success");
      expect(result.window).toEqual({ since: "2026-06-04", until: "2026-06-11" });
    });

    it("a run the process died inside (still 'running') is failed and resumed", async () => {
      await connect("acme_crash");
      await pool.query(
        `INSERT INTO sync_runs (connector, status, cursor, rows_synced)
         VALUES ('acme_crash', 'running', $1, 2)`,
        [
          JSON.stringify({
            watermark: null,
            inProgress: { since: "2026-05-10", until: "2026-06-10", pageToken: "p2" },
          }),
        ],
      );

      const result = await runSync("acme_crash", {
        pool,
        fetch: fixture("resume-from-page2.json").fetch,
        now: NOW,
        dataDir,
      });
      expect(result.status).toBe("success");
      expect(result.rowsSynced).toBe(3);

      const { rows } = await pool.query(
        `SELECT status, error FROM sync_runs
         WHERE connector = 'acme_crash' ORDER BY id`,
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({ status: "error", error: "sync process died mid-run" });
      expect(rows[1].status).toBe("success");
    });
  });

  describe("recorded fixtures turn vendor format changes into failures", () => {
    it("a renamed field fails the sync instead of writing bad numbers", async () => {
      await connect("acme_drift");
      const result = await runSync("acme_drift", {
        pool,
        fetch: fixture("format-drift.json").fetch,
        now: NOW,
        dataDir,
      });
      expect(result.status).toBe("error");
      expect(result.error).toMatch(/u_2001: unexpected field "amount_usd"/);
      expect(await factRows("acme_drift")).toHaveLength(0);

      // and the error sits on the run, verbatim, for the health surface
      expect((await lastRunRow("acme_drift")).error).toMatch(/amount_usd/);
    });

    it("a request nothing was recorded for fails loudly", async () => {
      // The failed drift run is resumed - but this recording is empty, so
      // the very first (resumed) request has no recorded answer.
      const result = await runSync("acme_drift", {
        pool,
        fetch: replay([]).fetch,
        now: NEXT_DAY,
        dataDir,
      });
      expect(result.status).toBe("error");
      expect(result.error).toMatch(/no recorded response for GET/);
    });
  });

  describe("health surface", () => {
    it("reports last sync, row counts, and the vendor error verbatim", async () => {
      const healthy = await connectorHealth("acme", pool, new Date());
      expect(healthy).toMatchObject({
        vendor: "acme",
        connected: true,
        historyLimitDays: 31,
        scopes: ["usage:read", "members:read"],
        rowCounts: { spendFacts: 6, identities: 4, metrics: 0 },
        silent: false,
      });
      expect(healthy!.lastRun!.status).toBe("success");
      expect(healthy!.lastSuccessAt).not.toBeNull();

      const broken = await connectorHealth("acme_drift", pool, new Date());
      expect(broken!.lastRun!.status).toBe("error");
      expect(broken!.lastRun!.error).toMatch(/no recorded response for GET/);
      expect(broken!.rowCounts).toEqual({ spendFacts: 0, identities: 0, metrics: 0 });
    });

    it("an errored run exposes its in-flight window (backfill progress)", async () => {
      const health = await connectorHealth("acme_drift", pool, new Date());
      expect(health!.inProgress).toEqual({ since: "2026-05-10", until: "2026-06-10" });
    });

    it("unknown vendors have no health", async () => {
      expect(await connectorHealth("nope", pool)).toBeNull();
    });
  });
});
