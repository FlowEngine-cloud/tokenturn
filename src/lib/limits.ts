import type { Pool } from "pg";
import {
  buildContext,
  getConnectorConfig,
  type ConnectorOpts,
} from "./connectors/connect";
import { cursorConnector, setCursorUserSpendLimit } from "./connectors/cursor";
import { addDays, utcDay } from "./connectors/sync";
import { getPool, type Db } from "./db";
import { emitEvent, type AppEvents } from "./events";
import { logger } from "./logger";
import { getSetting } from "./settings";

/**
 * Limits + burn alarms (spec section 9).
 *
 * - The monthly limit per person lives on people.monthly_limit_usd_cents
 *   and resets with the UTC calendar month: month-to-date spend is the sum
 *   of that month's rollup_daily rows. It is an ALERT threshold (Slack at
 *   80%/100%), never a hard stop - the only vendor-side limit we can write
 *   is Cursor's, Enterprise only, and only when asked (pushLimitToCursor).
 * - Both checks count counts_personal spend only: the spec-7b per-tag
 *   toggle exists exactly so batch/cron/experiment keys don't trip a
 *   person's limit. Unassigned spend has no person and no limit.
 * - Dedupe lives in alert_state: one alert per threshold per person per
 *   month (kind limit_<pct>, period YYYY-MM), max one anomaly per person
 *   per UTC day (kind anomaly, period YYYY-MM-DD). The checks are
 *   re-runnable at any frequency - the scheduler tick drives them.
 * - Every number traces to rows: month spend comes from rollup_daily
 *   (drill-down = that person's facts over the month window the status
 *   surface returns), vendor limits carry their usage_metrics source_ref.
 */

/** Trailing window for the anomaly average (spec 9: 30-day average). */
export const TRAILING_AVG_DAYS = 30;

export function utcMonth(date: Date): string {
  return utcDay(date).slice(0, 7);
}

export function monthStartDay(date: Date): string {
  return `${utcMonth(date)}-01`;
}

export interface BurnCheckOpts {
  pool?: Pool;
  now?: Date;
}

export interface BurnCheckResult {
  limitAlerts: AppEvents["limit.threshold"][];
  anomalies: AppEvents["burn.anomaly"][];
}

/** Insert-or-skip into alert_state; true = fresh, fire the alert. */
async function claimAlert(
  pool: Pool,
  kind: string,
  scope: string,
  periodKey: string,
): Promise<boolean> {
  const inserted = await pool.query(
    `INSERT INTO alert_state (kind, scope, period_key)
     VALUES ($1, $2, $3)
     ON CONFLICT (kind, scope, period_key) DO NOTHING`,
    [kind, scope, periodKey],
  );
  return (inserted.rowCount ?? 0) > 0;
}

/**
 * Fire limit.threshold for every active person whose month-to-date (UTC
 * calendar month) spend crossed a threshold not yet alerted this month.
 * Jumping straight past 100% fires every crossed threshold - one alert per
 * threshold per month, exactly (spec 9).
 */
export async function checkLimitAlerts(
  opts: BurnCheckOpts = {},
): Promise<AppEvents["limit.threshold"][]> {
  const pool = opts.pool ?? getPool();
  const now = opts.now ?? new Date();
  const month = utcMonth(now);
  const thresholds = [
    ...(await getSetting("limit_alert_thresholds_pct", pool)),
  ].sort((a, b) => a - b);

  const { rows } = await pool.query(
    `SELECT p.id, p.email, p.name,
            p.monthly_limit_usd_cents::bigint AS limit_cents,
            COALESCE(s.spend, 0)::bigint AS spend_cents
     FROM people p
     LEFT JOIN (
       SELECT person_id, SUM(amount_usd_cents) AS spend
       FROM rollup_daily
       WHERE counts_personal AND person_id IS NOT NULL
         AND day BETWEEN $1::date AND $2::date
       GROUP BY person_id
     ) s ON s.person_id = p.id
     WHERE p.status = 'active' AND p.monthly_limit_usd_cents IS NOT NULL
     ORDER BY p.email`,
    [monthStartDay(now), utcDay(now)],
  );

  const fired: AppEvents["limit.threshold"][] = [];
  for (const row of rows) {
    const limitUsdCents = Number(row.limit_cents);
    const monthSpendUsdCents = Number(row.spend_cents);
    for (const thresholdPct of thresholds) {
      if (monthSpendUsdCents * 100 < limitUsdCents * thresholdPct) continue;
      if (!(await claimAlert(pool, `limit_${thresholdPct}`, row.id, month))) {
        continue;
      }
      const payload: AppEvents["limit.threshold"] = {
        personId: row.id,
        email: row.email,
        name: row.name,
        month,
        thresholdPct,
        limitUsdCents,
        monthSpendUsdCents,
      };
      emitEvent("limit.threshold", payload);
      fired.push(payload);
    }
  }
  return fired;
}

