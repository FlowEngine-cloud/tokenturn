import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildContext, connectConnector, connectedRow } from "../src/lib/connectors/connect";
import { connectorHealth } from "../src/lib/connectors/health";
import {
  listTrackedIssues,
  setIssueProjectRoute,
} from "../src/lib/connectors/issues";
import { linearConnector } from "../src/lib/connectors/linear";
import { clearConnectors, registerConnector } from "../src/lib/connectors/registry";
import { runSync } from "../src/lib/connectors/sync";
import { createProduct } from "../src/lib/products";
import { clearSecretKeyCache } from "../src/lib/secrets";
import { runMigrations } from "../scripts/migrate.mjs";
import { factRows, identityRows, lastRunRow, outcomeRows, trackedIssueRows } from "./helpers/ledger";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";
import { replayFile, type ReplaySession } from "./helpers/replay";

/**
 * Linear success integration (spec 7): outcomes only, never spend. Recorded
 * fixtures pin the GraphQL query + variables, the cursor paging, the
 * history-driven state machine with a per-connection 10-day window, agent
 * actors (first-class, no email) as creator/assignee, the team -> ROI
 * mapping chosen at connect, the quiet-window promotion, the reopen flip,
 * and the strict-parse drift guard.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");
const FIXTURES = path.resolve(__dirname, "fixtures", "connectors", "linear");

/** Pinned clock: fixtures are recorded against this "today" (2026-06-11). */
const NOW = new Date("2026-06-11T12:00:00Z");
/** Incremental fixture is recorded against today = 2026-06-13. */
const TWO_DAYS_LATER = new Date("2026-06-13T09:00:00Z");
/** Past ENG-2's 10-day window end (2026-06-18T08:00Z) - the promotion run. */
const SIX_DAYS_LATER = new Date("2026-06-19T12:00:00Z");

/** The window is per connection (spec 7): this one waits 10 days, not 30. */
const CONFIG = { apiKey: "lin_api_test", windowDays: "10" };

const ISSUE = (key: string) => `https://linear.app/acme/issue/${key.toLowerCase()}`;

function fixture(name: string): ReplaySession {
  return replayFile(path.join(FIXTURES, name));
}

