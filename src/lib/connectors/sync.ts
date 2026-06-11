import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { getPool } from "../db";
import { trueUpAfterSync } from "../invoices";
import { logger, type Logger } from "../logger";
import { getSetting } from "../settings";
import { applyTagRouting } from "../tags";
import { buildContext, connectedRow, getConnectorConfig } from "./connect";
import { getConnector } from "./registry";
import type {
  Connector,
  ConnectorPage,
  FactInput,
  IdentityInput,
  MetricInput,
  OutcomeInput,
  RevertInput,
  SyncCursor,
  SyncWindow,
} from "./types";

/**
 * The sync engine. One runSync = one sync_runs row. The framework owns the
 * cursor (spec 5):
 *
 * - First sync after connect: full backfill, today back to the vendor's
 *   history limit.
 * - Every later sync: incremental from the watermark, widened to re-pull
 *   the trailing 7 days - vendors restate data (spec 4).
 * - Each page commits atomically WITH its cursor advance, so a crash or
 *   vendor error mid-sync loses nothing: the next run resumes the same
 *   window at the exact failed page.
 * - Upserts key on (vendor, source_ref) for facts and
 *   (vendor, external_id, kind) for identities - a row is never duplicated,
 *   re-pulls restate in place.
 * - Vendor errors are stored verbatim in sync_runs.error.
 * - A per-connector Postgres advisory lock keeps runs from overlapping.
 */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Re-pull window: every sync re-reads this many trailing days (spec 4). */
export const REPULL_DAYS = 7;

export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  return utcDay(new Date(t + days * 86_400_000));
}

/**
 * Split a sync window into <=days-day slices, for vendors that cap a report
 * request's window (Cursor: 30 days; GitHub search: chunked the same way to
 * stay under the result cap).
 */
export function chunkWindows(window: SyncWindow, days: number): SyncWindow[] {
  const chunks: SyncWindow[] = [];
  let since = window.since;
  while (since <= window.until) {
    const until = addDays(since, days - 1);
    chunks.push({ since, until: until <= window.until ? until : window.until });
    since = addDays(since, days);
  }
  return chunks;
}

function minDay(a: string, b: string): string {
  return a <= b ? a : b;
}

function maxDay(a: string, b: string): string {
  return a >= b ? a : b;
}

function lockKey(vendor: string): number {
  // Same scheme as the migration lock: first 8 hex chars of a sha256.
  return parseInt(
    createHash("sha256").update(`ai-pnl:sync:${vendor}`).digest("hex").slice(0, 8),
    16,
  );
}

function parseCursor(raw: string | null): SyncCursor {
  if (!raw) return { watermark: null };
  try {
    const parsed = JSON.parse(raw) as SyncCursor;
    return { watermark: parsed.watermark ?? null, inProgress: parsed.inProgress };
  } catch {
    return { watermark: null };
  }
}

export interface SyncOpts {
  pool?: Pool;
  fetch?: typeof fetch;
  /** Clock override (tests). Defaults to the real now. */
  now?: Date;
  /** Secrets-key directory override (tests). */
  dataDir?: string;
}

export interface SyncResult {
  vendor: string;
  /** True when another run holds the lock; nothing was done. */
  skipped: boolean;
  runId?: number;
  status?: "success" | "error";
  window?: SyncWindow;
  rowsSynced?: number;
  error?: string;
}

interface LastRun {
  id: number;
  status: string;
  cursor: SyncCursor;
}

async function latestRun(db: PoolClient, vendor: string): Promise<LastRun | null> {
  const { rows } = await db.query(
    `SELECT id, status, cursor FROM sync_runs
     WHERE connector = $1 ORDER BY started_at DESC, id DESC LIMIT 1`,
    [vendor],
  );
  if (rows.length === 0) return null;
  return {
    id: Number(rows[0].id),
    status: rows[0].status as string,
    cursor: parseCursor(rows[0].cursor as string | null),
  };
}

function validateFact(fact: FactInput): void {
  if (!DAY_RE.test(fact.day)) {
    throw new Error(`connector emitted a bad day ${JSON.stringify(fact.day)}; want YYYY-MM-DD`);
  }
  if (!/^[A-Z]{3}$/.test(fact.currency)) {
    throw new Error(`connector emitted a bad currency ${JSON.stringify(fact.currency)}`);
  }
  if (!Number.isInteger(fact.amountCents)) {
    throw new Error(`connector emitted a non-integer amountCents for ${fact.sourceRef}`);
  }
  if (!fact.sourceRef) {
    throw new Error("connector emitted a fact without a sourceRef");
  }
}