/**
 * Fire burn.anomaly for every active person whose spend today (UTC) is
 * >= anomaly_burn_multiplier x their trailing 30-day average AND
 * >= anomaly_min_day_cents - both settings-editable (spec 9). The average
 * is the sum of the 30 days before today divided by 30, zero-spend days
 * included; a person with no history averages 0, so any day at or over
 * the floor is an anomaly. Max one per person per day.
 */
export async function checkAnomalies(
  opts: BurnCheckOpts = {},
): Promise<AppEvents["burn.anomaly"][]> {
  const pool = opts.pool ?? getPool();
  const now = opts.now ?? new Date();
  const today = utcDay(now);
  const multiplier = await getSetting("anomaly_burn_multiplier", pool);
  const minDayUsdCents = await getSetting("anomaly_min_day_cents", pool);

  const { rows } = await pool.query(
    `SELECT p.id, p.email, p.name,
            t.spend::bigint AS today_cents,
            COALESCE(a.spend, 0)::bigint AS trailing_cents
     FROM people p
     JOIN (
       SELECT person_id, SUM(amount_usd_cents) AS spend
       FROM rollup_daily
       WHERE counts_personal AND person_id IS NOT NULL AND day = $1::date
       GROUP BY person_id
     ) t ON t.person_id = p.id
     LEFT JOIN (
       SELECT person_id, SUM(amount_usd_cents) AS spend
       FROM rollup_daily
       WHERE counts_personal AND person_id IS NOT NULL
         AND day BETWEEN $2::date AND $3::date
       GROUP BY person_id
     ) a ON a.person_id = p.id
     WHERE p.status = 'active'
     ORDER BY p.email`,
    [today, addDays(today, -TRAILING_AVG_DAYS), addDays(today, -1)],
  );

  const fired: AppEvents["burn.anomaly"][] = [];
  for (const row of rows) {
    const dayUsdCents = Number(row.today_cents);
    const trailingCents = Number(row.trailing_cents);
    if (dayUsdCents < minDayUsdCents) continue;
    // today >= multiplier * (trailing / 30), kept in integer-friendly form.
    if (dayUsdCents * TRAILING_AVG_DAYS < multiplier * trailingCents) continue;
    if (!(await claimAlert(pool, "anomaly", row.id, today))) continue;
    const payload: AppEvents["burn.anomaly"] = {
      personId: row.id,
      email: row.email,
      name: row.name,
      day: today,
      dayUsdCents,
      trailingAvgUsdCents: Math.round(trailingCents / TRAILING_AVG_DAYS),
      multiplier,
      minDayUsdCents,
    };
    emitEvent("burn.anomaly", payload);
    fired.push(payload);
  }
  return fired;
}

/** Both spec-9 burn checks; the scheduler tick runs this after syncs. */
export async function checkBurnAlerts(
  opts: BurnCheckOpts = {},
): Promise<BurnCheckResult> {
  const limitAlerts = await checkLimitAlerts(opts);
  const anomalies = await checkAnomalies(opts);
  return { limitAlerts, anomalies };
}

// ---------------------------------------------------------------------------
// Status surface (the Limits UI reads this)

/**
 * What each vendor can actually enforce (spec 9) - stated verbatim so an
 * alert is never mistaken for a hard stop.
 */
export const VENDOR_LIMIT_POLICIES = {
  cursor: {
    enforcement: "vendor-enforced",
    canWrite: true,
    note: "Cursor enforces its own per-user monthly limit and reports it here. Pushing your limit to Cursor requires their Enterprise plan; on Business it is read-only.",
  },
  anthropic: {
    enforcement: "vendor-enforced",
    canWrite: false,
    note: "Anthropic workspace caps are real hard-stops, but they are set in the Anthropic Console and the Admin API does not expose them - AI P&L can neither read nor set them.",
  },
  openai: {
    enforcement: "alert-only",
    canWrite: false,
    note: "OpenAI has no budget API. AI P&L alerts at your thresholds; nothing is hard-stopped on the vendor side.",
  },
} as const;

export interface VendorLimitRow {
  vendor: string;
  limitUsdCents: number;
  /** The day the vendor reported it for (Cursor: the billing cycle start). */
  asOfDay: string;
  /** The usage_metrics record behind the number - drillable, never invented. */
  sourceRef: string;
}

export interface PersonLimitStatus {
  personId: string;
  email: string;
  name: string | null;
  limitUsdCents: number | null;
  monthSpendUsdCents: number;
  /** Thresholds already alerted this month - the dedupe state, visible. */
  thresholdsFired: number[];
  /** The vendor's limit, shown next to ours (spec 9). */
  vendorLimits: VendorLimitRow[];
}

export interface LimitStatusPage {
  /** UTC calendar month being measured. */
  month: string;
  /** Month-to-date window - the drill-down range behind every spend figure. */
  from: string;
  to: string;
  people: PersonLimitStatus[];
  vendorPolicies: typeof VENDOR_LIMIT_POLICIES;
}

