import type { PoolClient } from "pg";
import type { Db } from "../db";
import { resolveOutcomeProduct } from "../products";
import type { IssueInput } from "./types";

/** The credited identity, as the sync engine resolved it (structurally a
 * sync.ts ResolvedIdentity - typed here to keep the import acyclic). */
export interface CreditedIdentity {
  id: string;
  personId: string | null;
  productId: string | null;
}

/**
 * The success state machine for issue integrations (spec 7: Jira, Linear).
 *
 * Everything is derived from the issue's status-transition history (Jira
 * changelog / Linear history), never from the status a sync happens to
 * observe - so an issue is counted after the fact even when the sync runs
 * weeks later. Per connection, all user-configurable with defaults:
 *
 * - submitted status (default: any in-progress status - Jira statusCategory
 *   indeterminate / Linear "started"; "In Review" lives there)
 * - fail regression (default: back to To Do - Jira statusCategory new /
 *   Linear backlog, unstarted, canceled or duplicate)
 * - window (default 30 days)
 *
 * An issue that hits submitted goes PENDING. It succeeds when the window
 * passes without a regression, or when it reaches Done sooner; it fails
 * when it regresses inside the window - a regression after the window never
 * flips it (the success is final, same as the PR revert rule, spec 5).
 * Success emits one 'issue_done' outcome with source_ref = the issue; its
 * value is the ROI's default, applied at read time like every outcome.
 *
 * The connectors distill history into three timestamps (distillTransitions);
 * the framework evaluates them (evaluateIssue), keeps the issue_tracking
 * ledger, and promotes pending issues whose window expired at the end of
 * every successful sync (promoteDueIssues) - that is what turns a quiet
 * window into a success for an issue nobody touched again.
 */

export const ISSUE_OUTCOME_KIND = "issue_done";
export const DEFAULT_ISSUE_WINDOW_DAYS = 30;

/**
 * Where a status sits on any board: to-do, in progress, or done. Jira maps
 * statusCategory (new/indeterminate/done), Linear maps state type
 * (backlog/unstarted/triage/canceled/duplicate -> todo, started -> doing,
 * completed -> done). null = the vendor no longer defines the status
 * (deleted since the transition) - it can still match by configured name,
 * never by bucket.
 */
export type StatusBucket = "todo" | "doing" | "done" | null;

export interface StatusTransition {
  /** ISO timestamp the issue entered the status. */
  ts: string;
  /** The status name, for the configured-name match. */
  name: string;
  bucket: StatusBucket;
}

/** The per-connection state machine config, from the connect form. */
export interface IssueStateConfig {
  /** Status name that means "submitted"; empty = any in-progress status. */
  submittedStatus?: string;
  /** Status name that means a regression; empty = any to-do status. */
  failStatus?: string;
  /** Days the window runs from the anchor; empty = 30. */
  windowDays?: string;
}

export interface IssueEvents {
  submittedAt: string | null;
  doneAt: string | null;
  regressedAt: string | null;
}

function nameMatch(configured: string, name: string): boolean {
  return configured.trim().toLowerCase() === name.trim().toLowerCase();
}

/** An agent's name becomes its tag (spec 7: the name routes to the ROI
 * whose tag matches - the same convention as key-name = tag). */
