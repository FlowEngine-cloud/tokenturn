import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { getPool, type Db } from "./db";
import { logger } from "./logger";

/**
 * Daily ECB FX rates into fx_rates (spec section 4: "Daily FX rates (ECB)
 * convert to the org's display currency at rollup; drill-downs show the
 * original").
 *
 * - Source: the ECB's 90-day reference-rate history file. One URL, no auth,
 *   ~100KB. Every fetch upserts the whole window, so weekend/holiday gaps,
 *   missed days and re-runs are all the same idempotent operation. ECB
 *   publishes EUR-based rates (~30 currencies) every business day ~16:00
 *   CET; days with no publication simply have no row - the rollup's FX
 *   lookup ("latest rate on/before the day") covers them. Money older than
 *   the first fetched rate uses the earliest rate after it - the documented
 *   fallback in lib/rollup.ts.
 * - fx_rates stores usd_rate = USD per 1 unit of currency, so EUR-based
 *   input converts as usd_rate(C) = rate(USD) / rate(C), and EUR itself is
 *   rate(USD). USD never needs a row (rate 1).
 * - Every run is recorded in sync_runs under connector 'ecb_fx' - same
 *   health surface as vendor connectors: last sync, rows, the error
 *   verbatim. Parsing is STRICT: any drift in the ECB format fails the run
 *   loudly instead of writing bad rates.
 * - Scheduling: fxTick() runs from the same boot ticker as connector syncs,
 *   fetching every 6 hours (retrying hourly after a failure) - the daily
 *   publication lands the same day it appears.
 */

export const ECB_RATES_URL =
  "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml";
export const FX_CONNECTOR = "ecb_fx";
/** How often a fresh fetch is due. */
export const FX_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** How soon a failed fetch retries. */
export const FX_RETRY_MS = 60 * 60 * 1000;

export interface FxRate {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  currency: string;
  /** USD per 1 unit of currency, as a decimal string. */
  usdRate: string;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_CUBE_RE = /<Cube\s+time="([^"]*)"\s*>([\s\S]*?)<\/Cube>/g;
const RATE_CUBE_RE = /<Cube\s+currency="([^"]*)"\s+rate="([^"]*)"\s*\/>/g;

/**
 * Parse the ECB reference-rate XML into USD-based rows. Throws on any
 * format drift - a changed feed must break the run, never write bad rates.
 */
export function parseEcbRates(xml: string): FxRate[] {
  const rows: FxRate[] = [];
  let days = 0;
  for (const dayMatch of xml.matchAll(DAY_CUBE_RE)) {
    days += 1;
    const [, day, inner] = dayMatch;
    if (!DAY_RE.test(day)) {
      throw new Error(`ECB feed: bad day ${JSON.stringify(day)}`);
    }
    const rates = new Map<string, number>();
    for (const rateMatch of inner.matchAll(RATE_CUBE_RE)) {
      const [, currency, raw] = rateMatch;
      if (!/^[A-Z]{3}$/.test(currency)) {
        throw new Error(`ECB feed: bad currency ${JSON.stringify(currency)} on ${day}`);
      }
      const rate = Number(raw);
      if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error(`ECB feed: bad rate ${JSON.stringify(raw)} for ${currency} on ${day}`);
      }
      rates.set(currency, rate);
    }
    // Every <Cube currency=...> in the block must have parsed - a count
    // mismatch means the format drifted under the regex.
    const declared = (inner.match(/<Cube\b/g) ?? []).length;
    if (declared !== rates.size) {
      throw new Error(`ECB feed: unparseable rate entry on ${day}`);
    }
    const usdPerEur = rates.get("USD");
    if (usdPerEur === undefined) {
      throw new Error(`ECB feed: no USD rate on ${day}`);
    }
    rows.push({ day, currency: "EUR", usdRate: usdPerEur.toFixed(12) });
    for (const [currency, rate] of rates) {
      if (currency === "USD") continue;
      rows.push({ day, currency, usdRate: (usdPerEur / rate).toFixed(12) });
    }
  }
  if (days === 0) {
    throw new Error("ECB feed: no rate days found - format drift?");
  }
  return rows;
}

export interface FxSyncOpts {
  pool?: Pool;
  fetch?: typeof fetch;
}

export interface FxSyncResult {
  /** True when another run holds the lock; nothing was done. */
  skipped: boolean;
  runId?: number;
  status?: "success" | "error";
  /** Rates upserted (days x currencies). */
  rowsSynced?: number;
  /** Most recent rate day in the feed. */
  latestDay?: string;
  error?: string;
}

function lockKey(): number {
  // Same scheme as the sync engine's per-connector lock.
  return parseInt(
    createHash("sha256").update(`ai-pnl:sync:${FX_CONNECTOR}`).digest("hex").slice(0, 8),
    16,
  );
}

/** Fetch the ECB feed and upsert fx_rates, recorded as one sync_runs row. */
export async function syncFxRates(opts: FxSyncOpts = {}): Promise<FxSyncResult> {
  const pool = opts.pool ?? getPool();
  const doFetch = opts.fetch ?? fetch;

  const client = await pool.connect();
  let locked = false;
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [lockKey()]);
    if (!lock.rows[0].ok) {
      logger.info("fx sync already running, skipped");
      return { skipped: true };
    }
    locked = true;

    const inserted = await client.query(
      `INSERT INTO sync_runs (connector, status, rows_synced)
       VALUES ($1, 'running', 0) RETURNING id`,
      [FX_CONNECTOR],
    );
    const runId = Number(inserted.rows[0].id);

    try {
      const res = await doFetch(ECB_RATES_URL);
      if (!res.ok) {
        throw new Error(`ECB returned HTTP ${res.status}`);
      }
      const rates = parseEcbRates(await res.text());
      const latestDay = rates.reduce((max, r) => (r.day > max ? r.day : max), rates[0].day);

      await client.query("BEGIN");
      for (const rate of rates) {
        await client.query(
          `INSERT INTO fx_rates (day, currency, usd_rate)
           VALUES ($1::date, $2, $3::numeric)
           ON CONFLICT (day, currency) DO UPDATE SET usd_rate = EXCLUDED.usd_rate`,
          [rate.day, rate.currency, rate.usdRate],
        );
      }
      await client.query(
        `UPDATE sync_runs
         SET status = 'success', cursor = $2, rows_synced = $3, finished_at = now()
         WHERE id = $1`,
        [runId, JSON.stringify({ latestDay }), rates.length],
      );
      await client.query("COMMIT");
      logger.info("fx rates synced", { runId, rows: rates.length, latestDay });
      return { skipped: false, runId, status: "success", rowsSynced: rates.length, latestDay };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      const message = err instanceof Error ? err.message : String(err);
      await client.query(
        "UPDATE sync_runs SET status = 'error', error = $2, finished_at = now() WHERE id = $1",
        [runId, message],
      );
      logger.error("fx sync failed", { runId, error: err });
      return { skipped: false, runId, status: "error", error: message };
    }
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock($1)", [lockKey()]).catch(() => {});
    }
    client.release();
  }
}