describe.runIf(TEST_DATABASE_URL)("linear connector", () => {
  let dbUrl: string;
  let pool: Pool;
  let dataDir: string;
  let platformId: string;

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

  it("connects; success-only, with the state machine configurable per connection", async () => {
    const row = await connectConnector("linear", CONFIG, {
      db: pool,
      fetch: fixture("connect-ok.json").fetch,
      dataDir,
    });
    expect(row.history_limit_days).toBe(365);

    const health = await connectorHealth("linear", pool);
    expect(health!.successOnly).toBe(true);
    expect(health!.connectNotes.join(" ")).toMatch(/Success-only: counts issues, writes no spend/);
    expect(health!.configFields.map((f) => f.key)).toEqual([
      "apiKey", "submittedStatus", "failStatus", "windowDays",
    ]);
  });

  it("lists teams for the team -> ROI mapping", async () => {
    const ctx = buildContext(linearConnector, CONFIG, fixture("teams.json").fetch);
    expect(await linearConnector.listProjects!(ctx)).toEqual([
      { key: "ENG", name: "Engineering" },
      { key: "OPS", name: "Operations" },
    ]);
  });

  it("backfill: the team mapping routes ENG to its ROI; unmapped teams take the default", async () => {
    // The mapping screen at connect (spec 7 routing layer 2): ENG -> the
    // "Platform ROI" row, before any issue has synced.
    const platform = await createProduct(
      { name: "Platform ROI", attribution: "key" },
      pool,
    );
    platformId = platform.id;
    const client = await pool.connect();
    try {
      await setIssueProjectRoute(client, "linear", "ENG", platformId);
    } finally {
      client.release();
    }

    const session = fixture("backfill.json");
    const result = await runSync("linear", { pool, fetch: session.fetch, now: NOW, dataDir });
    expect(result.status).toBe("success");
    expect(result.window).toEqual({ since: "2025-06-11", until: "2026-06-11" });
    // ENG-1 (2) + ENG-2 pending (1) + ENG-3 fail (1) + OPS-4 (2).
    expect(result.rowsSynced).toBe(6);
    expect(session.remaining()).toHaveLength(0);

    // Outcomes only - never spend.
    expect(await factRows(pool, "linear")).toEqual([]);

    // ENG-1 completed inside its 10-day window -> success on the Done ts,
    // routed to the mapped ROI; OPS-4's window passed quietly back in April
    // -> success at window end (2026-04-02 + 10d) on the auto-created
    // default row.
    expect(await outcomeRows(pool)).toMatchObject([
      { sourceRef: ISSUE("ENG-1"), kind: "issue_done", ts: "2026-06-09T10:15:00Z",
        product: "Platform ROI", personEmail: "dana@acme.com", reverted: false },
      { sourceRef: ISSUE("OPS-4"), kind: "issue_done", ts: "2026-04-12T09:00:00Z",
        product: "Issues done", personEmail: "dana@acme.com", reverted: false },
    ]);

    // ENG-3 was canceled inside the window -> fail, credited to the agent
    // ASSIGNEE (Devin - a first-class actor with no email).
    expect(await trackedIssueRows(pool, "linear")).toMatchObject([
      { key: "ENG-1", project: "ENG", status: "success", product: "Platform ROI" },
      { key: "ENG-2", project: "ENG", status: "pending", decidedAt: null,
        anchorTs: "2026-06-08T08:00:00Z", identityExternalId: "agent-devin",
        product: "Platform ROI" },
      { key: "ENG-3", project: "ENG", status: "fail", decidedAt: "2026-05-25T09:00:00Z",
        identityExternalId: "agent-devin", personEmail: null },
      { key: "OPS-4", project: "OPS", status: "success",
        decidedAt: "2026-04-12T09:00:00Z", product: "Issues done" },
    ]);

    // The agent's name became its tag (spec 7); humans matched by email.
    expect(await identityRows(pool, "linear")).toMatchObject([
      { externalId: "agent-devin", email: null, displayName: "Devin", tags: ["devin"] },
      { externalId: "usr-dana", email: "dana@acme.com", personEmail: "dana@acme.com" },
      { externalId: "usr-omar", email: "omar@acme.com", personEmail: "omar@acme.com" },
    ]);

    const health = await connectorHealth("linear", pool, NOW);
    expect(health!.rowCounts).toMatchObject({ spendFacts: 0, outcomes: 2, identities: 3 });
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
    // ENG-1 fail + flip (2), ENG-2 still pending (1), ENG-5 success (2).
    expect(result.rowsSynced).toBe(5);
    expect(session.remaining()).toHaveLength(0);

    const outcomes = await outcomeRows(pool);
    // Reopened 2026-06-12T08:00Z - one hour inside the 10-day window.
    expect(outcomes.find((o) => o.sourceRef === ISSUE("ENG-1"))).toMatchObject({
      reverted: true,
      revertSourceRef: `${ISSUE("ENG-1")}#regressed`,
    });
    expect(outcomes.find((o) => o.sourceRef === ISSUE("ENG-5"))).toMatchObject({
      ts: "2026-06-13T08:00:00Z",
      personEmail: "omar@acme.com",
      product: "Platform ROI",
      reverted: false,
    });
  });

  it("re-pulls restate in place: nothing duplicates, the flip survives", async () => {
    const before = await outcomeRows(pool);
    const session = fixture("incremental-reopen.json");
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

  it("the 10-day window promotes the pending issue once it passes quietly", async () => {
    const session = fixture("promote-quiet-window.json");
    const result = await runSync("linear", {
      pool,
      fetch: session.fetch,
      now: SIX_DAYS_LATER,
      dataDir,
    });
    expect(result.status).toBe("success");
    // ENG-1 + ENG-5 restated (3) + the ENG-2 promotion (1).
    expect(result.rowsSynced).toBe(4);
    expect(session.remaining()).toHaveLength(0);

    expect(await outcomeRows(pool)).toMatchObject(
      expect.arrayContaining([
        expect.objectContaining({
          sourceRef: ISSUE("ENG-2"),
          ts: "2026-06-18T08:00:00Z",
          product: "Platform ROI",
          personEmail: null,
          reverted: false,
        }),
      ]),
    );

    // The ROI's ticket drill: every tracked issue routed to the row, newest
    // decision first, pending rows always visible.
    const drill = await listTrackedIssues(platformId, {}, pool);
    expect(
      drill.map((r) => ({ key: r.key, status: r.status, who: r.personName ?? r.identityName })),
    ).toEqual([
      { key: "ENG-2", status: "success", who: "Devin" },
      { key: "ENG-5", status: "success", who: "Omar" },
      { key: "ENG-1", status: "fail", who: "Dana" },
      { key: "ENG-3", status: "fail", who: "Devin" },
    ]);
    // The decided-day range filter matches the day the outcome counts on.
    const june13 = await listTrackedIssues(
      platformId,
      { from: "2026-06-13", to: "2026-06-13" },
      pool,
    );
    expect(june13.map((r) => r.key)).toEqual(["ENG-5"]);
  });

  it("clearing the team mapping re-routes the team's history to the default row", async () => {
    const client = await pool.connect();
    let moved: { outcomes: number; from: string | null; to: string | null };
    try {
      moved = await setIssueProjectRoute(client, "linear", "ENG", null);
    } finally {
      client.release();
    }
    // ENG-1 (reverted, still moves), ENG-2 and ENG-5 - ENG-3 never counted.
    expect(moved.outcomes).toBe(3);
    const outcomes = await outcomeRows(pool);
    for (const key of ["ENG-1", "ENG-2", "ENG-5"]) {
      expect(outcomes.find((o) => o.sourceRef === ISSUE(key))).toMatchObject({
        product: "Issues done",
      });
    }
    expect(await listTrackedIssues(platformId, {}, pool)).toEqual([]);
  });

  it("vendor format drift throws with the field named, never bad numbers", async () => {
    const ctx = buildContext(linearConnector, CONFIG, fixture("drift-issue-format.json").fetch);
    await expect(
      linearConnector.fetchPage(ctx, { since: "2025-06-11", until: "2026-06-11" }, null),
    ).rejects.toThrow('linear issue ENG-9 toState: unknown workflow state type "paused"');
  });
});
