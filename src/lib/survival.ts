import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { buildContext, connectedRow, getConnectorConfig } from "./connectors/connect";
import {
  commitAtRequest,
  contentsRequest,
  FILES_PAGE_SIZE,
  ghFileTextOrNull,
  GhHttpError,
  ghJson,
  githubConnector,
  prFilesRequest,
  prRequest,
} from "./connectors/github";
import { isArr, isInt, isObj, isStr, nonEmptyStr, parsePicked } from "./connectors/strict";
import type { ConnectorContext } from "./connectors/types";
import { getPool } from "./db";
import { logger } from "./logger";

/**
 * Line survival (spec 5) - the real quality metric. AI commits are
 * identifiable (bot authors, co-author trailers - the GitHub connector
 * already tags each merged PR's tools[]), so this background job reads the
 * repo's own git data and checks how many of the lines an AI PR added
 * still exist unchanged 30 and 90 days after the merge. Vendors report
 * line COUNTS, never which lines - survival can only come from git.
 *
 * How one check works, all through the GitHub connector's stored token:
 *
 *   1. pulls/{n}          -> the base branch the PR merged into.
 *   2. pulls/{n}/files    -> the patch per file; its "+" lines (blank
 *                            lines excluded) are the lines the PR wrote.
 *                            Files GitHub serves no patch for (binary,
 *                            oversized) are not measurable and not counted.
 *   3. commits?sha=base&until=merge+horizon -> the base branch's tip AT
 *                            the horizon, so the answer is the same no
 *                            matter how late the job runs - a check is
 *                            final once written.
 *   4. contents/{path}@tip -> each touched file's text at the horizon; a
 *                            line is alive when it still appears verbatim
 *                            (multiset match - N copies written need N
 *                            copies present). A deleted file is dead lines.
 *
 * Output per tool (tools.ts aggregates over the PRs merged in range):
 * lines written, % alive, cost per 1,000 surviving lines - the coding ROI;
 * merging was never the success, code that stuck is. Reverted PRs are
 * checked like any other - their lines are simply (honestly) dead.
 *
 * PRs that can never be measured (repo or base branch gone, PR too large)
 * get a final error row and are excluded from the aggregates - absent,
 * never invented. Transient failures (rate limits, network) leave no row
 * and retry on the next tick.
 */

export const SURVIVAL_HORIZONS = [30, 90] as const;
/** PRs measured per tick - bounds the API budget; the backlog drains a
 * batch every 5-minute tick. */
export const SURVIVAL_BATCH_PRS = 10;
/** A PR touching more files than this is declared unmeasurable rather
 * than spending thousands of contents requests on one vendored-deps PR. */
export const SURVIVAL_MAX_FILES = 300;

export interface SurvivalTickOpts {
  pool?: Pool;
  fetch?: typeof fetch;
  now?: Date;
  /** Secrets-key directory override (tests). */
  dataDir?: string;
  batchPrs?: number;
}

export interface SurvivalTickResult {
  /** Checks written this tick (measured + final-error rows). */
  checks: number;
  /** Of those, final error rows (unmeasurable PRs). */
  unmeasurable: number;
  /** PRs skipped on a transient failure - they retry next tick. */
  deferred: number;
}

const NOTHING: SurvivalTickResult = { checks: 0, unmeasurable: 0, deferred: 0 };

// ---------------------------------------------------------------------------
// Pure pieces (exported for tests)

/** The "+" lines of one unified diff patch - what the PR wrote. Blank
 * lines are skipped: their "survival" says nothing about the code. */
export function addedLines(patch: string): string[] {
  const out: string[] = [];
  for (const raw of patch.split("\n")) {
    if (!raw.startsWith("+") || raw.startsWith("+++")) continue;
    const line = raw.slice(1).replace(/\r$/, "");
    if (line.trim() !== "") out.push(line);
  }
  return out;
}

/** How many of the added lines still appear verbatim in the file's current
 * text. Multiset semantics: two identical lines written count as alive
 * twice only when the file still holds two copies. null = file gone. */
export function aliveCount(added: string[], current: string | null): number {
  if (current === null || added.length === 0) return 0;
  const have = new Map<string, number>();
  for (const raw of current.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "") continue;
    have.set(line, (have.get(line) ?? 0) + 1);
  }
  let alive = 0;
  for (const line of added) {
    const left = have.get(line) ?? 0;
    if (left > 0) {
      alive += 1;
      have.set(line, left - 1);
    }
  }
  return alive;
}

