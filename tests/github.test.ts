import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectConnector, connectedRow } from "../src/lib/connectors/connect";
import { githubConnector } from "../src/lib/connectors/github";
import { connectorHealth } from "../src/lib/connectors/health";
import { clearConnectors, registerConnector } from "../src/lib/connectors/registry";
import { runSync } from "../src/lib/connectors/sync";
import { recomputeRollups } from "../src/lib/rollup";
import { clearSecretKeyCache } from "../src/lib/secrets";
import { runMigrations } from "../scripts/migrate.mjs";
import { factRows, identityRows, lastRunRow, metricRows, outcomeRows } from "./helpers/ledger";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";
import { replayFile, type ReplaySession } from "./helpers/replay";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");
const FIXTURES = path.resolve(__dirname, "fixtures", "connectors", "github");

/** Pinned clock: fixtures are recorded against this "today" (2026-06-11). */
const NOW = new Date("2026-06-11T12:00:00Z");
const NEXT_DAY = new Date("2026-06-12T09:00:00Z");
/** Incremental fixture is recorded against today = 2026-06-13. */
const TWO_DAYS_LATER = new Date("2026-06-13T09:00:00Z");
const SAME_DAY_LATER = new Date("2026-06-13T18:00:00Z");

const CONFIG = { org: "acme", token: "ghp_test" };
const ENT_CONFIG = { org: "acme", token: "ghp_test", enterprise: "acme-corp" };

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
    ctx.dataDir = mkdtempSync(path.join(os.tmpdir(), "ai-pnl-github-"));
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

async function outcomeRollup(pool: Pool): Promise<Array<[string, number]>> {
  const { rows } = await pool.query(
    `SELECT kind, SUM(outcome_count)::int AS count
     FROM rollup_outcomes_daily GROUP BY kind ORDER BY kind`,
  );
  return rows.map((r) => [r.kind as string, r.count as number]);
}

