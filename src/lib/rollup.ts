import type { Pool } from "pg";
import { getPool } from "./db";
import { logger } from "./logger";
import { countsPersonalSql } from "./tag-sql";

/**
 * Daily rollup recompute. rollup_daily / rollup_outcomes_daily power every
 * chart; raw facts power drill-downs only.
 *
 * - Delete-and-rebuild for a UTC day range, in one transaction, so re-runs
 *   are idempotent and a Resolve re-attribution just recomputes the days it
 *   touched (history follows the person - run it over the full range of the
 *   re-attributed facts).
 * - Amounts normalize to USD cents via fx_rates (usd_rate = USD per 1 unit).
 *   Rate lookup: latest rate on/before the day, else the earliest rate after
 *   it (covers backfills older than the first fetched rate). A currency with
 *   no rate at all aborts the recompute - no fake numbers.
 * - person_id NULL flows through as the Unassigned bucket. Never dropped.
 * - When no range is given, it spans the days that currently have raw rows.
 *   Days outside that span are left alone, so rollups survive raw-fact
 *   retention purges (raw keeps 13 months, rollups keep forever).
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Latest rate on/before the day, else earliest after; NULL only when the
// currency has no rates at all (caught by the pre-check).
const FX_EXPR = `
  CASE
    WHEN %CURRENCY% = 'USD' THEN 1::numeric
    ELSE COALESCE(
      (SELECT r.usd_rate FROM fx_rates r
        WHERE r.currency = %CURRENCY% AND r.day <= %DAY%
        ORDER BY r.day DESC LIMIT 1),
      (SELECT r.usd_rate FROM fx_rates r
        WHERE r.currency = %CURRENCY% AND r.day > %DAY%
        ORDER BY r.day ASC LIMIT 1)
    )
  END
`;

/** USD-per-unit rate expression for a (currency, day) pair - the one FX
 * conversion every USD figure in the app goes through. */
export function fxExpr(currencyExpr: string, dayExpr: string): string {
  return FX_EXPR.replaceAll("%CURRENCY%", currencyExpr).replaceAll(
    "%DAY%",
    dayExpr,
  );
}

export interface RecomputeRange {
  /** Inclusive UTC day, YYYY-MM-DD. */
  from?: string;
  /** Inclusive UTC day, YYYY-MM-DD. */
  to?: string;
}

export interface RecomputeResult {
  from: string | null;
  to: string | null;
  spendRows: number;
  outcomeRows: number;
}

function assertDay(name: string, value: string): void {
  if (!DATE_RE.test(value)) {
    throw new Error(`${name} must be YYYY-MM-DD, got ${JSON.stringify(value)}`);
  }
}

