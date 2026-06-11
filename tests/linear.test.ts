import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildContext, connectConnector, connectedRow } from "../src/lib/connectors/connect";
import { connectorHealth } from "../src/lib/connectors/health";
import { linearConnector } from "../src/lib/connectors/linear";
import { clearConnectors, registerConnector } from "../src/lib/connectors/registry";
import { runSync } from "../src/lib/connectors/sync";
import { clearSecretKeyCache } from "../src/lib/secrets";
import { runMigrations } from "../scripts/migrate.mjs";
import { factRows, identityRows, lastRunRow, outcomeRows } from "./helpers/ledger";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";
import { replayFile, type ReplaySession } from "./helpers/replay";

/**
 * Linear success integration (spec 7): outcomes only, never spend. Recorded
 * fixtures pin the GraphQL query + variables, the cursor paging, the
 * completed -> outcome and reopen -> revert flow, and the strict-parse
 * drift guard.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");
const FIXTURES = path.resolve(__dirname, "fixtures", "connectors", "linear");

/** Pinned clock: fixtures are recorded against this "today" (2026-06-11). */
const NOW = new Date("2026-06-11T12:00:00Z");
/** Incremental fixture is recorded against today = 2026-06-13. */
const TWO_DAYS_LATER = new Date("2026-06-13T09:00:00Z");

const CONFIG = { apiKey: "lin_api_test" };

function fixture(name: string): ReplaySession {
  return replayFile(path.join(FIXTURES, name));
}

describe.runIf(TEST_DATABASE_URL)("linear connector", () => {
  let dbUrl: string;
  let pool: Pool;
  let dataDir: string;

  beforeAll(async () => {
    clearConnectors();
    registerConnector(linearConnector);
    dbUrl = await createScratchDb("linear_test");
    await runMigrations({ databaseUrl: dbUrl, dir: MIGRATIONS_DIR });
    pool = new Pool({ connectionString: dbUrl, max: 5 });
    dataDir = mkdtempSync(path.join(os.tmpdir(), "ai-pnl-linear-"));
    await pool.query(
      `INSERT INTO people (email, name, source) VALUES
         ('dana@acme.com', 'Dana', 'manual'),
         ('omar@acme.com', 'Omar', 'manual')`,
    );
  });

  afterAll(async () => {
    clearConnectors();
    await pool?.end();
    if (dbUrl) await dropScratchDb(dbUrl);
    clearSecretKeyCache();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("rejects a bad key with the vendor's error verbatim and stores nothing", async () => {
    await expect(
      connectConnector("linear", CONFIG, {
        db: pool,
        fetch: fixture("connect-unauthorized.json").fetch,
        dataDir,
      }),
    ).rejects.toThrow("Authentication required, not authenticated");
    expect(await connectedRow("linear", pool)).toBeNull();
  });

  it("connects; the card says success-only and the connect screen states the rules", async () => {
    const row = await connectConnector("linear", CONFIG, {
      db: pool,
      fetch: fixture("connect-ok.json").fetch,
      dataDir,
    });
    expect(row.history_limit_days).toBe(365);
    expect(row.scopes).toEqual(["read"]);

    const health = await connectorHealth("linear", pool);
    expect(health!.successOnly).toBe(true);
    expect(health!.connectNotes.join(" ")).toMatch(/Success-only: counts issues, writes no spend/);
    expect(health!.connectNotes.join(" ")).toMatch(/agents land as their own identity/);
  });

  it("backfill: completed issues land as outcomes, attributed to their creators - no spend", async () => {
    const session = fixture("backfill.json");
    const result = await runSync("linear", { pool, fetch: session.fetch, now: NOW, dataDir });
    expect(result.status).toBe("success");
    expect(result.window).toEqual({ since: "2025-06-11", until: "2026-06-11" });
    expect(result.rowsSynced).toBe(3);
    expect(session.remaining()).toHaveLength(0);

    // Outcomes only - the spend ledger never sees a success integration.
    expect(await factRows(pool, "linear")).toEqual([]);

    expect(await outcomeRows(pool)).toMatchObject([
      { sourceRef: "ENG-1", kind: "linear_issue", ts: "2026-06-09T10:15:00Z",
        product: "Linear issues", personEmail: "dana@acme.com", reverted: false },
      // Agent-created (no creator): a success with no person (spec 7).
      { sourceRef: "ENG-3", kind: "linear_issue", ts: "2026-06-08T20:00:00Z",
        product: "Linear issues", personEmail: null, reverted: false },
      { sourceRef: "ENG-4", kind: "linear_issue", ts: "2026-06-10T18:30:00Z",
        product: "Linear issues", personEmail: "dana@acme.com", reverted: false },
    ]);

    expect(await identityRows(pool, "linear")).toMatchObject([
      { externalId: "u_dana", kind: "user", email: "dana@acme.com", personEmail: "dana@acme.com" },
      { externalId: "u_omar", kind: "user", email: "omar@acme.com", personEmail: "omar@acme.com" },
    ]);

    const health = await connectorHealth("linear", pool, NOW);
    expect(health!.rowCounts).toMatchObject({ spendFacts: 0, outcomes: 3, identities: 2 });
  });

  it("incremental: a reopen inside the window flips the counted success", async () => {
    const session = fixture("incremental-reopen.json");
    const result = await runSync("linear", {
      pool,
      fetch: session.fetch,
      now: TWO_DAYS_LATER,
      dataDir,
    });
    expect(result.status).toBe("success");
    expect(result.window).toEqual({ since: "2026-06-06", until: "2026-06-13" });
    expect(result.rowsSynced).toBe(2); // ENG-5 outcome + the ENG-1 flip
    expect(session.remaining()).toHaveLength(0);

    const outcomes = await outcomeRows(pool);
    expect(outcomes.find((o) => o.sourceRef === "ENG-1")).toMatchObject({
      reverted: true,
      revertSourceRef: "ENG-1@reopen",
    });
    expect(outcomes.find((o) => o.sourceRef === "ENG-5")).toMatchObject({
      personEmail: "omar@acme.com",
      product: "Linear issues",
      reverted: false,
    });
  });

  it("re-pulls restate in place: nothing duplicates, the flip survives", async () => {
    const before = await outcomeRows(pool);
    const session = fixture("incremental-reopen.json"); // same window re-served
    const result = await runSync("linear", {
      pool,
      fetch: session.fetch,
      now: TWO_DAYS_LATER,
      dataDir,
    });
    expect(result.status).toBe("success");
    expect(await outcomeRows(pool)).toEqual(before);
    const run = await lastRunRow(pool, "linear");
    expect(JSON.parse(run.cursor as string).watermark).toBe("2026-06-13");
  });

  it("vendor format drift throws with the field named, never bad numbers", async () => {
    const ctx = buildContext(linearConnector, CONFIG, fixture("drift-issue-format.json").fetch);
    await expect(
      linearConnector.fetchPage(ctx, { since: "2025-06-11", until: "2026-06-11" }, null),
    ).rejects.toThrow('linear issue: unexpected field "priority"');
  });
});