describe.runIf(TEST_DATABASE_URL)("github connector", () => {
  beforeAll(() => {
    clearConnectors();
    registerConnector(githubConnector);
  });
  afterAll(() => clearConnectors());

  describe("connect + backfill + incremental", () => {
    const ctx = scratch("github_test", true);

    it("rejects a bad token with the vendor's error verbatim and stores nothing", async () => {
      await expect(
        connectConnector("github", CONFIG, {
          db: ctx.pool,
          fetch: fixture("connect-unauthorized.json").fetch,
          dataDir: ctx.dataDir,
        }),
      ).rejects.toThrow("Bad credentials");
      expect(await connectedRow("github", ctx.pool)).toBeNull();
    });

    it("rejects a token without billing access - every surface is probed on connect", async () => {
      await expect(
        connectConnector("github", CONFIG, {
          db: ctx.pool,
          fetch: fixture("connect-missing-billing.json").fetch,
          dataDir: ctx.dataDir,
        }),
      ).rejects.toThrow(
        "You must have admin access to the organization to view its billing usage.",
      );
      expect(await connectedRow("github", ctx.pool)).toBeNull();
    });

    it("connects when all probes answer; the connect screen states the vendor truths", async () => {
      const session = fixture("connect-ok.json");
      const row = await connectConnector("github", CONFIG, {
        db: ctx.pool,
        fetch: session.fetch,
        dataDir: ctx.dataDir,
      });
      expect(row.history_limit_days).toBe(90);
      expect(row.scopes).toEqual(["copilot", "billing", "repo"]);
      expect(session.remaining()).toHaveLength(0);

      const health = await connectorHealth("github", ctx.pool);
      const notes = health!.connectNotes.join(" ");
      // The spec-5 vendor limits, verbatim on the connect screen.
      expect(notes).toMatch(/enterprise owner's classic PAT with admin:enterprise/);
      expect(notes).toMatch(/revert window \(Settings, default 30 days\)/);
      expect(notes).toMatch(/per user per calendar month/);
      expect(notes).toMatch(/never invented or amortized/);
      expect(notes).toMatch(/counts as human/);
      expect(health!.configFields).toEqual([
        { key: "org", label: "Organization slug" },
        { key: "token", label: "Personal access token (classic)", secret: true },
        { key: "enterprise", label: "Enterprise slug (enterprise-owned orgs only)" },
      ]);
    });

    it("backfills 90 days: seats, monthly AI-credit dollars, daily usage, merged PRs", async () => {
      const session = fixture("backfill.json");
      const result = await runSync("github", {
        pool: ctx.pool,
        fetch: session.fetch,
        now: NOW,
        dataDir: ctx.dataDir,
      });

      expect(result.status).toBe("success");
      expect(result.window).toEqual({ since: "2026-03-13", until: "2026-06-11" });
      // 5 facts + 22 metrics + 9 merged-PR outcomes + 1 revert flip
      expect(result.rowsSynced).toBe(37);
      // Every recorded request was made - the roster, the org + per-user
      // month reports (zero months skip the user walk), all 28 daily
      // reports and their NDJSON blobs, all four 30-day search chunks, and
      // two requests per merged PR (paged commits included).
      expect(session.remaining()).toHaveLength(0);

      const expected = JSON.parse(
        readFileSync(path.join(FIXTURES, "backfill-expected.json"), "utf8"),
      );
      expect(await factRows(ctx.pool, "github")).toEqual(expected.facts);
      expect(await identityRows(ctx.pool, "github")).toEqual(expected.identities);
      expect(await metricRows(ctx.pool, "github")).toEqual(expected.metrics);
      expect(await outcomeRows(ctx.pool)).toEqual(expected.outcomes);

      expect(JSON.parse((await lastRunRow(ctx.pool, "github")).cursor)).toEqual({
        watermark: "2026-06-11",
      });
    });

    it("books AI-credit dollars per user per month and keeps the rest visibly Unassigned", async () => {
      const facts = await factRows(ctx.pool, "github");
      // Dana's May report: $4.00 of GPT-5 credits on the May bucket,
      // auto-mapped through her public email.
      expect(
        facts.find((f) => f.sourceRef === "ai_credit:2026-05:9001:Copilot AI Credits:GPT-5"),
      ).toMatchObject({
        day: "2026-05-01",
        amountCents: 400,
        costBasis: "invoiced",
        personEmail: "dana@acme.com",
      });
      // The org May total ($7.00) exceeds what the per-user walk could
      // attribute ($6.50) - an ex-seat-holder's spend. Never dropped: it
      // lands as the Unassigned remainder, drillable to the month report.
      expect(facts.find((f) => f.sourceRef === "ai_credit:2026-05:unassigned")).toMatchObject({
        amountCents: 50,
        identityExternalId: null,
        personEmail: null,
      });
      // The vendor's own month totals live as metrics (invoice truth),
      // never as ledger money - the per-user facts are the ledger.
      const metrics = await metricRows(ctx.pool, "github");
      expect(
        metrics.find((m) => m.sourceRef === "ai_credit:2026-05:org"),
      ).toMatchObject({ metric: "ai_credit_month_total_cents", value: 700 });
    });

    it("detects AI authorship from bot authors and co-author trailers", async () => {
      const outcomes = await outcomeRows(ctx.pool);
      // Devin authored the PR (bot author): the outcome is the bot's tool,
      // never a person.
      expect(outcomes.find((o) => o.sourceRef === "pr:acme/api#7")).toMatchObject({
        tools: ["devin"],
        personEmail: null,
      });
      // Claude co-author trailer on a human PR: the human keeps the credit,
      // the tool is recorded (trailer sits on page 2 of a 103-commit PR).
      expect(outcomes.find((o) => o.sourceRef === "pr:acme/web#41")).toMatchObject({
        tools: ["claude_code"],
        personEmail: "dana@acme.com",
      });
      // Two tools on one PR, both kept.
      expect(outcomes.find((o) => o.sourceRef === "pr:acme/web#60")).toMatchObject({
        tools: ["copilot", "cursor"],
      });
      // dependabot is a bot author but NOT an AI tool - never claimed as AI.
      expect(outcomes.find((o) => o.sourceRef === "pr:acme/api#62")).toMatchObject({
        tools: [],
        personEmail: null,
      });
    });

    it("flips a merged PR reverted inside the window; outside the window it is final", async () => {
      const outcomes = await outcomeRows(ctx.pool);
      // acme/api#9's commit says "This reverts commit <merge sha of #7>" 16
      // days after #7 merged: flipped, drillable to the reverting PR.
      expect(outcomes.find((o) => o.sourceRef === "pr:acme/api#7")).toMatchObject({
        reverted: true,
        revertSourceRef: "pr:acme/api#9",
      });
      // acme/web#52 reverts #45 56 days after its merge - past the 30-day
      // window, so #45 stays final. The revert PR itself still counts: a
      // merged PR counts on merge.
      expect(outcomes.find((o) => o.sourceRef === "pr:acme/web#45")).toMatchObject({
        reverted: false,
        revertSourceRef: null,
      });
      expect(outcomes.find((o) => o.sourceRef === "pr:acme/web#52")).toMatchObject({
        reverted: false,
      });
    });

    it("recomputes rollups with reverted merges in their own bucket - $/merge counts live merges only", async () => {
      await recomputeRollups({}, ctx.pool);
      // 9 merged PRs, one flipped: 8 live, 1 reverted.
      expect(await outcomeRollup(ctx.pool)).toEqual([
        ["github_pr", 8],
        ["github_pr:reverted", 1],
      ]);
    });

    it("incremental sync restates the trailing window and flips an old PR reverted today", async () => {
      const result = await runSync("github", {
        pool: ctx.pool,
        fetch: fixture("incremental.json").fetch,
        now: TWO_DAYS_LATER,
        dataDir: ctx.dataDir,
      });
      expect(result.status).toBe("success");
      // watermark 2026-06-11, re-pull widens to today-7 = 2026-06-06
      expect(result.window).toEqual({ since: "2026-06-06", until: "2026-06-13" });

      const facts = await factRows(ctx.pool, "github");
      expect(facts).toHaveLength(6);
      // The running month restates in place: Dana 1234 -> 1500 cents, Omar's
      // first June spend appears, the Unassigned remainder moves 0 -> 300.
      expect(
        facts.find((f) => f.sourceRef === "ai_credit:2026-06:9001:Copilot AI Credits:GPT-5"),
      ).toMatchObject({ amountCents: 1500 });
      expect(
        facts.find(
          (f) => f.sourceRef === "ai_credit:2026-06:9002:Copilot AI Credits:Claude Sonnet 4.5",
        ),
      ).toMatchObject({ amountCents: 200 });
      expect(facts.find((f) => f.sourceRef === "ai_credit:2026-06:unassigned")).toMatchObject({
        amountCents: 300,
      });

      const metrics = await metricRows(ctx.pool, "github");
      // Vendor restated Dana's 2026-06-09 report: 14 -> 16 interactions, in
      // place; Omar's new day appears.
      expect(
        metrics.find((m) => m.sourceRef === "cp:2026-06-09:9001" && m.metric === "interactions"),
      ).toMatchObject({ value: 16 });
      expect(metrics.filter((m) => m.sourceRef === "cp:2026-06-12:9002")).toHaveLength(6);
      expect(
        metrics.find((m) => m.sourceRef === "ai_credit:2026-06:org"),
      ).toMatchObject({ value: 2000 });
      expect(metrics).toHaveLength(28);

      // THE cross-sync revert: acme/web#67 (merged today) reverts #58,
      // merged 18 days ago - far outside this sync's window. The flip lands
      // on the ledger row from the backfill.
      const outcomes = await outcomeRows(ctx.pool);
      expect(outcomes).toHaveLength(10);
      expect(outcomes.find((o) => o.sourceRef === "pr:acme/web#58")).toMatchObject({
        reverted: true,
        revertSourceRef: "pr:acme/web#67",
      });

      await recomputeRollups({}, ctx.pool);
      expect(await outcomeRollup(ctx.pool)).toEqual([
        ["github_pr", 8],
        ["github_pr:reverted", 2],
      ]);
    });

    it("replaying the exact same sync changes nothing", async () => {
      const factsBefore = await factRows(ctx.pool, "github");
      const metricsBefore = await metricRows(ctx.pool, "github");
      const outcomesBefore = await outcomeRows(ctx.pool);
      const result = await runSync("github", {
        pool: ctx.pool,
        fetch: fixture("incremental.json").fetch,
        now: SAME_DAY_LATER,
        dataDir: ctx.dataDir,
      });
      expect(result.status).toBe("success");
      expect(await factRows(ctx.pool, "github")).toEqual(factsBefore);
      expect(await metricRows(ctx.pool, "github")).toEqual(metricsBefore);
      // re-delivered reverts are idempotent: flips and their refs survive
      expect(await outcomeRows(ctx.pool)).toEqual(outcomesBefore);
    });

    it("health counts facts, identities, and metrics live from the tables", async () => {
      const health = await connectorHealth("github", ctx.pool);
      expect(health).toMatchObject({
        vendor: "github",
        displayName: "GitHub",
        connected: true,
        historyLimitDays: 90,
        rowCounts: { spendFacts: 6, identities: 6, metrics: 28 },
      });
    });
  });

  describe("resume mid-backfill after a vendor failure", () => {
    const ctx = scratch("github_resume", true);

    it("enterprise-owned orgs read billing through the enterprise API", async () => {
      const session = fixture("connect-ok-enterprise.json");
      const row = await connectConnector("github", ENT_CONFIG, {
        db: ctx.pool,
        fetch: session.fetch,
        dataDir: ctx.dataDir,
      });
      expect(row.scopes).toEqual(["copilot", "billing", "repo"]);
      // The billing probe hit /enterprises/acme-corp/... - structurally
      // pinned: the recording only answers the enterprise URL.
      expect(session.remaining()).toHaveLength(0);
    });

    it("a 500 mid-PR-walk stores the vendor error verbatim and keeps committed pages", async () => {
      await connectConnector("github", CONFIG, {
        db: ctx.pool,
        fetch: fixture("connect-ok.json").fetch,
        dataDir: ctx.dataDir,
      });
      const result = await runSync("github", {
        pool: ctx.pool,
        fetch: fixture("backfill-pr-commits-fails.json").fetch,
        now: NOW,
        dataDir: ctx.dataDir,
      });

      expect(result.status).toBe("error");
      expect(result.error).toBe("Internal Server Error");
      // Everything before the failed commits request is committed: all the
      // money, all the metrics, and the five PRs already finalized.
      expect(await factRows(ctx.pool, "github")).toHaveLength(5);
      expect(await metricRows(ctx.pool, "github")).toHaveLength(22);
      expect(await outcomeRows(ctx.pool)).toHaveLength(5);

      const run = await lastRunRow(ctx.pool, "github");
      const cursor = JSON.parse(run.cursor);
      expect(cursor.inProgress).toMatchObject({ since: "2026-03-13", until: "2026-06-11" });
      // the composite token points at the exact PR and commits page that failed
      const token = JSON.parse(cursor.inProgress.pageToken);
      expect(token).toMatchObject({ phase: "pr" });
      expect(token.queue).toEqual([
        "acme/api#9",
        "acme/web#60",
        "acme/web#61",
        "acme/api#62",
      ]);
      expect(token.current).toMatchObject({ ts: "2026-06-05T16:00:00Z", page: 1 });
    });

    it("the next run resumes the failed request and finishes the window", async () => {
      const session = fixture("resume-from-pr-commits.json");
      const result = await runSync("github", {
        pool: ctx.pool,
        fetch: session.fetch,
        now: NEXT_DAY,
        dataDir: ctx.dataDir,
      });

      expect(result.status).toBe("success");
      expect(result.window).toEqual({ since: "2026-03-13", until: "2026-06-11" });
      expect(session.remaining()).toHaveLength(0);

      // the finished ledger is byte-identical to the uninterrupted backfill,
      // including the revert flip applied by the resumed half
      const expected = JSON.parse(
        readFileSync(path.join(FIXTURES, "backfill-expected.json"), "utf8"),
      );
      expect(await factRows(ctx.pool, "github")).toEqual(expected.facts);
      expect(await identityRows(ctx.pool, "github")).toEqual(expected.identities);
      expect(await metricRows(ctx.pool, "github")).toEqual(expected.metrics);
      expect(await outcomeRows(ctx.pool)).toEqual(expected.outcomes);
      expect(JSON.parse((await lastRunRow(ctx.pool, "github")).cursor)).toEqual({
        watermark: "2026-06-11",
      });
    });
  });

  describe("vendor drift fails the sync instead of writing bad numbers", () => {
    const ctx = scratch("github_drift", false);

    it("an unexpected field in an AI-credit usage item fails verbatim", async () => {
      await connectConnector("github", CONFIG, {
        db: ctx.pool,
        fetch: fixture("connect-ok.json").fetch,
        dataDir: ctx.dataDir,
      });
      const result = await runSync("github", {
        pool: ctx.pool,
        fetch: fixture("drift-credit-format.json").fetch,
        now: NOW,
        dataDir: ctx.dataDir,
      });
      expect(result.status).toBe("error");
      expect(result.error).toBe('github ai-credit usage item: unexpected field "totalAmount"');
      expect(await factRows(ctx.pool, "github")).toHaveLength(0);
      expect(await metricRows(ctx.pool, "github")).toHaveLength(0);
    });

    it("a usage report whose report_day contradicts the request fails with both named", async () => {
      const result = await runSync("github", {
        pool: ctx.pool,
        fetch: fixture("drift-report-day.json").fetch,
        now: NOW,
        dataDir: ctx.dataDir,
      });
      expect(result.status).toBe("error");
      expect(result.error).toBe(
        "github copilot usage report: report_day 2026-05-14 is not the requested day 2026-05-15",
      );
      // the four committed month totals stayed; the bad report did not land
      expect(await metricRows(ctx.pool, "github")).toHaveLength(4);
    });

    it("an incomplete search result fails - it would silently drop merged PRs", async () => {
      const result = await runSync("github", {
        pool: ctx.pool,
        fetch: fixture("drift-search-incomplete.json").fetch,
        now: NOW,
        dataDir: ctx.dataDir,
      });
      expect(result.status).toBe("error");
      expect(result.error).toBe(
        "github search returned incomplete results for 2026-03-13..2026-04-11",
      );
      expect(await outcomeRows(ctx.pool)).toHaveLength(0);
      // and the error sits on the run for the health surface
      expect((await lastRunRow(ctx.pool, "github")).error).toMatch(/incomplete results/);
    });
  });
});