export async function recomputeRollups(
  range: RecomputeRange = {},
  pool: Pool = getPool(),
): Promise<RecomputeResult> {
  if (range.from !== undefined) assertDay("from", range.from);
  if (range.to !== undefined) assertDay("to", range.to);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let { from, to } = range;
    if (from === undefined || to === undefined) {
      const { rows } = await client.query(
        `SELECT min(d)::text AS from_day, max(d)::text AS to_day FROM (
           SELECT day AS d FROM spend_facts
           UNION ALL
           SELECT (ts AT TIME ZONE 'UTC')::date FROM outcomes
         ) days`,
      );
      from ??= rows[0].from_day ?? undefined;
      to ??= rows[0].to_day ?? undefined;
    }
    if (from === undefined || to === undefined) {
      // Nothing to roll up and no explicit range: leave existing rollups
      // (e.g. retention survivors) untouched.
      await client.query("COMMIT");
      return { from: null, to: null, spendRows: 0, outcomeRows: 0 };
    }
    if (from > to) {
      throw new Error(`from ${from} is after to ${to}`);
    }

    // No fake numbers: a currency in range with no FX rate at all aborts.
    const missing = await client.query(
      `SELECT DISTINCT c.currency FROM (
         SELECT currency FROM spend_facts
           WHERE day BETWEEN $1::date AND $2::date AND currency <> 'USD'
         UNION
         SELECT currency FROM outcomes
           WHERE currency IS NOT NULL AND currency <> 'USD'
             AND (ts AT TIME ZONE 'UTC')::date BETWEEN $1::date AND $2::date
       ) c
       WHERE NOT EXISTS (
         SELECT 1 FROM fx_rates r WHERE r.currency = c.currency
       )
       ORDER BY c.currency`,
      [from, to],
    );
    if (missing.rows.length > 0) {
      const currencies = missing.rows.map((r) => r.currency).join(", ");
      throw new Error(`no FX rate for currencies: ${currencies}`);
    }

    await client.query(
      "DELETE FROM rollup_daily WHERE day BETWEEN $1::date AND $2::date",
      [from, to],
    );
    await client.query(
      "DELETE FROM rollup_outcomes_daily WHERE day BETWEEN $1::date AND $2::date",
      [from, to],
    );

    // counts_personal: the per-tag toggle (spec 7b) flows into the rollup
    // grain - a fact stops counting toward personal usage when any of its
    // identity's effective tags is toggled off. Attribution is untouched.
    const spend = await client.query(
      `INSERT INTO rollup_daily
         (day, person_id, product_id, vendor, cost_basis, counts_personal,
          tokens, amount_usd_cents, fact_count)
       SELECT f.day, f.person_id, f.product_id, f.vendor, f.cost_basis,
              cp.counts_personal,
              SUM(f.tokens)::bigint,
              ROUND(SUM(f.amount_cents * fx.usd_rate))::bigint,
              COUNT(*)::int
       FROM spend_facts f
       CROSS JOIN LATERAL (
         SELECT ${fxExpr("f.currency", "f.day")} AS usd_rate
       ) fx
       CROSS JOIN LATERAL (
         SELECT ${countsPersonalSql("f")} AS counts_personal
       ) cp
       WHERE f.day BETWEEN $1::date AND $2::date
       GROUP BY f.day, f.person_id, f.product_id, f.vendor, f.cost_basis,
                cp.counts_personal`,
      [from, to],
    );

    // Reverted outcomes (a merged PR flipped by a revert, spec 5) roll up
    // under their own "<kind>:reverted" bucket: $/merge and ROI count only
    // live outcomes, while revert rates stay chartable from the rollup.
    // Counts are count-aware (a manual entry records a month's outcomes as
    // one row, spec 7); value_cents is per outcome, so a row contributes
    // count * value. valued_count = outcomes carrying an explicit value,
    // which is what lets the product's default value per outcome apply to
    // the rest at read time - from rollups alone.
    const outcomes = await client.query(
      `INSERT INTO rollup_outcomes_daily
         (day, product_id, person_id, kind, outcome_count, valued_count,
          value_usd_cents)
       SELECT d.day, o.product_id, o.person_id, k.kind,
              SUM(o.count)::int,
              COALESCE(SUM(o.count) FILTER (WHERE o.value_cents IS NOT NULL), 0)::int,
              ROUND(SUM(o.count * o.value_cents * fx.usd_rate))::bigint
       FROM outcomes o
       CROSS JOIN LATERAL (
         SELECT (o.ts AT TIME ZONE 'UTC')::date AS day
       ) d
       CROSS JOIN LATERAL (
         SELECT CASE WHEN o.reverted_at IS NULL THEN o.kind
                ELSE o.kind || ':reverted'
                END AS kind
       ) k
       CROSS JOIN LATERAL (
         SELECT CASE WHEN o.value_cents IS NULL THEN NULL::numeric
                ELSE ${fxExpr("o.currency", "d.day")}
                END AS usd_rate
       ) fx
       WHERE d.day BETWEEN $1::date AND $2::date
       GROUP BY d.day, o.product_id, o.person_id, k.kind`,
      [from, to],
    );

    await client.query("COMMIT");

    const result: RecomputeResult = {
      from,
      to,
      spendRows: spend.rowCount ?? 0,
      outcomeRows: outcomes.rowCount ?? 0,
    };
    logger.info("rollups recomputed", { ...result });
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