function validateMetric(metric: MetricInput): void {
  if (!DAY_RE.test(metric.day)) {
    throw new Error(
      `connector emitted a bad metric day ${JSON.stringify(metric.day)}; want YYYY-MM-DD`,
    );
  }
  if (!metric.metric) {
    throw new Error("connector emitted a metric without a name");
  }
  if (!Number.isInteger(metric.value)) {
    throw new Error(
      `connector emitted a non-integer value for metric ${metric.metric} (${metric.sourceRef})`,
    );
  }
  if (!metric.sourceRef) {
    throw new Error("connector emitted a metric without a sourceRef");
  }
}

function validTs(ts: unknown): boolean {
  return typeof ts === "string" && Number.isFinite(Date.parse(ts));
}

function validateOutcome(outcome: OutcomeInput): void {
  if (!validTs(outcome.ts)) {
    throw new Error(
      `connector emitted a bad outcome ts ${JSON.stringify(outcome.ts)} (${outcome.sourceRef})`,
    );
  }
  if (!outcome.kind) {
    throw new Error("connector emitted an outcome without a kind");
  }
  if (!outcome.sourceRef) {
    throw new Error("connector emitted an outcome without a sourceRef");
  }
  if ((outcome.valueCents === undefined) !== (outcome.currency === undefined)) {
    throw new Error(
      `connector emitted an outcome with value/currency mismatch (${outcome.sourceRef})`,
    );
  }
  if (outcome.valueCents !== undefined && !Number.isInteger(outcome.valueCents)) {
    throw new Error(
      `connector emitted a non-integer outcome value for ${outcome.sourceRef}`,
    );
  }
}

function validateRevert(revert: RevertInput): void {
  if (!validTs(revert.ts)) {
    throw new Error(
      `connector emitted a bad revert ts ${JSON.stringify(revert.ts)} (${revert.sourceRef})`,
    );
  }
  if (!revert.kind || !revert.sourceRef) {
    throw new Error("connector emitted a revert without a kind or sourceRef");
  }
  if ((revert.targetRef === undefined) === (revert.targetSha === undefined)) {
    throw new Error(
      `connector revert ${revert.sourceRef} must carry exactly one of targetRef/targetSha`,
    );
  }
}

/**
 * Built-in default products per outcome kind (spec 7: "GitHub merged PRs as
 * the built-in default for coding"). Created on first use when no product
 * with that outcome_kind exists, so connector outcomes always have a cost
 * center to land in.
 */
const DEFAULT_OUTCOME_PRODUCTS: Record<string, string> = {
  github_pr: "Coding",
};

/** Resolve the product an outcome kind routes to (oldest live match wins). */
async function resolveOutcomeProduct(
  db: PoolClient,
  kind: string,
  cache: Map<string, string>,
): Promise<string> {
  const cached = cache.get(kind);
  if (cached) return cached;
  const select = `SELECT id FROM products
                  WHERE outcome_kind = $1 AND archived_at IS NULL
                  ORDER BY created_at, id LIMIT 1`;
  let { rows } = await db.query(select, [kind]);
  if (rows.length === 0) {
    const name = DEFAULT_OUTCOME_PRODUCTS[kind];
    if (!name) {
      throw new Error(`no product with outcome_kind ${kind} to route outcomes to`);
    }
    await db.query(
      `INSERT INTO products (name, attribution, outcome_kind)
       VALUES ($1, 'connector', $2) ON CONFLICT DO NOTHING`,
      [name, kind],
    );
    ({ rows } = await db.query(select, [kind]));
    if (rows.length === 0) {
      throw new Error(
        `cannot create the default "${name}" product for outcome_kind ${kind}: the name is taken`,
      );
    }
  }
  cache.set(kind, rows[0].id as string);
  return rows[0].id as string;
}

function identityMapKey(externalId: string, kind: string): string {
  return `${kind}:${externalId}`;
}

interface ResolvedIdentity {
  id: string;
  personId: string | null;
  productId: string | null;
}

/**
 * Auto-match by email, case-insensitive (spec 5). Resolve's remembered
 * aliases come first (person_emails rows are explicit human decisions -
 * confirms and merges, remembered forever), then the people roster, skipping
 * anyone merged into someone else.
 */