/** The horizon instant: merge time + N days, ISO (UTC). */
export function horizonInstant(mergedAt: string, horizonDays: number): string {
  return new Date(Date.parse(mergedAt) + horizonDays * 86_400_000).toISOString();
}

// ---------------------------------------------------------------------------
// Due work

interface DuePr {
  /** outcomes.source_ref, "pr:owner/repo#n". */
  sourceRef: string;
  /** merged_at (the outcome's ts), ISO. */
  mergedAt: string;
  /** Horizons past and still unchecked, ascending. */
  horizons: number[];
}

/** AI-authored merged PRs with a horizon behind `now` and no check yet,
 * oldest merges first so the backlog drains in order. */
export async function dueSurvivalPrs(
  pool: Pool,
  now: Date,
  limit: number,
): Promise<DuePr[]> {
  const { rows } = await pool.query(
    `SELECT o.source_ref AS "sourceRef", o.ts AS "mergedAt",
            array_agg(h.horizon ORDER BY h.horizon) AS horizons
     FROM outcomes o
     CROSS JOIN unnest($2::int[]) AS h(horizon)
     LEFT JOIN survival_checks sc
       ON sc.source_ref = o.source_ref AND sc.horizon_days = h.horizon
     WHERE o.kind = 'github_pr'
       AND cardinality(o.tools) > 0
       AND o.source_ref LIKE 'pr:%'
       AND sc.source_ref IS NULL
       AND o.ts + make_interval(days => h.horizon) <= $1
     GROUP BY o.source_ref, o.ts
     ORDER BY o.ts, o.source_ref
     LIMIT $3`,
    [now, [...SURVIVAL_HORIZONS], limit],
  );
  return rows.map((row) => ({
    sourceRef: row.sourceRef as string,
    mergedAt: (row.mergedAt as Date).toISOString(),
    horizons: (row.horizons as number[]).map(Number),
  }));
}

// ---------------------------------------------------------------------------
// One PR

/** "pr:owner/repo#n" -> "owner/repo#n" (the github.ts ref shape). */
function ghRef(sourceRef: string): string {
  return sourceRef.slice("pr:".length);
}

/** Added lines per file, or the final-error reason when unmeasurable. */
async function prAddedLines(
  ctx: ConnectorContext,
  ref: string,
): Promise<Map<string, string[]>> {
  const byFile = new Map<string, string[]>();
  let fileCount = 0;
  for (let page = 1; ; page++) {
    const body = await ghJson(ctx, prFilesRequest(ref, page));
    if (!isArr(body)) {
      throw new Error(`github pull request files response for ${ref} is not an array`);
    }
    const items = body as unknown[];
    fileCount += items.length;
    if (fileCount > SURVIVAL_MAX_FILES) {
      throw new GhHttpError(
        `pull request ${ref} touches over ${SURVIVAL_MAX_FILES} files - too large to measure`,
        404, // final, like a gone repo: this PR will never be measurable
      );
    }
    for (const raw of items) {
      const file = parsePicked(`github pull request file (${ref})`, raw, {
        filename: nonEmptyStr,
      }, {
        patch: isStr,
      });
      if (typeof file.patch !== "string") continue; // binary/oversized: not measurable
      const lines = addedLines(file.patch);
      if (lines.length === 0) continue;
      const name = file.filename as string;
      byFile.set(name, [...(byFile.get(name) ?? []), ...lines]);
    }
    if (items.length < FILES_PAGE_SIZE) return byFile;
  }
}

/** The base branch's commit sha at the horizon instant. */
async function shaAt(
  ctx: ConnectorContext,
  ref: string,
  branch: string,
  until: string,
): Promise<string> {
  const body = await ghJson(ctx, commitAtRequest(ref, branch, until));
  if (!isArr(body) || (body as unknown[]).length === 0) {
    throw new GhHttpError(
      `no commit on ${branch} at ${until} - the base branch history is gone`,
      404,
    );
  }
  const commit = parsePicked(`github commit (${ref})`, (body as unknown[])[0], {
    sha: nonEmptyStr,
  });
  return commit.sha as string;
}

interface CheckRow {
  horizonDays: number;
  linesWritten: number | null;
  linesAlive: number | null;
  error: string | null;
}