export function agentTag(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

/**
 * Distill an issue's ordered status timeline into the three timestamps the
 * state machine needs: first submitted, first Done at/after the anchor, and
 * first regression after the anchor. Shared by both issue connectors so the
 * matching rules cannot drift apart.
 */
export function distillTransitions(
  transitions: StatusTransition[],
  config: IssueStateConfig = {},
): IssueEvents {
  // Normalized to UTC ISO, so ordering is plain string comparison whatever
  // offset format the vendor reported.
  const ordered = transitions
    .map((t) => ({ ...t, ts: new Date(t.ts).toISOString() }))
    .sort((a, b) => a.ts.localeCompare(b.ts));
  const submitted = config.submittedStatus?.trim()
    ? (t: StatusTransition) => nameMatch(config.submittedStatus!, t.name)
    : (t: StatusTransition) => t.bucket === "doing";
  const fails = config.failStatus?.trim()
    ? (t: StatusTransition) => nameMatch(config.failStatus!, t.name)
    : (t: StatusTransition) => t.bucket === "todo";

  const submittedAt = ordered.find(submitted)?.ts ?? null;
  const firstDone = ordered.find((t) => t.bucket === "done")?.ts ?? null;
  const anchor =
    submittedAt !== null && firstDone !== null
      ? submittedAt < firstDone
        ? submittedAt
        : firstDone
      : (submittedAt ?? firstDone);
  if (anchor === null) return { submittedAt: null, doneAt: null, regressedAt: null };
  const regressedAt = ordered.find((t) => fails(t) && t.ts > anchor)?.ts ?? null;
  return { submittedAt, doneAt: firstDone, regressedAt };
}

/** Window length for a connection; empty/garbage falls back to the default. */
export function windowDaysFrom(config: Record<string, string>): number {
  const parsed = Number.parseInt(config.windowDays ?? "", 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_ISSUE_WINDOW_DAYS;
}

export type IssueState =
  | { status: "none" }
  | { status: "pending"; anchorTs: string; windowEnd: string }
  | { status: "success"; anchorTs: string; windowEnd: string; decidedAt: string }
  | { status: "fail"; anchorTs: string; windowEnd: string; decidedAt: string };

function isoPlusDays(ts: string, days: number): string {
  return new Date(Date.parse(ts) + days * 86_400_000).toISOString();
}

/**
 * The state machine. Anchor = first submitted (or straight into Done - then
 * the window is the reopen window, spec 7's "reaches Done plus a reopen
 * window" default). Deterministic in (events, windowDays, now), so re-pulls
 * always restate to the same answer.
 */
export function evaluateIssue(
  events: IssueEvents,
  windowDays: number,
  now: Date,
): IssueState {
  // Normalize to UTC ISO so timestamp comparisons are plain string order
  // whatever offset format the vendor reported.
  const iso = (ts: string | null) => (ts === null ? null : new Date(ts).toISOString());
  const submittedAt = iso(events.submittedAt);
  const doneAt = iso(events.doneAt);
  const regressedAt = iso(events.regressedAt);
  const anchorTs =
    submittedAt !== null && doneAt !== null
      ? submittedAt < doneAt
        ? submittedAt
        : doneAt
      : (submittedAt ?? doneAt);
  if (anchorTs === null) return { status: "none" };
  const windowEnd = isoPlusDays(anchorTs, windowDays);
  const base = { anchorTs, windowEnd };
  if (regressedAt !== null && regressedAt <= windowEnd) {
    return { ...base, status: "fail", decidedAt: regressedAt };
  }
  if (doneAt !== null && doneAt <= windowEnd) {
    return { ...base, status: "success", decidedAt: doneAt };
  }
  if (now.toISOString() >= windowEnd) {
    return { ...base, status: "success", decidedAt: windowEnd };
  }
  return { ...base, status: "pending" };
}

/**
 * Issue success routing (spec 7) - two layers, then the default, never a
 * guess: the credited identity's tag routing (an agent's name is its tag;
 * pointing that tag at an ROI routes every success it earns), else the
 * project -> ROI mapping chosen at connect, else the built-in "Issues done"
 * row that resolveOutcomeProduct creates on first use.
 */
async function routeIssueProduct(
  db: PoolClient,
  vendor: string,
  project: string,
  identityProductId: string | null,
  cache: Map<string, string>,
): Promise<string> {
  if (identityProductId !== null) return identityProductId;
  const routeKey = `route:${vendor}:${project}`;
  const cached = cache.get(routeKey);
  if (cached) return cached;
  const { rows } = await db.query(
    `SELECT r.product_id FROM issue_project_routes r
     JOIN products p ON p.id = r.product_id AND p.archived_at IS NULL
     WHERE r.vendor = $1 AND r.project = $2`,
    [vendor, project],
  );
  if (rows.length > 0) {
    cache.set(routeKey, rows[0].product_id as string);
    return rows[0].product_id as string;
  }
  return resolveOutcomeProduct(db, ISSUE_OUTCOME_KIND, cache);
}

async function emitIssueOutcome(
  db: PoolClient,
  issue: { sourceRef: string },
  ts: string,
  productId: string,
  identity: { id: string; personId: string | null } | null,
): Promise<void> {
  // reverted_at deliberately stays out of the update: a flip survives every
  // later restatement of the same success (same rule as PR outcomes).
  await db.query(
    `INSERT INTO outcomes
       (ts, product_id, person_id, kind, source_ref, identity_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (kind, source_ref) DO UPDATE SET
       ts = EXCLUDED.ts,
       product_id = EXCLUDED.product_id,
       person_id = EXCLUDED.person_id,
       identity_id = EXCLUDED.identity_id`,
    [ts, productId, identity?.personId ?? null, ISSUE_OUTCOME_KIND, issue.sourceRef, identity?.id ?? null],
  );
}

/**
 * Process one issue from a sync page: evaluate, write the tracking row, and
 * emit/flip its outcome. Returns rows written (the tracking upsert, plus an
 * emitted outcome or an applied flip). Idempotent: a re-pull restates the
 * same state in place.
 */
export async function upsertTrackedIssue(
  db: PoolClient,
  vendor: string,
  issue: IssueInput,
  resolved: CreditedIdentity | null,
  windowDays: number,
  now: Date,
  cache: Map<string, string>,
): Promise<number> {
  const state = evaluateIssue(
    {
      submittedAt: issue.submittedAt ?? null,
      doneAt: issue.doneAt ?? null,
      regressedAt: issue.regressedAt ?? null,
    },
    windowDays,
    now,
  );
  // Never submitted, never done: nothing to track yet.
  if (state.status === "none") return 0;

  const productId = await routeIssueProduct(
    db,
    vendor,
    issue.project,
    resolved?.productId ?? null,
    cache,
  );
  await db.query(
    `INSERT INTO issue_tracking
       (vendor, source_ref, issue_key, title, project, identity_id,
        product_id, anchor_ts, window_end, status, decided_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (vendor, source_ref) DO UPDATE SET
       issue_key = EXCLUDED.issue_key,
       title = EXCLUDED.title,
       project = EXCLUDED.project,
       identity_id = EXCLUDED.identity_id,
       product_id = EXCLUDED.product_id,
       anchor_ts = EXCLUDED.anchor_ts,
       window_end = EXCLUDED.window_end,
       status = EXCLUDED.status,
       decided_at = EXCLUDED.decided_at,
       updated_at = now()`,
    [
      vendor,
      issue.sourceRef,
      issue.key,
      issue.title ?? null,
      issue.project,
      resolved?.id ?? null,
      productId,
      state.anchorTs,
      state.windowEnd,
      state.status,
      state.status === "pending" ? null : state.decidedAt,
    ],
  );

  if (state.status === "success") {
    await emitIssueOutcome(db, issue, state.decidedAt, productId, resolved);
    return 2;
  }
  if (state.status === "fail") {
    // Flip a success counted earlier (done, then regressed inside the
    // window). reverted_at IS NULL keeps re-delivered regressions idempotent.
    const { rowCount } = await db.query(
      `UPDATE outcomes
       SET reverted_at = $3::timestamptz, revert_source_ref = $2 || '#regressed'
       WHERE kind = $1 AND source_ref = $2 AND reverted_at IS NULL`,
      [ISSUE_OUTCOME_KIND, issue.sourceRef, state.decidedAt],
    );
    return 1 + (rowCount ?? 0);
  }
  return 1;
}

/**
 * Promote pending issues whose window passed without a regression - the
 * "window passes quietly" success for issues no sync window will ever see
 * again. Runs at the end of every successful sync, AFTER the pages: any
 * regression that happened inside the window was just re-pulled and already
 * failed its row. Routing is re-resolved at emission, so a project mapped
 * (or an agent tag pointed at an ROI) since the issue went pending lands on
 * the right row.
 */
export async function promoteDueIssues(
  db: PoolClient,
  vendor: string,
  now: Date,
  cache: Map<string, string>,
): Promise<number> {
  const { rows } = await db.query(
    `SELECT t.source_ref AS "sourceRef", t.project, t.window_end AS "windowEnd",
            t.identity_id AS "identityId", i.person_id AS "personId",
            i.product_id AS "identityProductId"
     FROM issue_tracking t
     LEFT JOIN identities i ON i.id = t.identity_id
     WHERE t.vendor = $1 AND t.status = 'pending' AND t.window_end <= $2
     ORDER BY t.window_end
     FOR UPDATE OF t`,
    [vendor, now],
  );
  for (const row of rows) {
    const windowEnd = new Date(row.windowEnd as Date | string).toISOString();
    const productId = await routeIssueProduct(
      db,
      vendor,
      row.project as string,
      (row.identityProductId as string | null) ?? null,
      cache,
    );
    await emitIssueOutcome(
      db,
      { sourceRef: row.sourceRef as string },
      windowEnd,
      productId,
      row.identityId
        ? { id: row.identityId as string, personId: row.personId as string | null }
        : null,
    );
    await db.query(
      `UPDATE issue_tracking
       SET status = 'success', decided_at = window_end, product_id = $3,
           updated_at = now()
       WHERE vendor = $1 AND source_ref = $2`,
      [vendor, row.sourceRef, productId],
    );
  }
  return rows.length;
}

export interface IssueProjectRoute {
  project: string;
  productId: string;
  productName: string;
}

export async function listIssueProjectRoutes(
  vendor: string,
  db: Db,
): Promise<IssueProjectRoute[]> {
  const { rows } = await db.query(
    `SELECT r.project, r.product_id AS "productId", p.name AS "productName"
     FROM issue_project_routes r
     JOIN products p ON p.id = r.product_id
     WHERE r.vendor = $1 ORDER BY r.project`,
    [vendor],
  );
  return rows as IssueProjectRoute[];
}

/**
 * Set (or clear, productId null) one project's ROI mapping, retroactively:
 * the project's tracked issues and counted successes move to the new row -
 * the ledger's standard retroactivity rule - except issues an identity tag
 * already routes (layer 1 wins). Returns the outcome day span the caller
 * must recompute rollups for.
 */
export async function setIssueProjectRoute(
  db: PoolClient,
  vendor: string,
  project: string,
  productId: string | null,
): Promise<{ outcomes: number; from: string | null; to: string | null }> {
  if (productId === null) {
    await db.query(
      "DELETE FROM issue_project_routes WHERE vendor = $1 AND project = $2",
      [vendor, project],
    );
  } else {
    const { rows } = await db.query(
      "SELECT 1 FROM products WHERE id = $1 AND archived_at IS NULL",
      [productId],
    );
    if (rows.length === 0) throw new Error("product not found");
    await db.query(
      `INSERT INTO issue_project_routes (vendor, project, product_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (vendor, project) DO UPDATE SET
         product_id = EXCLUDED.product_id, updated_at = now()`,
      [vendor, project, productId],
    );
  }
  // Cleared mappings fall back to the default row - resolve it now so the
  // re-route below has a concrete target either way.
  const cache = new Map<string, string>();
  const target =
    productId ?? (await resolveOutcomeProduct(db, ISSUE_OUTCOME_KIND, cache));

  // Layer 1 (identity tag routing) wins: only re-route issues whose credited
  // identity is not already routed to a product.
  const { rows: moved } = await db.query(
    `UPDATE issue_tracking t
     SET product_id = $3, updated_at = now()
     WHERE t.vendor = $1 AND t.project = $2 AND t.product_id IS DISTINCT FROM $3
       AND NOT EXISTS (
         SELECT 1 FROM identities i
         WHERE i.id = t.identity_id AND i.product_id IS NOT NULL
       )
     RETURNING t.source_ref AS "sourceRef"`,
    [vendor, project, target],
  );
  if (moved.length === 0) return { outcomes: 0, from: null, to: null };

  const refs = moved.map((r) => r.sourceRef as string);
  const { rows: span } = await db.query(
    `WITH touched AS (
       UPDATE outcomes SET product_id = $2
       WHERE kind = $1 AND source_ref = ANY ($3) AND product_id IS DISTINCT FROM $2
       RETURNING (ts AT TIME ZONE 'UTC')::date AS day
     )
     SELECT count(*)::int AS n, min(day)::text AS from, max(day)::text AS to
     FROM touched`,
    [ISSUE_OUTCOME_KIND, target, refs],
  );
  return {
    outcomes: Number(span[0].n),
    from: span[0].from as string | null,
    to: span[0].to as string | null,
  };
}

export interface TrackedIssueRow {
  vendor: string;
  sourceRef: string;
  key: string;
  title: string | null;
  project: string;
  status: "pending" | "success" | "fail";
  anchorTs: string;
  windowEnd: string;
  decidedAt: string | null;
  personName: string | null;
  personEmail: string | null;
  identityName: string | null;
}

/**
 * The ticket list behind a product's issue successes (the ROI detail drill):
 * pending rows always (they are the current state), decided rows by decided
 * day inside the range - the same day their outcome counts on.
 */
export async function listTrackedIssues(
  productId: string,
  range: { from?: string; to?: string },
  db: Db,
): Promise<TrackedIssueRow[]> {
  const { rows } = await db.query(
    `SELECT t.vendor, t.source_ref AS "sourceRef", t.issue_key AS key, t.title,
            t.project, t.status, t.anchor_ts AS "anchorTs",
            t.window_end AS "windowEnd", t.decided_at AS "decidedAt",
            p.name AS "personName", p.email AS "personEmail",
            i.display_name AS "identityName"
     FROM issue_tracking t
     LEFT JOIN identities i ON i.id = t.identity_id
     LEFT JOIN people p ON p.id = i.person_id
     WHERE t.product_id = $1
       AND (t.status = 'pending' OR (
         ($2::date IS NULL OR (t.decided_at AT TIME ZONE 'UTC')::date >= $2)
         AND ($3::date IS NULL OR (t.decided_at AT TIME ZONE 'UTC')::date <= $3)))
     ORDER BY COALESCE(t.decided_at, t.anchor_ts) DESC, t.issue_key`,
    [productId, range.from ?? null, range.to ?? null],
  );
  return rows.map((row) => ({
    ...(row as unknown as TrackedIssueRow),
    anchorTs: new Date(row.anchorTs as string).toISOString(),
    windowEnd: new Date(row.windowEnd as string).toISOString(),
    decidedAt: row.decidedAt ? new Date(row.decidedAt as string).toISOString() : null,
  }));
}
