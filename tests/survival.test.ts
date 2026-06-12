import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearSecretKeyCache } from "../src/lib/secrets";
import { setSecretSetting } from "../src/lib/settings";
import {
  addedLines,
  aliveCount,
  dueSurvivalPrs,
  horizonInstant,
  survivalTick,
} from "../src/lib/survival";
import { toolsData } from "../src/lib/tools";
import { roiView } from "../src/lib/roi";
import { runMigrations } from "../scripts/migrate.mjs";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

/**
 * Line survival (spec 5): the background job reads the repo's own git data
 * through the GitHub connector's token and records, per AI-authored merged
 * PR, how many of its added lines still exist unchanged at the 30/90-day
 * horizon - measured at the base branch's tip AT the horizon, so a check
 * is final no matter how late the job runs. Unmeasurable PRs (repo gone)
 * get a final error row; transient failures leave no row and retry.
 *
 * Fixture: three AI PRs in acme/app, all merged on main.
 *   #7 (claude_code, merged 2026-03-01) - wrote "const a = 1;" and
 *      "const b = 2;" (a blank added line is never counted) plus a binary
 *      file GitHub serves no patch for. At the 30-day tip one line is
 *      still there; at the 90-day tip the file is gone. -> 30d: 1/2 alive,
 *      90d: 0/2.
 *   #8 (cursor, merged 2026-05-01) - the repo 404s: final error rows.
 *   #9 (cursor, merged 2026-05-05) - GitHub 500s: deferred, no row.
 */

const NOW = new Date("2026-06-10T12:00:00Z");

const PATCH_7 =
  "@@ -0,0 +1,3 @@\n+const a = 1;\n+\n+const b = 2;";
const FILE_AT_30D = "const a = 1;\nconst c = 3;\n";

function fakeGithub(url: string): Response {
  const u = new URL(url);
  const p = u.pathname;
  if (p === "/repos/acme/app/pulls/7") {
    return Response.json({ number: 7, base: { ref: "main" } });
  }
  if (p === "/repos/acme/app/pulls/7/files") {
    return Response.json([
      { filename: "src/a.ts", status: "added", patch: PATCH_7 },
      { filename: "logo.png", status: "added" }, // no patch: not measurable
    ]);
  }
  if (p === "/repos/acme/app/commits" && u.searchParams.get("sha") === "main") {
    // The branch tip at each horizon: 30 days after the 03-01 merge vs 90.
    const until = u.searchParams.get("until")!;
    return Response.json([{ sha: until < "2026-04-15" ? "sha30" : "sha90" }]);
  }
  if (p === "/repos/acme/app/contents/src/a.ts") {
    if (u.searchParams.get("ref") === "sha30") {
      return new Response(FILE_AT_30D, { status: 200 });
    }
    return Response.json({ message: "Not Found" }, { status: 404 }); // file gone at 90d
  }
  if (p === "/repos/acme/gone/pulls/8") {
    return Response.json({ message: "Not Found" }, { status: 404 });
  }
  if (p === "/repos/acme/flaky/pulls/9") {
    return Response.json({ message: "Server Error" }, { status: 500 });
  }
  throw new Error(`unexpected github request: ${url}`);
}

describe("survival line math", () => {
  it("addedLines keeps '+' lines only, skips headers, blanks and CR", () => {
    expect(addedLines("@@ -1,2 +1,4 @@\n+++ b/x\n+one\n+\n+  \n-gone\n+two\r\n unchanged")).toEqual([
      "one",
      "two",
    ]);
  });

  it("aliveCount is a multiset match against the file's current text", () => {
    const added = ["dup", "dup", "kept", "gone"];
    expect(aliveCount(added, "dup\nkept\nother\n")).toBe(2); // one dup + kept
    expect(aliveCount(added, "dup\ndup\nkept\n")).toBe(3);
    expect(aliveCount(added, null)).toBe(0); // deleted file = dead lines
    expect(aliveCount([], "anything")).toBe(0);
  });

  it("horizonInstant is merge time + N days, UTC", () => {
    expect(horizonInstant("2026-03-01T00:00:00Z", 30)).toBe("2026-03-31T00:00:00.000Z");
    expect(horizonInstant("2026-03-01T00:00:00Z", 90)).toBe("2026-05-30T00:00:00.000Z");
  });
});