function personByEmailSql(emailExpr: string): string {
  return `COALESCE(
    (SELECT pe.person_id FROM person_emails pe WHERE pe.email = lower(${emailExpr})),
    (SELECT p.id FROM people p
     WHERE lower(p.email) = lower(${emailExpr}) AND p.merged_into IS NULL
     LIMIT 1)
  )`;
}

/**
 * Upsert a described identity. Tags overwrite (a key rename re-tags) while
 * manual_tags survive; email/display name never regress to NULL; person_id
 * keeps an existing (possibly human-made) mapping, else auto-matches by
 * email (spec 5) - except for identities marked "not a person", whose
 * person_id is never re-filled.
 */
async function upsertIdentity(
  db: PoolClient,
  vendor: string,
  identity: IdentityInput,
): Promise<ResolvedIdentity> {
  const { rows } = await db.query(
    `INSERT INTO identities (vendor, external_id, kind, email, display_name, tags, person_id)
     VALUES ($1, $2, $3, $4, $5, $6, ${personByEmailSql("$4")})
     ON CONFLICT (vendor, external_id, kind) DO UPDATE SET
       email = COALESCE(EXCLUDED.email, identities.email),
       display_name = COALESCE(EXCLUDED.display_name, identities.display_name),
       tags = EXCLUDED.tags,
       person_id = CASE
         WHEN identities.not_person THEN NULL
         ELSE COALESCE(
           identities.person_id,
           ${personByEmailSql("COALESCE(EXCLUDED.email, identities.email)")}
         )
       END,
       updated_at = now()
     RETURNING id, person_id, product_id`,
    [
      vendor,
      identity.externalId,
      identity.kind,
      identity.email ?? null,
      identity.displayName ?? null,
      identity.tags ?? [],
    ],
  );
  return { id: rows[0].id, personId: rows[0].person_id, productId: rows[0].product_id };
}

/**
 * An identity referenced by a fact but not described in the page: keys
 * people create on their own are auto-discovered (spec 8). Creates a stub
 * row if needed, touches nothing on an existing one.
 */
async function ensureIdentity(
  db: PoolClient,
  vendor: string,
  ref: { externalId: string; kind: string },
): Promise<ResolvedIdentity> {
  const { rows } = await db.query(
    `INSERT INTO identities (vendor, external_id, kind)
     VALUES ($1, $2, $3)
     ON CONFLICT (vendor, external_id, kind) DO UPDATE SET updated_at = identities.updated_at
     RETURNING id, person_id, product_id`,
    [vendor, ref.externalId, ref.kind],
  );
  return { id: rows[0].id, personId: rows[0].person_id, productId: rows[0].product_id };
}

/**
 * A match re-attributes the identity's FULL history, not just future spend
 * (spec 4). Auto-matches that land late - the person was imported after some
 * of the identity's history had synced (spec 8: self-created keys are
 * auto-discovered) - pull that history in here. Only rows that disagree with
 * the identity's current mapping are touched, so this is an idempotent
 * consistency sweep: facts/metrics/outcomes always mirror their identity.
 */
async function reattributeIdentityHistory(
  db: PoolClient,
  resolved: ResolvedIdentity,
): Promise<void> {
  await db.query(
    `UPDATE spend_facts
     SET person_id = $2, product_id = COALESCE($3, product_id)
     WHERE identity_id = $1
       AND (person_id IS DISTINCT FROM $2
         OR ($3::uuid IS NOT NULL AND product_id IS DISTINCT FROM $3))`,
    [resolved.id, resolved.personId, resolved.productId],
  );
  await db.query(
    `UPDATE usage_metrics SET person_id = $2
     WHERE identity_id = $1 AND person_id IS DISTINCT FROM $2`,
    [resolved.id, resolved.personId],
  );
  await db.query(
    `UPDATE outcomes SET person_id = $2
     WHERE identity_id = $1 AND person_id IS DISTINCT FROM $2`,
    [resolved.id, resolved.personId],
  );
}

interface DaySpan {
  min: string;
  max: string;
}

interface PageCommit {
  rows: number;
  /** Day span of the facts this page wrote, for the invoice true-up. */
  factSpan: DaySpan | null;
}

/**
 * Upsert one page and advance the cursor, atomically. Returns rows written
 * (facts + metrics + outcomes + revert flips applied).
 */