/**
 * Every active person with our limit, month-to-date spend, thresholds
 * already fired, and the vendor-side limit where a vendor reports one
 * (Cursor's monthlyLimitDollars, synced as the spend_limit_dollars metric).
 */
export async function listLimitStatus(
  db: Db = getPool(),
  now: Date = new Date(),
): Promise<LimitStatusPage> {
  const month = utcMonth(now);
  const from = monthStartDay(now);
  const to = utcDay(now);

  const { rows } = await db.query(
    `SELECT p.id, p.email, p.name,
            p.monthly_limit_usd_cents::bigint AS limit_cents,
            COALESCE(s.spend, 0)::bigint AS spend_cents
     FROM people p
     LEFT JOIN (
       SELECT person_id, SUM(amount_usd_cents) AS spend
       FROM rollup_daily
       WHERE counts_personal AND person_id IS NOT NULL
         AND day BETWEEN $1::date AND $2::date
       GROUP BY person_id
     ) s ON s.person_id = p.id
     WHERE p.status = 'active'
     ORDER BY COALESCE(s.spend, 0) DESC, p.email`,
    [from, to],
  );

  const { rows: firedRows } = await db.query(
    `SELECT scope, kind FROM alert_state
     WHERE period_key = $1 AND kind LIKE 'limit\\_%'`,
    [month],
  );
  const firedByPerson = new Map<string, number[]>();
  for (const row of firedRows) {
    const pct = Number(row.kind.slice("limit_".length));
    if (!Number.isFinite(pct)) continue;
    const list = firedByPerson.get(row.scope) ?? [];
    list.push(pct);
    firedByPerson.set(row.scope, list);
  }

  // Latest vendor-reported per-user limit (Cursor restates the running
  // cycle's row in place every sync; the newest day is the current limit).
  const { rows: vendorRows } = await db.query(
    `SELECT DISTINCT ON (m.person_id)
            m.person_id, m.value::bigint AS dollars, m.day::text AS day,
            m.source_ref
     FROM usage_metrics m
     WHERE m.vendor = 'cursor' AND m.metric = 'spend_limit_dollars'
       AND m.person_id IS NOT NULL
     ORDER BY m.person_id, m.day DESC, m.id DESC`,
  );
  const vendorByPerson = new Map<string, VendorLimitRow[]>();
  for (const row of vendorRows) {
    vendorByPerson.set(row.person_id, [
      {
        vendor: "cursor",
        limitUsdCents: Number(row.dollars) * 100,
        asOfDay: row.day,
        sourceRef: row.source_ref,
      },
    ]);
  }

  return {
    month,
    from,
    to,
    people: rows.map((row) => ({
      personId: row.id,
      email: row.email,
      name: row.name,
      limitUsdCents: row.limit_cents === null ? null : Number(row.limit_cents),
      monthSpendUsdCents: Number(row.spend_cents),
      thresholdsFired: (firedByPerson.get(row.id) ?? []).sort((a, b) => a - b),
      vendorLimits: vendorByPerson.get(row.id) ?? [],
    })),
    vendorPolicies: VENDOR_LIMIT_POLICIES,
  };
}

// ---------------------------------------------------------------------------
// Cursor push (the one vendor limit we can write - Enterprise only)

export interface CursorPushResult {
  userEmail: string;
  spendLimitDollars: number;
}

/**
 * Push a person's limit to Cursor as their vendor-side monthly spend limit.
 * Uses the person's Cursor roster email when one is mapped (merged people
 * can differ from people.email), else their primary email - an email Cursor
 * doesn't know is rejected with the vendor's error, verbatim, exactly like
 * the Enterprise-plan rejection on Business teams.
 */
export async function pushLimitToCursor(
  personId: string,
  limitUsdCents: number,
  opts: ConnectorOpts = {},
): Promise<CursorPushResult> {
  const db = opts.db ?? getPool();
  const config = await getConnectorConfig("cursor", opts);
  if (config === null) {
    throw new Error("Cursor is not connected - connect it in Settings first");
  }

  const { rows } = await db.query(
    `SELECT p.email AS person_email, i.email AS cursor_email
     FROM people p
     LEFT JOIN identities i
       ON i.person_id = p.id AND i.vendor = 'cursor' AND i.kind = 'user'
          AND i.email IS NOT NULL
     WHERE p.id = $1
     ORDER BY i.updated_at DESC NULLS LAST
     LIMIT 1`,
    [personId],
  );
  if (rows.length === 0) throw new Error("person not found");

  const userEmail: string = rows[0].cursor_email ?? rows[0].person_email;
  const spendLimitDollars = limitUsdCents / 100;
  const ctx = buildContext(cursorConnector, config, opts.fetch);
  await setCursorUserSpendLimit(ctx, userEmail, spendLimitDollars);
  logger.info("cursor user spend limit pushed", {
    personId,
    userEmail,
    spendLimitDollars,
  });
  return { userEmail, spendLimitDollars };
}