/** Measure one PR at each due horizon. Throws on transient failures;
 * returns final error rows for everything unmeasurable. */
export async function measurePr(
  ctx: ConnectorContext,
  due: DuePr,
): Promise<CheckRow[]> {
  const ref = ghRef(due.sourceRef);
  try {
    const detail = parsePicked(`github pull request ${ref}`, await ghJson(ctx, prRequest(ref)), {
      number: isInt,
      base: isObj,
    });
    const base = parsePicked(`github pull request ${ref} base`, detail.base, {
      ref: nonEmptyStr,
    });
    const branch = base.ref as string;
    const byFile = await prAddedLines(ctx, ref);
    const written = [...byFile.values()].reduce((sum, lines) => sum + lines.length, 0);

    const rows: CheckRow[] = [];
    for (const horizon of due.horizons) {
      if (written === 0) {
        // Nothing measurable was written (deletions only, binary churn):
        // recorded as such so the PR is never re-fetched.
        rows.push({ horizonDays: horizon, linesWritten: 0, linesAlive: 0, error: null });
        continue;
      }
      const sha = await shaAt(ctx, ref, branch, horizonInstant(due.mergedAt, horizon));
      let alive = 0;
      for (const [filePath, lines] of byFile) {
        const text = await ghFileTextOrNull(ctx, contentsRequest(ref, filePath, sha));
        alive += aliveCount(lines, text);
      }
      rows.push({ horizonDays: horizon, linesWritten: written, linesAlive: alive, error: null });
    }
    return rows;
  } catch (err) {
    if (err instanceof GhHttpError && (err.status === 404 || err.status === 410 || err.status === 451)) {
      // Gone forever - a final row per horizon, excluded from aggregates.
      return due.horizons.map((horizon) => ({
        horizonDays: horizon,
        linesWritten: null,
        linesAlive: null,
        error: err.message,
      }));
    }
    throw err; // transient: no row, retried next tick
  }
}

// ---------------------------------------------------------------------------
// The tick

function lockKey(): number {
  // Same scheme as the sync engine's per-connector lock.
  return parseInt(
    createHash("sha256").update("ai-pnl:sync:survival").digest("hex").slice(0, 8),
    16,
  );
}

/**
 * One survival pass: measure up to batchPrs due PRs. Rides the scheduler
 * tick; a no-op until GitHub is connected. The advisory lock keeps
 * overlapping ticks from measuring the same PR twice.
 */
export async function survivalTick(
  opts: SurvivalTickOpts = {},
): Promise<SurvivalTickResult> {
  const pool = opts.pool ?? getPool();
  const now = opts.now ?? new Date();

  if ((await connectedRow("github", pool)) === null) return NOTHING;
  const config = await getConnectorConfig("github", { db: pool, dataDir: opts.dataDir });
  if (config === null) return NOTHING;

  const client = await pool.connect();
  let locked = false;
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [lockKey()]);
    if (!lock.rows[0].ok) {
      logger.info("survival pass already running, skipped");
      return NOTHING;
    }
    locked = true;

    const due = await dueSurvivalPrs(pool, now, opts.batchPrs ?? SURVIVAL_BATCH_PRS);
    if (due.length === 0) return NOTHING;

    const ctx = buildContext(githubConnector, config, opts.fetch ?? fetch);
    const result: SurvivalTickResult = { checks: 0, unmeasurable: 0, deferred: 0 };
    for (const pr of due) {
      let rows: CheckRow[];
      try {
        rows = await measurePr(ctx, pr);
      } catch (err) {
        logger.warn("survival check deferred", { sourceRef: pr.sourceRef, error: err });
        result.deferred += 1;
        continue;
      }
      for (const row of rows) {
        await client.query(
          `INSERT INTO survival_checks
             (source_ref, horizon_days, lines_written, lines_alive, error, checked_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (source_ref, horizon_days) DO NOTHING`,
          [pr.sourceRef, row.horizonDays, row.linesWritten, row.linesAlive, row.error, now],
        );
        result.checks += 1;
        if (row.error !== null) result.unmeasurable += 1;
      }
    }
    if (result.checks > 0 || result.deferred > 0) {
      logger.info("survival pass finished", { ...result });
    }
    return result;
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock($1)", [lockKey()]).catch(() => {});
    }
    client.release();
  }
}
