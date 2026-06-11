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
import { createProduct } from "../src/lib/products";
import { clearSecretKeyCache } from "../src/lib/secrets";
import { updateTag } from "../src/lib/tags";
import { runMigrations } from "../scripts/migrate.mjs";
import { factRows, identityRows, lastRunRow, outcomeRows, trackedIssueRows } from "./helpers/ledger";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";
import { replayFile, type ReplaySession } from "./helpers/replay";

/**
 * Jira success integration (spec 7): outcomes only, never spend. Recorded
 * fixtures pin the changelog-driven state machine end to end: search JQL +
 * vendor paging, submitted -> pending, Done-sooner success, regression fail,
 * the quiet-window promotion, the reopen flip, agent attribution via
 * creator/assignee app actors, name-tag -> ROI routing, and the strict-parse
 * drift guard.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");
const FIXTURES = path.resolve(__dirname, "fixtures", "connectors", "jira");

/** Pinned clock: fixtures are recorded against this "today" (2026-06-11). */
const NOW = new Date("2026-06-11T12:00:00Z");
/** Incremental fixture is recorded against today = 2026-06-13. */
const TWO_DAYS_LATER = new Date("2026-06-13T09:00:00Z");
/** Past SUP-2's window end (2026-07-08T08:00Z) - the promotion run. */
const A_MONTH_LATER = new Date("2026-07-09T12:00:00Z");

const CONFIG = {
  siteUrl: "https://acme.atlassian.net",
  email: "ops@acme.com",
  apiToken: "jira_token_test",
};