/** Due when never fetched, the last fetch is older than the interval, or the
 * last fetch failed over an hour ago. */
export async function fxDue(db: Db, now: Date): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT status, started_at FROM sync_runs
     WHERE connector = $1 ORDER BY started_at DESC, id DESC LIMIT 1`,
    [FX_CONNECTOR],
  );
  if (rows.length === 0) return true;
  const startedAt = new Date(rows[0].started_at as string).getTime();
  const ageMs = now.getTime() - startedAt;
  if (ageMs >= FX_SYNC_INTERVAL_MS) return true;
  return rows[0].status === "error" && ageMs >= FX_RETRY_MS;
}

export interface FxTickOpts extends FxSyncOpts {
  now?: Date;
}

/** One scheduler pass: fetch when due, otherwise do nothing. */
export async function fxTick(opts: FxTickOpts = {}): Promise<FxSyncResult | null> {
  const pool = opts.pool ?? getPool();
  if (!(await fxDue(pool, opts.now ?? new Date()))) return null;
  return syncFxRates(opts);
}

/**
 * Of the given currencies, the ones with no fx_rates row at all - money in
 * them can never convert (USD never needs a row). Callers phrase their own
 * refusal; the check is the shared part.
 */
export async function unknownCurrencies(
  currencies: Iterable<string>,
  db: Db = getPool(),
): Promise<string[]> {
  const list = [...new Set(currencies)].filter((c) => c !== "USD");
  if (list.length === 0) return [];
  const { rows } = await db.query(
    `SELECT c.currency FROM unnest($1::text[]) AS c(currency)
     WHERE NOT EXISTS (SELECT 1 FROM fx_rates r WHERE r.currency = c.currency)
     ORDER BY c.currency`,
    [list],
  );
  return rows.map((r) => r.currency as string);
}

export interface FxStatus {
  /** Most recent day with any rate, or null before the first fetch. */
  latestDay: string | null;
  /** Distinct currencies with at least one rate (USD itself never stored). */
  currencies: number;
  lastRun: {
    status: string;
    startedAt: string;
    finishedAt: string | null;
    rowsSynced: number | null;
    error: string | null;
  } | null;
}

export async function fxStatus(db: Db = getPool()): Promise<FxStatus> {
  const { rows: agg } = await db.query(
    `SELECT max(day)::text AS latest, count(DISTINCT currency)::int AS currencies
     FROM fx_rates`,
  );
  const { rows: runs } = await db.query(
    `SELECT status, started_at, finished_at, rows_synced, error FROM sync_runs
     WHERE connector = $1 ORDER BY started_at DESC, id DESC LIMIT 1`,
    [FX_CONNECTOR],
  );
  return {
    latestDay: agg[0].latest,
    currencies: agg[0].currencies,
    lastRun:
      runs.length === 0
        ? null
        : {
            status: runs[0].status,
            startedAt: new Date(runs[0].started_at).toISOString(),
            finishedAt: runs[0].finished_at
              ? new Date(runs[0].finished_at).toISOString()
              : null,
            rowsSynced: runs[0].rows_synced === null ? null : Number(runs[0].rows_synced),
            error: runs[0].error,
          },
  };
}