async function commitPage(
  db: PoolClient,
  runId: number,
  vendor: string,
  page: ConnectorPage,
  cursor: SyncCursor,
): Promise<PageCommit> {
  await db.query("BEGIN");
  try {
    const idMap = new Map<string, ResolvedIdentity>();
    const described: ResolvedIdentity[] = [];
    for (const identity of page.identities) {
      const resolved = await upsertIdentity(db, vendor, identity);
      idMap.set(identityMapKey(identity.externalId, identity.kind), resolved);
      described.push(resolved);
    }

    // Tag -> product routing (spec 7b): a tag pointing at a product routes
    // every key carrying it - burn lands on the product, never a person
    // (the agent convention). Applied before facts land, so this page's
    // rows carry the routing, and before the history sweep, so a key that
    // just gained a routed tag (rename, new key) re-routes retroactively.
    if (described.length > 0) {
      const routed = await applyTagRouting(db, {
        identityIds: described.map((r) => r.id),
      });
      const byId = new Map(described.map((r) => [r.id, r]));
      for (const r of routed) {
        const resolved = byId.get(r.id)!;
        resolved.personId = null;
        resolved.productId = r.productId;
      }
    }

    for (const resolved of described) {
      if (resolved.personId !== null || resolved.productId !== null) {
        // The upsert may have just auto-matched (a person imported after the
        // identity's history synced) or the routing just landed: pull the
        // full history in (spec 4).
        await reattributeIdentityHistory(db, resolved);
      }
    }

    for (const fact of page.facts) {
      validateFact(fact);
      let resolved: ResolvedIdentity | null = null;
      if (fact.identity) {
        const key = identityMapKey(fact.identity.externalId, fact.identity.kind);
        resolved = idMap.get(key) ?? (await ensureIdentity(db, vendor, fact.identity));
        idMap.set(key, resolved);
      }
      // person_id NULL = the visible Unassigned bucket. product_id follows
      // the identity's routing (a key routes to at most one product, spec
      // 7b); an identity with no routing never clears a fact's product.
      await db.query(
        `INSERT INTO spend_facts
           (day, person_id, product_id, vendor, model, tokens, amount_cents,
            currency, cost_basis, source_ref, identity_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (vendor, source_ref) DO UPDATE SET
           day = EXCLUDED.day,
           person_id = EXCLUDED.person_id,
           product_id = COALESCE(EXCLUDED.product_id, spend_facts.product_id),
           model = EXCLUDED.model,
           tokens = EXCLUDED.tokens,
           amount_cents = EXCLUDED.amount_cents,
           currency = EXCLUDED.currency,
           cost_basis = EXCLUDED.cost_basis,
           identity_id = EXCLUDED.identity_id`,
        [
          fact.day,
          resolved?.personId ?? null,
          resolved?.productId ?? null,
          vendor,
          fact.model ?? null,
          fact.tokens ?? 0,
          fact.amountCents,
          fact.currency,
          fact.costBasis,
          fact.sourceRef,
          resolved?.id ?? null,
        ],
      );
    }

    // Non-spend usage counters (Claude Code analytics, ...). Same identity
    // resolution and idempotent-upsert rules as facts, separate table so the
    // spend ledger never double counts.
    const metrics = page.metrics ?? [];
    for (const metric of metrics) {
      validateMetric(metric);
      let resolved: ResolvedIdentity | null = null;
      if (metric.identity) {
        const key = identityMapKey(metric.identity.externalId, metric.identity.kind);
        resolved = idMap.get(key) ?? (await ensureIdentity(db, vendor, metric.identity));
        idMap.set(key, resolved);
      }
      await db.query(
        `INSERT INTO usage_metrics (day, vendor, metric, value, person_id, identity_id, source_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (vendor, source_ref, metric) DO UPDATE SET
           day = EXCLUDED.day,
           value = EXCLUDED.value,
           person_id = EXCLUDED.person_id,
           identity_id = EXCLUDED.identity_id`,
        [
          metric.day,
          vendor,
          metric.metric,
          metric.value,
          resolved?.personId ?? null,
          resolved?.id ?? null,
          metric.sourceRef,
        ],
      );
    }

    // Outcomes (merged PRs, ...): same identity resolution as facts, routed
    // to the product whose outcome_kind matches. (kind, source_ref) upserts,
    // so re-pulls restate in place. reverted_at is deliberately NOT in the
    // update: a flip survives every later re-pull of the merged PR.
    const outcomes = page.outcomes ?? [];
    const productCache = new Map<string, string>();
    for (const outcome of outcomes) {
      validateOutcome(outcome);
      const productId = await resolveOutcomeProduct(db, outcome.kind, productCache);
      let resolved: ResolvedIdentity | null = null;
      if (outcome.identity) {
        const key = identityMapKey(outcome.identity.externalId, outcome.identity.kind);
        resolved = idMap.get(key) ?? (await ensureIdentity(db, vendor, outcome.identity));
        idMap.set(key, resolved);
      }
      await db.query(
        `INSERT INTO outcomes
           (ts, product_id, person_id, kind, value_cents, currency,
            source_ref, tools, meta, identity_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
         ON CONFLICT (kind, source_ref) DO UPDATE SET
           ts = EXCLUDED.ts,
           product_id = EXCLUDED.product_id,
           person_id = EXCLUDED.person_id,
           value_cents = EXCLUDED.value_cents,
           currency = EXCLUDED.currency,
           tools = EXCLUDED.tools,
           meta = EXCLUDED.meta,
           identity_id = EXCLUDED.identity_id`,
        [
          outcome.ts,
          productId,
          resolved?.personId ?? null,
          outcome.kind,
          outcome.valueCents ?? null,
          outcome.currency ?? null,
          outcome.sourceRef,
          outcome.tools ?? [],
          JSON.stringify(outcome.shas?.length ? { shas: outcome.shas } : {}),
          resolved?.id ?? null,
        ],
      );
    }

    // Reverts: flip the referenced outcome when the revert lands within
    // revert_window_days of it - after the window the outcome is final
    // (spec 5). The UPDATE runs against the whole ledger, so a revert synced
    // weeks after its target (long out of any re-pull window) still lands.
    // reverted_at IS NULL keeps re-delivered reverts idempotent, and the
    // source_ref guard keeps a record from ever flipping itself.
    const reverts = page.reverts ?? [];
    let flips = 0;
    if (reverts.length > 0) {
      const windowDays = await getSetting("revert_window_days", db);
      for (const revert of reverts) {
        validateRevert(revert);
        const { rowCount: flipped } = await db.query(
          `UPDATE outcomes
           SET reverted_at = $2::timestamptz, revert_source_ref = $3
           WHERE kind = $1 AND reverted_at IS NULL AND source_ref <> $3
             AND (($4::text IS NOT NULL AND source_ref = $4)
               OR ($5::text IS NOT NULL AND meta->'shas' @> to_jsonb($5::text)))
             AND $2::timestamptz >= ts
             AND $2::timestamptz <= ts + make_interval(days => $6::int)`,
          [
            revert.kind,
            revert.ts,
            revert.sourceRef,
            revert.targetRef ?? null,
            revert.targetSha ?? null,
            windowDays,
          ],
        );
        flips += flipped ?? 0;
      }
    }

    const rowCount = page.facts.length + metrics.length + outcomes.length + flips;
    await db.query(
      `UPDATE sync_runs
       SET cursor = $2, rows_synced = COALESCE(rows_synced, 0) + $3
       WHERE id = $1`,
      [runId, JSON.stringify(cursor), rowCount],
    );
    await db.query("COMMIT");
    let factSpan: DaySpan | null = null;
    for (const fact of page.facts) {
      factSpan = factSpan
        ? { min: minDay(factSpan.min, fact.day), max: maxDay(factSpan.max, fact.day) }
        : { min: fact.day, max: fact.day };
    }
    return { rows: rowCount, factSpan };
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

/**
 * Vendors restate data, and restated facts change the drift against an
 * imported invoice: re-true every invoiced month this sync wrote into
 * (spec 4: invoices true estimated up to invoiced). A failure here never
 * fails the sync - the drift report recomputes the same numbers live and
 * refuses loudly on its own.
 */
async function trueUpSafely(
  vendor: string,
  span: DaySpan | null,
  pool: Pool,
  log: Logger,
): Promise<void> {
  if (!span) return;
  try {
    const { days } = await trueUpAfterSync(vendor, span, pool);
    if (days.length > 0) log.info("invoices trued up after sync", { days });
  } catch (err) {
    log.error("invoice true-up after sync failed", { error: err });
  }
}

function computeWindow(
  connector: Connector,
  watermark: string | null,
  today: string,
): SyncWindow {
  const historyStart = addDays(today, -connector.historyLimitDays);
  if (watermark === null) {
    // First sync: full backfill to the vendor's history limit.
    return { since: historyStart, until: today };
  }
  // Incremental from the watermark, widened to re-pull the trailing 7 days;
  // never past what the vendor can still serve.
  const since = maxDay(minDay(watermark, addDays(today, -REPULL_DAYS)), historyStart);
  return { since, until: today };
}

export async function runSync(vendor: string, opts: SyncOpts = {}): Promise<SyncResult> {
  const connector = getConnector(vendor);
  if (!connector) throw new Error(`unknown connector: ${vendor}`);
  const pool = opts.pool ?? getPool();
  const log = logger.child({ connector: vendor });

  const client = await pool.connect();
  let locked = false;
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [
      lockKey(vendor),
    ]);
    if (!lock.rows[0].ok) {
      log.info("sync already running, skipped");
      return { vendor, skipped: true };
    }
    locked = true;

    const connected = await connectedRow(vendor, client);
    if (!connected) throw new Error(`connector ${vendor} is not connected`);
    const config = await getConnectorConfig(vendor, { db: client, dataDir: opts.dataDir });
    if (config === null) throw new Error(`connector ${vendor} has no stored config`);

    const last = await latestRun(client, vendor);
    if (last && last.status === "running") {
      // We hold the lock, so nobody is actually running it: the process
      // died mid-sync. Mark it and resume from its committed cursor.
      await client.query(
        `UPDATE sync_runs SET status = 'error', error = $2, finished_at = now()
         WHERE id = $1`,
        [last.id, "sync process died mid-run"],
      );
    }

    const today = utcDay(opts.now ?? new Date());
    const prevWatermark = last?.cursor.watermark ?? null;
    // Resume an interrupted window at its exact page; otherwise open a new one.
    const resume = last?.cursor.inProgress;
    const window: SyncWindow = resume
      ? { since: resume.since, until: resume.until }
      : computeWindow(connector, prevWatermark, today);
    let pageToken: string | null = resume ? resume.pageToken : null;

    const inserted = await client.query(
      `INSERT INTO sync_runs (connector, status, cursor, rows_synced)
       VALUES ($1, 'running', $2, 0) RETURNING id`,
      [
        vendor,
        JSON.stringify({
          watermark: prevWatermark,
          inProgress: { since: window.since, until: window.until, pageToken },
        } satisfies SyncCursor),
      ],
    );
    const runId = Number(inserted.rows[0].id);
    log.info(resume ? "sync resumed" : "sync started", { runId, ...window, pageToken });

    const ctx = buildContext(connector, config, opts.fetch);
    let rowsSynced = 0;
    let factSpan: DaySpan | null = null;
    try {
      for (;;) {
        const page = await connector.fetchPage(ctx, window, pageToken);
        if (page.nextPageToken !== null && page.nextPageToken === pageToken) {
          throw new Error("connector returned the same page token twice");
        }
        const done = page.nextPageToken === null;
        // On the last page the cursor collapses to the new watermark.
        const cursor: SyncCursor = done
          ? { watermark: window.until }
          : {
              watermark: prevWatermark,
              inProgress: { since: window.since, until: window.until, pageToken: page.nextPageToken },
            };
        const committed = await commitPage(client, runId, vendor, page, cursor);
        rowsSynced += committed.rows;
        if (committed.factSpan) {
          factSpan = factSpan
            ? {
                min: minDay(factSpan.min, committed.factSpan.min),
                max: maxDay(factSpan.max, committed.factSpan.max),
              }
            : committed.factSpan;
        }
        if (done) break;
        pageToken = page.nextPageToken;
      }

      await client.query(
        "UPDATE sync_runs SET status = 'success', finished_at = now() WHERE id = $1",
        [runId],
      );
      await trueUpSafely(vendor, factSpan, pool, log);
      log.info("sync finished", { runId, rowsSynced, ...window });
      return { vendor, skipped: false, runId, status: "success", window, rowsSynced };
    } catch (err) {
      // The vendor's error, verbatim. The cursor already points at the
      // failed page (each page committed with its own advance), so the next
      // run resumes exactly there.
      const message = err instanceof Error ? err.message : String(err);
      await client.query(
        "UPDATE sync_runs SET status = 'error', error = $2, finished_at = now() WHERE id = $1",
        [runId, message],
      );
      // Pages committed before the failure still restated facts.
      await trueUpSafely(vendor, factSpan, pool, log);
      log.error("sync failed", { runId, error: err, ...window });
      return { vendor, skipped: false, runId, status: "error", window, rowsSynced, error: message };
    }
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock($1)", [lockKey(vendor)]).catch(() => {});
    }
    client.release();
  }
}