const ISSUE = (key: string) => `https://acme.atlassian.net/browse/${key}`;

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

  it("connects; the card is success-only and the state machine is configurable", async () => {
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
    // The submitted status, the fail regression and the window - all
    // per-connection, with the defaults stated (spec 7).
    expect(health!.configFields.map((f) => f.key)).toEqual([
      "siteUrl", "email", "apiToken", "submittedStatus", "failStatus", "windowDays",
    ]);
    expect(health!.configFields.filter((f) => f.optional).map((f) => f.placeholder))
      .toEqual(["any in-progress status", "any To Do status", "30"]);
  });

  it("backfill runs the state machine from the changelog, not the observed status", async () => {
    const session = fixture("backfill.json");
    const result = await runSync("jira", { pool, fetch: session.fetch, now: NOW, dataDir });
    expect(result.status).toBe("success");
    expect(result.window).toEqual({ since: "2025-06-11", until: "2026-06-11" });
    // SUP-1 (2) + SUP-2 pending (1) + SUP-3 fail (1) + SUP-4 (2).
    expect(result.rowsSynced).toBe(6);
    expect(session.remaining()).toHaveLength(0);

    // Outcomes only - the spend ledger never sees a success integration.
    expect(await factRows(pool, "jira")).toEqual([]);

    // SUP-1 reached Done inside the window -> success on the Done ts;
    // SUP-4 was submitted 2026-04-02 and never touched again -> the window
    // passed quietly, success at window end. Pending/failed issues emit
    // nothing. value stays NULL = the ROI's default applies at read time.
    expect(await outcomeRows(pool)).toMatchObject([
      { sourceRef: ISSUE("SUP-1"), kind: "issue_done", ts: "2026-06-09T10:15:00Z",
        product: "Issues done", personEmail: "dana@acme.com", valueCents: null, reverted: false },
      { sourceRef: ISSUE("SUP-4"), kind: "issue_done", ts: "2026-05-02T09:00:00Z",
        product: "Issues done", personEmail: "dana@acme.com", reverted: false },
    ]);

    // The issue ledger: every tracked issue with its machine state. SUP-3
    // regressed to To Do inside the window -> fail, credited to the agent
    // ASSIGNEE (app actor beats the human creator).
    expect(await trackedIssueRows(pool, "jira")).toMatchObject([
      { key: "SUP-1", project: "SUP", status: "success", decidedAt: "2026-06-09T10:15:00Z",
        identityExternalId: "5b10dana", personEmail: "dana@acme.com" },
      { key: "SUP-2", project: "SUP", status: "pending", decidedAt: null,
        anchorTs: "2026-06-08T08:00:00Z", identityExternalId: "appbot-1" },
      { key: "SUP-3", project: "SUP", status: "fail", decidedAt: "2026-05-25T09:00:00Z",
        identityExternalId: "appbot-1", personEmail: null },
      { key: "SUP-4", project: "SUP", status: "success", decidedAt: "2026-05-02T09:00:00Z" },
    ]);

    // Humans auto-match by email; the app actor's name became its tag
    // (spec 7: agent name routes like key-name = tag).
    expect(await identityRows(pool, "jira")).toMatchObject([
      { externalId: "5b10dana", kind: "user", email: "dana@acme.com", personEmail: "dana@acme.com" },
      { externalId: "5b10omar", kind: "user", email: "omar@acme.com", personEmail: "omar@acme.com" },
      { externalId: "appbot-1", kind: "user", email: null, displayName: "Deploy Agent",
        tags: ["deploy-agent"], personEmail: null },
    ]);

    const health = await connectorHealth("jira", pool, NOW);
    expect(health!.rowCounts).toMatchObject({ spendFacts: 0, outcomes: 2, identities: 3 });
  });

  it("incremental: a regression inside the window flips the counted success", async () => {
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
    // SUP-1 fail + flip (2), SUP-2 still pending (1), SUP-5 success (2).
    expect(result.rowsSynced).toBe(5);
    expect(session.remaining()).toHaveLength(0);

    const outcomes = await outcomeRows(pool);
    expect(outcomes.find((o) => o.sourceRef === ISSUE("SUP-1"))).toMatchObject({
      reverted: true,
      revertSourceRef: `${ISSUE("SUP-1")}#regressed`,
    });
    expect(outcomes.find((o) => o.sourceRef === ISSUE("SUP-5"))).toMatchObject({
      ts: "2026-06-13T08:00:00Z",
      personEmail: "omar@acme.com",
      product: "Issues done",
      reverted: false,
    });
    expect(await trackedIssueRows(pool, "jira")).toMatchObject([
      { key: "SUP-1", status: "fail", decidedAt: "2026-06-12T08:00:00Z" },
      { key: "SUP-2", status: "pending" },
      { key: "SUP-3", status: "fail" },
      { key: "SUP-4", status: "success" },
      { key: "SUP-5", status: "success", personEmail: "omar@acme.com" },
    ]);
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

  it("a quiet window promotes the pending issue to success - after the fact", async () => {
    const session = fixture("promote-quiet-window.json");
    const result = await runSync("jira", {
      pool,
      fetch: session.fetch,
      now: A_MONTH_LATER,
      dataDir,
    });
    expect(result.status).toBe("success");
    // SUP-5 restated in place (2) + the SUP-2 promotion (1).
    expect(result.rowsSynced).toBe(3);
    expect(session.remaining()).toHaveLength(0);

    // SUP-2 went pending 2026-06-08T08:00Z; 30 days passed with no
    // regression -> success AT THE WINDOW END, even though no sync window
    // will ever serve the issue again.
    expect(await outcomeRows(pool)).toMatchObject(
      expect.arrayContaining([
        expect.objectContaining({
          sourceRef: ISSUE("SUP-2"),
          ts: "2026-07-08T08:00:00Z",
          personEmail: null,
          reverted: false,
        }),
      ]),
    );
    const tracked = await trackedIssueRows(pool, "jira");
    expect(tracked.find((t) => t.key === "SUP-2")).toMatchObject({
      status: "success",
      decidedAt: "2026-07-08T08:00:00Z",
    });
  });

  it("pointing the agent's name-tag at an ROI moves its successes there", async () => {
    const product = await createProduct(
      { name: "Deploy bot", attribution: "key", outcomeKind: "issue_done" },
      pool,
    );
    const result = await updateTag("deploy-agent", { productId: product.id }, pool);
    expect(result.routedIdentities).toBe(1);
    expect(result.outcomes).toBe(1); // SUP-2's success moved

    const outcomes = await outcomeRows(pool);
    expect(outcomes.find((o) => o.sourceRef === ISSUE("SUP-2"))).toMatchObject({
      product: "Deploy bot",
    });
    // The issue ledger follows, so the ROI's ticket drill agrees.
    const tracked = await trackedIssueRows(pool, "jira");
    expect(tracked.find((t) => t.key === "SUP-2")).toMatchObject({ product: "Deploy bot" });
    expect(tracked.find((t) => t.key === "SUP-3")).toMatchObject({ product: "Deploy bot" });
    expect(tracked.find((t) => t.key === "SUP-1")).toMatchObject({ product: "Issues done" });
  });

  it("lists projects for the project -> ROI mapping, walking the vendor's paging", async () => {
    const ctx = buildContext(jiraConnector, CONFIG, fixture("projects.json").fetch);
    expect(await jiraConnector.listProjects!(ctx)).toEqual([
      { key: "SUP", name: "Support" },
      { key: "ENG", name: "Engineering" },
    ]);
  });

  it("vendor format drift throws with the field named, never bad numbers", async () => {
    const ctx = buildContext(jiraConnector, CONFIG, fixture("drift-issue-format.json").fetch);
    await expect(
      jiraConnector.fetchPage(ctx, { since: "2025-06-11", until: "2026-06-11" }, null),
    ).rejects.toThrow('jira issue SUP-9 fields: missing or invalid "created"');
  });
});
