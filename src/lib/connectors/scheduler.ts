import type { Pool } from "pg";
import { getPool } from "../db";
import { emitEvent } from "../events";
import { fxTick } from "../fx";
import { logger } from "../logger";
import { getSetting } from "../settings";
import { listConnectedRows } from "./connect";
import { getConnector } from "./registry";
import { runSync, utcDay, type SyncResult } from "./sync";

/**
 * Hourly scheduler (spec 5). One in-process ticker; each tick:
 *
 * 1. Runs a sync for every connected connector whose last run started over
 *    an hour ago (errored runs retry on the same cadence and resume their
 *    window). The per-connector advisory lock inside runSync makes
 *    overlapping ticks harmless.
 * 2. Emits connector.silent for any connected connector with no successful
 *    sync in connector_silent_alert_hours (default 24) - at most once per
 *    connector per UTC day, deduped through alert_state. The alerts
 *    feature subscribes to the event and fans out to Slack.
 */

export const SYNC_INTERVAL_MS = 60 * 60 * 1000;
/** How often the ticker wakes up to look for due work. */
export const TICK_EVERY_MS = 5 * 60 * 1000;

export interface SchedulerTickOpts {
  pool?: Pool;
  fetch?: typeof fetch;
  now?: Date;
  dataDir?: string;
}

export interface SchedulerTickResult {
  synced: SyncResult[];
  silentEmitted: string[];
}

async function dueVendors(pool: Pool, now: Date): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT c.vendor
     FROM connectors c
     LEFT JOIN LATERAL (
       SELECT started_at FROM sync_runs r
       WHERE r.connector = c.vendor
       ORDER BY r.started_at DESC, r.id DESC LIMIT 1
     ) last ON true
     WHERE last.started_at IS NULL OR last.started_at <= $1
     ORDER BY c.vendor`,
    [new Date(now.getTime() - SYNC_INTERVAL_MS)],
  );
  return rows.map((r) => r.vendor as string);
}

/**
 * Emit connector.silent where due. Runs after the tick's syncs, so a
 * connector that just recovered does not alert.
 */
export async function checkSilentConnectors(
  opts: SchedulerTickOpts = {},
): Promise<string[]> {
  const pool = opts.pool ?? getPool();
  const now = opts.now ?? new Date();
  const thresholdHours = await getSetting("connector_silent_alert_hours", pool);
  const cutoff = new Date(now.getTime() - thresholdHours * 3_600_000);

  const emitted: string[] = [];
  for (const row of await listConnectedRows(pool)) {
    const { rows } = await pool.query(
      `SELECT finished_at FROM sync_runs
       WHERE connector = $1 AND status = 'success'
       ORDER BY finished_at DESC LIMIT 1`,
      [row.vendor],
    );
    const lastSuccess: Date | null = rows[0]?.finished_at ?? null;
    const sinceWhen = lastSuccess ?? new Date(row.connected_at);
    if (sinceWhen > cutoff) continue;

    // Dedupe: one alert per connector per UTC day (alert_state contract).
    const inserted = await pool.query(
      `INSERT INTO alert_state (kind, scope, period_key)
       VALUES ('connector_silent', $1, $2)
       ON CONFLICT (kind, scope, period_key) DO NOTHING`,
      [row.vendor, utcDay(now)],
    );
    if ((inserted.rowCount ?? 0) > 0) {
      emitEvent("connector.silent", {
        vendor: row.vendor,
        lastSuccessAt: lastSuccess ? lastSuccess.toISOString() : null,
        thresholdHours,
      });
      emitted.push(row.vendor);
    }
  }
  return emitted;
}

/** One scheduler pass. Exported so tests drive it directly with a pinned clock. */
export async function schedulerTick(
  opts: SchedulerTickOpts = {},
): Promise<SchedulerTickResult> {
  const pool = opts.pool ?? getPool();
  const now = opts.now ?? new Date();

  const synced: SyncResult[] = [];
  for (const vendor of await dueVendors(pool, now)) {
    if (!getConnector(vendor)) {
      logger.warn("connected vendor has no registered connector", { connector: vendor });
      continue;
    }
    try {
      synced.push(await runSync(vendor, opts));
    } catch (err) {
      // runSync stores vendor errors itself; this catches framework-level
      // failures so one connector can never stall the rest of the tick.
      logger.error("scheduled sync crashed", { connector: vendor, error: err });
    }
  }

  const silentEmitted = await checkSilentConnectors({ ...opts, now });
  return { synced, silentEmitted };
}

let ticker: NodeJS.Timeout | null = null;

/** Boot the ticker (idempotent). Returns a stop function. */
export function startScheduler(): () => void {
  if (!ticker) {
    const run = () => {
      schedulerTick().catch((err) => {
        logger.error("scheduler tick failed", { error: err });
      });
      // Daily ECB FX rates ride the same ticker; fxTick fetches only when
      // due. Tests drive fxTick directly, so connector-tick tests stay
      // independent of the ECB feed.
      fxTick().catch((err) => {
        logger.error("fx tick failed", { error: err });
      });
    };
    ticker = setInterval(run, TICK_EVERY_MS);
    ticker.unref?.();
    // First pass shortly after boot so a fresh connect never waits 5 min.
    setTimeout(run, 5_000).unref?.();
    logger.info("connector scheduler started", {
      tickEveryMs: TICK_EVERY_MS,
      syncIntervalMs: SYNC_INTERVAL_MS,
    });
  }
  return () => {
    if (ticker) clearInterval(ticker);
    ticker = null;
  };
}