describe.runIf(TEST_DATABASE_URL)("survival job (spec 5)", () => {
  let dbUrl: string;
  let pool: Pool;
  let dataDir: string;

  beforeAll(async () => {
    dbUrl = await createScratchDb("survival_test");
    await runMigrations({ databaseUrl: dbUrl, dir: MIGRATIONS_DIR });
    process.env.DATABASE_URL = dbUrl;
    pool = new Pool({ connectionString: dbUrl, max: 3 });
    dataDir = mkdtempSync(path.join(os.tmpdir(), "ai-pnl-survival-"));

    const { rows: products } = await pool.query(
      `INSERT INTO products (name, attribution, outcome_kind)
       VALUES ('Coding', 'connector', 'github_pr') RETURNING id`,
    );
    const coding = products[0].id as string;
    const outcome = (ts: string, tools: string, ref: string) =>
      pool.query(
        `INSERT INTO outcomes (ts, product_id, kind, source_ref, tools)
         VALUES ($1, $2, 'github_pr', $3, $4)`,
        [ts, coding, ref, tools],
      );
    await outcome("2026-03-01T00:00:00Z", "{claude_code}", "pr:acme/app#7");
    await outcome("2026-05-01T00:00:00Z", "{cursor}", "pr:acme/gone#8");
    await outcome("2026-05-05T00:00:00Z", "{cursor}", "pr:acme/flaky#9");
    // Human-only PR: no tools, never checked.
    await outcome("2026-03-01T00:00:00Z", "{}", "pr:acme/app#1");

    // Claude Code's vendor cost estimate - the spend behind $/1k lines.
    await pool.query(
      `INSERT INTO usage_metrics (day, vendor, metric, value, source_ref)
       VALUES ('2026-03-01', 'anthropic', 'estimated_cost_cents', 3000, 'cc:1')`,
    );
  });

  afterAll(async () => {
    await pool?.end();
    if (dbUrl) await dropScratchDb(dbUrl);
    clearSecretKeyCache();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("is a no-op until GitHub is connected", async () => {
    expect(await survivalTick({ pool, now: NOW, dataDir })).toEqual({
      checks: 0,
      unmeasurable: 0,
      deferred: 0,
    });
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM survival_checks");
    expect(rows[0].n).toBe(0);
  });

  it("finds AI PRs past an unchecked horizon, oldest first", async () => {
    const due = await dueSurvivalPrs(pool, NOW, 10);
    expect(due).toEqual([
      // #7: merged 100+ days ago - both horizons due.
      { sourceRef: "pr:acme/app#7", mergedAt: "2026-03-01T00:00:00.000Z", horizons: [30, 90] },
      // #8/#9: merged in May - only the 30-day horizon has passed.
      { sourceRef: "pr:acme/gone#8", mergedAt: "2026-05-01T00:00:00.000Z", horizons: [30] },
      { sourceRef: "pr:acme/flaky#9", mergedAt: "2026-05-05T00:00:00.000Z", horizons: [30] },
    ]);
  });

  it("measures due PRs against the repo at each horizon and records finals", async () => {
    await pool.query("INSERT INTO connectors (vendor, history_limit_days, scopes) VALUES ('github', 90, '{}')");
    await setSecretSetting(
      "connector:github:config",
      JSON.stringify({ org: "acme", token: "ghp_test" }),
      pool,
      dataDir,
    );

    const result = await survivalTick({
      pool,
      now: NOW,
      dataDir,
      fetch: (async (url: RequestInfo | URL) => fakeGithub(String(url))) as typeof fetch,
    });
    // #7 -> two measured rows; #8 -> one final error row; #9 -> deferred.
    expect(result).toEqual({ checks: 3, unmeasurable: 1, deferred: 1 });

    const { rows } = await pool.query(
      `SELECT source_ref AS ref, horizon_days AS h, lines_written AS w,
              lines_alive AS a, error
       FROM survival_checks ORDER BY ref, h`,
    );
    expect(rows).toEqual([
      { ref: "pr:acme/app#7", h: 30, w: 2, a: 1, error: null },
      { ref: "pr:acme/app#7", h: 90, w: 2, a: 0, error: null },
      { ref: "pr:acme/gone#8", h: 30, w: null, a: null, error: "Not Found" },
    ]);

    // Checked PRs are done; only the deferred one comes back.
    expect((await dueSurvivalPrs(pool, NOW, 10)).map((d) => d.sourceRef)).toEqual([
      "pr:acme/flaky#9",
    ]);
  });

  it("surfaces survival per tool on the ROI views", async () => {
    const range = { from: "2026-03-01", to: "2026-03-31" };
    const tools = await toolsData(range, pool);
    const cc = tools.tools.find((t) => t.tool === "claude_code")!;
    expect(cc.linesWritten).toBe(2);
    expect(cc.linesAlive).toBe(1);
    expect(cc.survivalPct).toBe(50);
    expect(cc.survival90Pct).toBe(0);
    // 3,000c spend over 1 surviving line -> per 1,000 surviving lines.
    expect(cc.costPer1kSurvivingCents).toBe(3_000_000);

    // The per-person split carries the same ROI (everything here is
    // unassigned - the fixture's outcomes have no person).
    const cell = tools.rows.find(
      (r) => r.tool === "claude_code" && r.personId === null,
    )!;
    expect(cell).toMatchObject({
      linesWritten: 2,
      linesAlive: 1,
      survivalPct: 50,
      costPer1kSurvivingCents: 3_000_000,
    });

    // The ROI row's success IS the surviving code - merges are no factor.
    const roi = await roiView(range, pool);
    const row = roi.rows.find((r) => r.key === "coding:claude_code")!;
    expect(row).toMatchObject({
      unit: "1k lines",
      successes: 1,
      survivalPct: 50,
      costPerSuccessCents: 3_000_000,
    });

    // The unmeasurable PR's tool shows a dash, not a number.
    const mayTools = await toolsData({ from: "2026-05-01", to: "2026-05-31" }, pool);
    const cursor = mayTools.tools.find((t) => t.tool === "cursor")!;
    expect(cursor.survivalPct).toBeNull();
    expect(cursor.costPer1kSurvivingCents).toBeNull();
  });

  it("caps a pass at batchPrs and leaves the rest for the next tick", async () => {
    await pool.query("DELETE FROM survival_checks");
    const calls: string[] = [];
    const result = await survivalTick({
      pool,
      now: NOW,
      dataDir,
      batchPrs: 1,
      fetch: (async (url: RequestInfo | URL) => {
        calls.push(String(url));
        return fakeGithub(String(url));
      }) as typeof fetch,
    });
    expect(result).toEqual({ checks: 2, unmeasurable: 0, deferred: 0 });
    // Only #7 (the oldest) was touched.
    expect(calls.every((u) => u.includes("/acme/app/"))).toBe(true);
  });
});
