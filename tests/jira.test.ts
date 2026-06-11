import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildContext, connectConnector, connectedRow } from "../src/lib/connectors/connect";
import { connectorHealth } from "../src/lib/connectors/health";
import { jiraConnector } from "../src/lib/connectors/jira";
import { clearConnectors, registerConnector } from "../src/lib/connectors/registry";
import { runSync } from "../src/lib/connectors/sync";
import { clearSecretKeyCache } from "../src/lib/secrets";
import { runMigrations } from "../scripts/migrate.mjs";
import { factRows, identityRows, lastRunRow, outcomeRows } from "./helpers/ledger";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";
import { replayFile, type ReplaySession } from "./helpers/replay";

/**
 * Jira success integration (spec 7): outcomes only, never spend. Recorded
 * fixtures pin the search JQL, the vendor paging, the Done -> outcome and
 * reopen -> revert flow, and the strict-parse drift guard.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");
const FIXTURES = path.resolve(__dirname, "fixtures", "connectors", "jira");

/** Pinned clock: fixtures are recorded against this "today" (2026-06-11). */
const NOW = new Date("2026-06-11T12:00:00Z");
/** Incremental fixture is recorded against today = 2026-06-13. */
const TWO_DAYS_LATER = new Date("2026-06-13T09:00:00Z");

const CONFIG = {
  siteUrl: "https://acme.atlassian.net",
  email: "ops@acme.com",
  apiToken: "jira_token_test",
};

function fixture(name: string): ReplaySession {
  return replayFile(path.join(FIXTURES, name));
}

describe.runIf(TEST_DATABASE_URL)("jira connector", () => {
  let dbUrl: string;
  let pool: Pool;
  let dataDir: string;

  beforeAll(async () => {
    clearConnectors();
    registerConnector(jiraConnector);
    dbUrl = await createScratchDb("jira_test");
    await runMigrations({ databaseUrl: dbUrl, dir: MIGRATIONS_DIR });
    pool = new Pool({ connectionString: dbUrl, max: 5 });
    dataDir = mkdtempSync(path.join(os.tmpdir(), "ai-pnl-jira-"));
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

  it("rejects a non-https site before talking to the vendor", async () => {
    await expect(
      connectConnector("jira", { ...CONFIG, siteUrl: "http://acme.atlassian.net" }, {
        db: pool,
        fetch: fixture("connect-ok.json").fetch, // untouched
        dataDir,
      }),
    ).rejects.toThrow("site URL must start with https://");
  });

  it("rejects a bad token with the vendor's error verbatim and stores nothing", async () => {
    await expect(
      connectConnector("jira", CONFIG, {
        db: pool,
        fetch: fixture("connect-unauthorized.json").fetch,
        dataDir,
      }),
    ).rejects.toThrow("Client must be authenticated to access this resource.");
    expect(await connectedRow("jira", pool)).toBeNull();
  });

  it("connects; the card says success-only and the connect screen states the rules", async () => {
    const row = await connectConnector("jira", CONFIG, {
      db: pool,
      fetch: fixture("connect-ok.json").fetch,
      dataDir,
    });
    expect(row.history_limit_days).toBe(365);
    expect(row.scopes).toEqual(["read"]);

    const health = await connectorHealth("jira", pool);
    expect(health!.successOnly).toBe(true);
    expect(health!.connectNotes.join(" ")).toMatch(/Success-only: counts issues, writes no spend/);
    expect(health!.connectNotes.join(" ")).toMatch(/issue's creator/);
    expect(health!.configFields.map((f) => f.key)).toEqual(["siteUrl", "email", "apiToken"]);
  });

  it("backfill: Done issues land as outcomes, attributed to their creators - no spend", async () => {
    const session = fixture("backfill.json");
    const result = await runSync("jira", { pool, fetch: session.fetch, now: NOW, dataDir });
    expect(result.status).toBe("success");
    expect(result.window).toEqual({ since: "2025-06-11", until: "2026-06-11" });
    expect(result.rowsSynced).toBe(3);
    expect(session.remaining()).toHaveLength(0);

    // Outcomes only - the spend ledger never sees a success integration.
    expect(await factRows(pool, "jira")).toEqual([]);

    expect(await outcomeRows(pool)).toMatchObject([
      { sourceRef: "SUP-1", kind: "jira_issue", ts: "2026-06-09T10:15:00Z",
        product: "Jira issues", personEmail: "dana@acme.com", reverted: false },
      // The app-created issue: an agent's success, no person (spec 7).
      { sourceRef: "SUP-3", kind: "jira_issue", ts: "2026-06-08T20:00:00Z",
        product: "Jira issues", personEmail: null, reverted: false },
      { sourceRef: "SUP-4", kind: "jira_issue", ts: "2026-06-10T18:30:00Z",
        product: "Jira issues", personEmail: "dana@acme.com", reverted: false },
    ]);

    // Creators are identities: humans auto-match by email, the app does not.
    expect(await identityRows(pool, "jira")).toMatchObject([
      { externalId: "5b10dana", kind: "user", email: "dana@acme.com", personEmail: "dana@acme.com" },
      { externalId: "5b10omar", kind: "user", email: "omar@acme.com", personEmail: "omar@acme.com" },
      { externalId: "appbot-1", kind: "user", email: null, displayName: "Deploy Agent", personEmail: null },
    ]);

    const health = await connectorHealth("jira", pool, NOW);
    expect(health!.rowCounts).toMatchObject({ spendFacts: 0, outcomes: 3, identities: 3 });
  });

  it("incremental: a reopen inside the window flips the counted success", async () => {
    const session = fixture("incremental-reopen.json");
    const result = await runSync("jira", {
      pool,
      fetch: session.fetch,
      now: TWO_DAYS_LATER,
      dataDir,
    });
    expect(result.status).toBe("success");
    // Watermark widened by the 7-day re-pull (spec 4).
    expect(result.window).toEqual({ since: "2026-06-06", until: "2026-06-13" });
    expect(result.rowsSynced).toBe(2); // SUP-5 outcome + the SUP-1 flip
    expect(session.remaining()).toHaveLength(0);

    const outcomes = await outcomeRows(pool);
    const sup1 = outcomes.find((o) => o.sourceRef === "SUP-1");
    expect(sup1).toMatchObject({ reverted: true, revertSourceRef: "SUP-1@reopen" });
    const sup5 = outcomes.find((o) => o.sourceRef === "SUP-5");
    expect(sup5).toMatchObject({
      personEmail: "omar@acme.com",
      product: "Jira issues",
      reverted: false,
    });
  });

  it("re-pulls restate in place: nothing duplicates, the flip survives", async () => {
    const before = await outcomeRows(pool);
    const session = fixture("incremental-reopen.json"); // same window re-served
    const result = await runSync("jira", {
      pool,
      fetch: session.fetch,
      now: TWO_DAYS_LATER,
      dataDir,
    });
    expect(result.status).toBe("success");
    expect(await outcomeRows(pool)).toEqual(before);
    const run = await lastRunRow(pool, "jira");
    expect(JSON.parse(run.cursor as string).watermark).toBe("2026-06-13");
  });

  it("vendor format drift throws with the field named, never bad numbers", async () => {
    const ctx = buildContext(jiraConnector, CONFIG, fixture("drift-issue-format.json").fetch);
    await expect(
      jiraConnector.fetchPage(ctx, { since: "2025-06-11", until: "2026-06-11" }, null),
    ).rejects.toThrow('jira issue SUP-9 fields: missing or invalid "statuscategorychangedate"');
  });
});
