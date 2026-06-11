import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { getPool } from "../db";
import { logger } from "../logger";
import { buildContext, connectedRow, getConnectorConfig } from "./connect";
import { getConnector } from "./registry";
import type {
  Connector,
  ConnectorPage,
  FactInput,
  IdentityInput,
  MetricInput,
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

function identityMapKey(externalId: string, kind: string): string {
  return `${kind}:${externalId}`;
}

/**
 * Upsert a described identity. Tags overwrite (a key rename re-tags);
 * email/display name never regress to NULL; person_id keeps an existing
 * (possibly human-made) mapping, else auto-matches by email (spec 5).
 */
async function upsertIdentity(
  db: PoolClient,
  vendor: string,
  identity: IdentityInput,
): Promise<{ id: string; personId: string | null }> {
  const { rows } = await db.query(
    `INSERT INTO identities (vendor, external_id, kind, email, display_name, tags, person_id)
     VALUES ($1, $2, $3, $4, $5, $6,
       (SELECT id FROM people WHERE lower(email) = lower($4) LIMIT 1))
     ON CONFLICT (vendor, external_id, kind) DO UPDATE SET
       email = COALESCE(EXCLUDED.email, identities.email),
       display_name = COALESCE(EXCLUDED.display_name, identities.display_name),
       tags = EXCLUDED.tags,
       person_id = COALESCE(
         identities.person_id,
         (SELECT id FROM people WHERE lower(email) = lower(EXCLUDED.email) LIMIT 1)
       ),
       updated_at = now()
     RETURNING id, person_id`,
    [
      vendor,
      identity.externalId,
      identity.kind,
      identity.email ?? null,
      identity.displayName ?? null,
      identity.tags ?? [],
    ],
  );
  return { id: rows[0].id, personId: rows[0].person_id };
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
): Promise<{ id: string; personId: string | null }> {
  const { rows } = await db.query(
    `INSERT INTO identities (vendor, external_id, kind)
     VALUES ($1, $2, $3)
     ON CONFLICT (vendor, external_id, kind) DO UPDATE SET updated_at = identities.updated_at
     RETURNING id, person_id`,
    [vendor, ref.externalId, ref.kind],
  );
  return { id: rows[0].id, personId: rows[0].person_id };
}

/** Upsert one page and advance the cursor, atomically. Returns rows (facts + metrics) written. */
async function commitPage(
  db: PoolClient,
  runId: number,
  vendor: string,
  page: ConnectorPage,
  cursor: SyncCursor,
): Promise<number> {
  await db.query("BEGIN");
  try {
    const idMap = new Map<string, { id: string; personId: string | null }>();
    for (const identity of page.identities) {
      idMap.set(
        identityMapKey(identity.externalId, identity.kind),
        await upsertIdentity(db, vendor, identity),
      );
    }

    for (const fact of page.facts) {
      validateFact(fact);
      let resolved: { id: string; personId: string | null } | null = null;
      if (fact.identity) {
        const key = identityMapKey(fact.identity.externalId, fact.identity.kind);
        resolved = idMap.get(key) ?? (await ensureIdentity(db, vendor, fact.identity));
        idMap.set(key, resolved);
      }
      // person_id NULL = the visible Unassigned bucket. product_id is left
      // alone: tag->product routing owns it, and re-pulls must not clear it.
      await db.query(
        `INSERT INTO spend_facts
           (day, person_id, vendor, model, tokens, amount_cents, currency,
            cost_basis, source_ref, identity_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (vendor, source_ref) DO UPDATE SET
           day = EXCLUDED.day,
           person_id = EXCLUDED.person_id,
           model = EXCLUDED.model,
           tokens = EXCLUDED.tokens,
           amount_cents = EXCLUDED.amount_cents,
           currency = EXCLUDED.currency,
           cost_basis = EXCLUDED.cost_basis,
           identity_id = EXCLUDED.identity_id`,
        [
          fact.day,
          resolved?.personId ?? null,
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
      let resolved: { id: string; personId: string | null } | null = null;
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

    const rowCount = page.facts.length + metrics.length;
    await db.query(
      `UPDATE sync_runs
       SET cursor = $2, rows_synced = COALESCE(rows_synced, 0) + $3
       WHERE id = $1`,
      [runId, JSON.stringify(cursor), rowCount],
    );
    await db.query("COMMIT");
    return rowCount;
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
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
        rowsSynced += await commitPage(client, runId, vendor, page, cursor);
        if (done) break;
        pageToken = page.nextPageToken;
      }

      await client.query(
        "UPDATE sync_runs SET status = 'success', finished_at = now() WHERE id = $1",
        [runId],
      );
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
