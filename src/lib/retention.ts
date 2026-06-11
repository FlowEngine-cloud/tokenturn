import { getPool, type Db } from "./db";
import { logger } from "./logger";
import { utcDay } from "./connectors/sync";
import { getSetting } from "./settings";

/**
 * Retention (spec 4): raw per-request facts keep 13 months (editable in
 * Settings); daily rollups keep forever. The prune runs once per UTC day on
 * the scheduler tick (deduped through alert_state like every periodic job)
 * and deletes raw rows older than the cutoff - spend facts and the SDK's
 * raw ingest events. Rollup tables are never touched, so every chart and
 * monthly total stays intact; only the row-level drill ends at the horizon.
 */

export interface RetentionResult {
  ran: boolean;
  cutoffDay: string | null;
  factsDeleted: number;
  ingestEventsDeleted: number;
}

/** First day still kept: N months back from today's UTC day. */
export function retentionCutoff(now: Date, months: number): string {
  const day = now.toISOString().slice(0, 10);
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 - months, d)).toISOString().slice(0, 10);
}

export async function retentionTick(
  opts: { db?: Db; now?: Date } = {},
): Promise<RetentionResult> {
  const db = opts.db ?? getPool();
  const now = opts.now ?? new Date();

  // Once per UTC day.
  const marked = await db.query(
    `INSERT INTO alert_state (kind, scope, period_key)
     VALUES ('retention_prune', 'org', $1)
     ON CONFLICT (kind, scope, period_key) DO NOTHING`,
    [utcDay(now)],
  );
  if ((marked.rowCount ?? 0) === 0) {
    return { ran: false, cutoffDay: null, factsDeleted: 0, ingestEventsDeleted: 0 };
  }

  const months = await getSetting("raw_facts_retention_months", db);
  const cutoffDay = retentionCutoff(now, months);
  const facts = await db.query("DELETE FROM spend_facts WHERE day < $1", [cutoffDay]);
  const events = await db.query("DELETE FROM ingest_events WHERE day < $1", [cutoffDay]);
  const result: RetentionResult = {
    ran: true,
    cutoffDay,
    factsDeleted: facts.rowCount ?? 0,
    ingestEventsDeleted: events.rowCount ?? 0,
  };
  if (result.factsDeleted > 0 || result.ingestEventsDeleted > 0) {
    logger.info("retention prune", { ...result, months });
  }
  return result;
}
