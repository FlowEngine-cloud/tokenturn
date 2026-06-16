import { getPool, type Db } from "./db";
// The index import matters: it is what registers the built-in connectors,
// so vendor search works no matter which route loads first.
import { listConnectedRows, listConnectors } from "./connectors";
import { assertDay, displayLateral, type TrendPoint } from "./display";
import { invoiceDrift } from "./invoices";
import { ResolveError } from "./resolve";
import { fxExpr } from "./rollup";
import { getSetting } from "./settings";

/**
 * Overview + drill-down readers (spec 10 page 1, spec 3).
 *
 * Every chart number comes from rollup_daily (spec 4: rollups power every
 * chart) converted to the org's display currency per day at read time; every
 * drill-down comes from spend_facts with the same per-day conversion - so a
 * tile and its drill rows are two reads of the same money and sum to the
 * same number. No cached aggregates, no fake numbers.
 *
 * Attribution: a fact is attributed when it has a person OR a product (one
 * dollar, one person or Unassigned, at most one product - spec 4). The
 * Unassigned bucket = no person AND no product, visible per vendor.
 */

export const VENDOR_RE = /^[a-z0-9][a-z0-9_.-]*$/;

// Shared with the people/products/tools readers via the leaf module
// (display.ts) so they never import this file's connector registry.
export { assertDay, displayLateral } from "./display";
export type { TrendPoint } from "./display";

export interface OverviewTotals {
  /** Real spend = what you actually pay (every fact: metered + seats). */
  totalCents: number;
  estimatedCents: number;
  invoicedCents: number;
  /** Flat recurring seat fees (billing_mode 'subscription'). */
  subscriptionCents: number;
  /** Pay-as-you-go spend (billing_mode 'metered') - the rest of real spend. */
  meteredCents: number;
  /**
   * Usage value = the API-equivalent cost of all usage, a different lens than
   * real spend: metered token estimates (what API users pay) plus each
   * subscription seat holder's metered-equivalent usage (what their flat seat
   * would have cost on the API). For a seat this runs far above the fee - the
   * gap is the leverage the flat plan buys.
   */
  usageValueCents: number;
  /** Spend with a person or a product. */
  assignedCents: number;
  /** No person AND no product - the visible Unassigned bucket. */
  unassignedCents: number;
  /** assigned / total, one decimal; null when there is no spend. */
  coveragePct: number | null;
  factCount: number;
}

export interface VendorSpend {
  vendor: string;
  totalCents: number;
  estimatedCents: number;
  invoicedCents: number;
  unassignedCents: number;
  factCount: number;
}

export interface PersonSpend {
  /** null = the Unassigned bucket. */
  personId: string | null;
  name: string | null;
  email: string | null;
  cents: number;
  factCount: number;
}

export interface ProductSpend {
  productId: string;
  name: string;
  archived: boolean;
  cents: number;
  factCount: number;
  /** Live outcomes in range (reverted excluded). */
  outcomeCount: number;
}

export interface OverviewData {
  displayCurrency: string;
  from: string;
  to: string;
  totals: OverviewTotals;
  /** Invoice true-up drift over the range's months, display cents. */
  drift: { cents: number; invoiceCount: number };
  trend: TrendPoint[];
  byVendor: VendorSpend[];
  topPeople: PersonSpend[];
  topProducts: ProductSpend[];
}

export async function overviewData(
  range: { from: string; to: string },
  db: Db = getPool(),
  opts: { topN?: number } = {},
): Promise<OverviewData> {
  assertDay("from", range.from);
  assertDay("to", range.to);
  if (range.from > range.to) {
    throw new ResolveError(`from ${range.from} is after to ${range.to}`, 400);
  }
  const topN = opts.topN ?? 5;
  const displayCurrency = await getSetting("display_currency", db);
  const params = [displayCurrency, range.from, range.to];

  const { rows: totalRows } = await db.query(
    `SELECT
       COALESCE(ROUND(SUM(d.cents)), 0)::bigint AS total,
       COALESCE(ROUND(SUM(d.cents) FILTER (WHERE r.cost_basis = 'estimated')), 0)::bigint AS estimated,
       COALESCE(ROUND(SUM(d.cents) FILTER (WHERE r.cost_basis = 'invoiced')), 0)::bigint AS invoiced,
       COALESCE(ROUND(SUM(d.cents) FILTER (WHERE r.billing_mode = 'subscription')), 0)::bigint AS subscription,
       COALESCE(ROUND(SUM(d.cents) FILTER (WHERE r.billing_mode = 'metered')), 0)::bigint AS metered,
       COALESCE(ROUND(SUM(d.cents) FILTER (
         WHERE r.billing_mode = 'metered' AND r.cost_basis = 'estimated')), 0)::bigint AS metered_estimated,
       COALESCE(ROUND(SUM(d.cents) FILTER (
         WHERE r.person_id IS NOT NULL OR r.product_id IS NOT NULL)), 0)::bigint AS assigned,
       COALESCE(SUM(r.fact_count), 0)::int AS facts,
       COALESCE(BOOL_OR(d.cents IS NULL), false) AS fx_missing
     FROM rollup_daily r
     ${displayLateral("r")}
     WHERE r.day BETWEEN $2::date AND $3::date`,
    params,
  );
  const t = totalRows[0];
  if (t.fx_missing) {
    throw new ResolveError(
      `no FX rate for the display currency ${displayCurrency} - sync FX rates first`,
      409,
    );
  }

  // Usage value = what all usage would cost at API rates, from two
  // non-overlapping sources:
  //   - metered usage: its estimated facts ARE the API-rate cost already
  //     (summed in metered_estimated above).
  //   - subscription usage: the vendor's OWN per-model estimated cost, which
  //     it reports in its analytics API (Claude Code model_breakdown ->
  //     estimated_cost) and we store verbatim in usage_metrics - never our
  //     price table, never a multiplier. It lives out of spend_facts because a
  //     flat seat is not metered; counting it as spend would be fiction.
  // The two never double count: a subscription customer is not API-billed, so
  // a seat holder has no metered facts for the same tokens. Scoped to the
  // seat's active months so usage before/after the plan is not credited to it.
  const { rows: usageRows } = await db.query(
    `SELECT COALESCE(ROUND(SUM(m.value::numeric / fx.rate)), 0)::bigint AS usage_value,
            COALESCE(BOOL_OR(fx.rate IS NULL), false) AS fx_missing
     FROM usage_metrics m
     JOIN subscription_seats s
       ON s.person_id = m.person_id AND s.vendor = m.vendor
      AND m.day >= s.started_month
      AND (s.ended_month IS NULL OR m.day < (s.ended_month + interval '1 month')::date)
     CROSS JOIN LATERAL (SELECT ${fxExpr("$1::text", "m.day")} AS rate) fx
     WHERE m.metric = 'estimated_cost_cents'
       AND m.day BETWEEN $2::date AND $3::date`,
    params,
  );
  if (usageRows[0].fx_missing) {
    throw new ResolveError(
      `no FX rate for the display currency ${displayCurrency} - sync FX rates first`,
      409,
    );
  }

  const totalCents = Number(t.total);
  const assignedCents = Number(t.assigned);
  const totals: OverviewTotals = {
    totalCents,
    estimatedCents: Number(t.estimated),
    invoicedCents: Number(t.invoiced),
    subscriptionCents: Number(t.subscription),
    meteredCents: Number(t.metered),
    usageValueCents: Number(t.metered_estimated) + Number(usageRows[0].usage_value),
    assignedCents,
    unassignedCents: totalCents - assignedCents,
    coveragePct:
      totalCents === 0
        ? null
        : Math.round((assignedCents / totalCents) * 1000) / 10,
    factCount: Number(t.facts),
  };

  const { rows: trendRows } = await db.query(
    `SELECT gs.day::date::text AS day, COALESCE(ROUND(SUM(d.cents)), 0)::bigint AS cents
     FROM generate_series($2::date, $3::date, '1 day') gs(day)
     LEFT JOIN rollup_daily r ON r.day = gs.day::date
     LEFT JOIN LATERAL (
       SELECT r.amount_usd_cents::numeric / ${fxExpr("$1::text", "r.day")} AS cents
     ) d ON true
     GROUP BY gs.day ORDER BY gs.day`,
    params,
  );

  const { rows: vendorRows } = await db.query(
    `SELECT r.vendor,
       ROUND(SUM(d.cents))::bigint AS total,
       COALESCE(ROUND(SUM(d.cents) FILTER (WHERE r.cost_basis = 'estimated')), 0)::bigint AS estimated,
       COALESCE(ROUND(SUM(d.cents) FILTER (WHERE r.cost_basis = 'invoiced')), 0)::bigint AS invoiced,
       COALESCE(ROUND(SUM(d.cents) FILTER (
         WHERE r.person_id IS NULL AND r.product_id IS NULL)), 0)::bigint AS unassigned,
       SUM(r.fact_count)::int AS facts
     FROM rollup_daily r
     ${displayLateral("r")}
     WHERE r.day BETWEEN $2::date AND $3::date
     GROUP BY r.vendor
     ORDER BY 2 DESC, r.vendor`,
    params,
  );

  // Per-person spend + the Unassigned bucket as its own row. Rows with no
  // person but a product are product spend (agents are products, not
  // people) and belong to neither.
  const { rows: peopleRows } = await db.query(
    `SELECT r.person_id AS "personId", p.name, p.email,
       ROUND(SUM(d.cents))::bigint AS cents,
       SUM(r.fact_count)::int AS facts
     FROM rollup_daily r
     LEFT JOIN people p ON p.id = r.person_id
     ${displayLateral("r")}
     WHERE r.day BETWEEN $2::date AND $3::date
       AND (r.person_id IS NOT NULL OR r.product_id IS NULL)
     GROUP BY r.person_id, p.name, p.email
     ORDER BY 4 DESC, p.email NULLS LAST
     LIMIT $4`,
    [...params, topN + 1],
  );

  const { rows: productRows } = await db.query(
    `SELECT r.product_id AS "productId", pr.name,
       (pr.archived_at IS NOT NULL) AS archived,
       ROUND(SUM(d.cents))::bigint AS cents,
       SUM(r.fact_count)::int AS facts,
       COALESCE(o.live, 0)::int AS outcomes
     FROM rollup_daily r
     JOIN products pr ON pr.id = r.product_id
     ${displayLateral("r")}
     LEFT JOIN LATERAL (
       SELECT SUM(ro.outcome_count)::int AS live
       FROM rollup_outcomes_daily ro
       WHERE ro.product_id = r.product_id
         AND ro.day BETWEEN $2::date AND $3::date
         AND ro.kind NOT LIKE '%:reverted'
     ) o ON true
     WHERE r.day BETWEEN $2::date AND $3::date AND r.product_id IS NOT NULL
     GROUP BY r.product_id, pr.name, pr.archived_at, o.live
     ORDER BY 4 DESC, pr.name
     LIMIT $4`,
    [...params, topN],
  );

  // Drift over the months the range touches - the same numbers as the
  // materialized invoice adjustments (lib/invoices.ts), so the badge drills
  // to the invoice rows behind it.
  const drift = await invoiceDrift(
    { from: range.from.slice(0, 7), to: range.to.slice(0, 7) },
    db,
  );
  const driftCents = drift.invoices.reduce((sum, i) => sum + i.driftDisplayCents, 0);

  return {
    displayCurrency,
    from: range.from,
    to: range.to,
    totals,
    drift: { cents: driftCents, invoiceCount: drift.invoices.length },
    trend: trendRows.map((row) => ({ day: row.day, cents: Number(row.cents) })),
    byVendor: vendorRows.map((row) => ({
      vendor: row.vendor,
      totalCents: Number(row.total),
      estimatedCents: Number(row.estimated),
      invoicedCents: Number(row.invoiced),
      unassignedCents: Number(row.unassigned),
      factCount: Number(row.facts),
    })),
    topPeople: peopleRows.map((row) => ({
      personId: row.personId,
      name: row.name,
      email: row.email,
      cents: Number(row.cents),
      factCount: Number(row.facts),
    })),
    topProducts: productRows.map((row) => ({
      productId: row.productId,
      name: row.name,
      archived: row.archived,
      cents: Number(row.cents),
      factCount: Number(row.facts),
      outcomeCount: Number(row.outcomes),
    })),
  };
}

// ---- drill-down: the raw spend_facts behind any tile number ----

export interface FactFilters {
  from?: string;
  to?: string;
  /** Exact UTC day (a trend bar). */
  day?: string;
  vendor?: string;
  /** Person uuid, or "unassigned" for person IS NULL. */
  person?: string;
  /** Product uuid, or "none" for product IS NULL. */
  product?: string;
  /** Identity uuid - the facts a single key/seat produced. */
  key?: string;
  /** Exact model name, or "none" for model IS NULL. */
  model?: string;
  basis?: "estimated" | "invoiced";
  /** Flat seat fees vs pay-as-you-go. */
  billingMode?: "subscription" | "metered";
  limit?: number;
  offset?: number;
}

export interface FactRow {
  id: string;
  day: string;
  vendor: string;
  model: string | null;
  tokens: number;
  /** As billed - the original amount and currency (spec 4). */
  amountCents: number;
  currency: string;
  costBasis: "estimated" | "invoiced";
  billingMode: "subscription" | "metered";
  /** The vendor record behind the row - what makes it drillable. */
  sourceRef: string;
  personId: string | null;
  personName: string | null;
  personEmail: string | null;
  productId: string | null;
  productName: string | null;
  identityExternalId: string | null;
  /** Converted to the display currency at the fact's day. */
  displayCents: number;
}

export interface FactPage {
  displayCurrency: string;
  rows: FactRow[];
  /** Across the WHOLE filter, not just this page - so the drill total */
  totalCount: number;
  /** equals the tile number it was reached from. */
  totalDisplayCents: number;
  totalTokens: number;
  limit: number;
  offset: number;
}

export const FACT_PAGE_MAX = 1000;
const FACT_PAGE_DEFAULT = 500;

export async function listFacts(
  filters: FactFilters = {},
  db: Db = getPool(),
): Promise<FactPage> {
  const displayCurrency = await getSetting("display_currency", db);
  const params: unknown[] = [displayCurrency];
  const where: string[] = [];
  const add = (clause: string, value: unknown): void => {
    params.push(value);
    where.push(clause.replace("?", `$${params.length}`));
  };

  if (filters.from !== undefined) {
    assertDay("from", filters.from);
    add("f.day >= ?::date", filters.from);
  }
  if (filters.to !== undefined) {
    assertDay("to", filters.to);
    add("f.day <= ?::date", filters.to);
  }
  if (filters.day !== undefined) {
    assertDay("day", filters.day);
    add("f.day = ?::date", filters.day);
  }
  if (filters.vendor !== undefined) add("f.vendor = ?", filters.vendor);
  if (filters.person === "unassigned") {
    where.push("f.person_id IS NULL");
  } else if (filters.person !== undefined) {
    add("f.person_id = ?::uuid", filters.person);
  }
  if (filters.product === "none") {
    where.push("f.product_id IS NULL");
  } else if (filters.product !== undefined) {
    add("f.product_id = ?::uuid", filters.product);
  }
  if (filters.key !== undefined) add("f.identity_id = ?::uuid", filters.key);
  if (filters.model === "none") {
    where.push("f.model IS NULL");
  } else if (filters.model !== undefined) {
    add("f.model = ?", filters.model);
  }
  if (filters.basis !== undefined) add("f.cost_basis = ?", filters.basis);
  if (filters.billingMode !== undefined) add("f.billing_mode = ?", filters.billingMode);

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const displayExprSql = `f.amount_cents::numeric * ${fxExpr("f.currency", "f.day")}
    / ${fxExpr("$1::text", "f.day")}`;

  const { rows: aggRows } = await db.query(
    `SELECT COUNT(*)::int AS count,
            COALESCE(ROUND(SUM(${displayExprSql})), 0)::bigint AS total,
            COALESCE(SUM(f.tokens), 0)::bigint AS tokens,
            COALESCE(BOOL_OR((${displayExprSql}) IS NULL), false) AS fx_missing
     FROM spend_facts f ${whereSql}`,
    params,
  );
  if (aggRows[0].fx_missing) {
    throw new ResolveError(
      "a fact's currency has no FX rate - sync FX rates first",
      409,
    );
  }

  const limit = Math.min(filters.limit ?? FACT_PAGE_DEFAULT, FACT_PAGE_MAX);
  const offset = filters.offset ?? 0;
  const { rows } = await db.query(
    `SELECT f.id::text AS id, f.day::text AS day, f.vendor, f.model,
            f.tokens::bigint AS tokens, f.amount_cents::bigint AS "amountCents",
            f.currency, f.cost_basis AS "costBasis", f.billing_mode AS "billingMode",
            f.source_ref AS "sourceRef",
            f.person_id AS "personId", p.name AS "personName", p.email AS "personEmail",
            f.product_id AS "productId", pr.name AS "productName",
            i.external_id AS "identityExternalId",
            ROUND(${displayExprSql})::bigint AS "displayCents"
     FROM spend_facts f
     LEFT JOIN people p ON p.id = f.person_id
     LEFT JOIN products pr ON pr.id = f.product_id
     LEFT JOIN identities i ON i.id = f.identity_id
     ${whereSql}
     ORDER BY f.day DESC, f.id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );

  return {
    displayCurrency,
    rows: rows.map((row) => ({
      ...(row as unknown as FactRow),
      tokens: Number(row.tokens),
      amountCents: Number(row.amountCents),
      displayCents: Number(row.displayCents),
    })),
    totalCount: Number(aggRows[0].count),
    totalDisplayCents: Number(aggRows[0].total),
    totalTokens: Number(aggRows[0].tokens),
    limit,
    offset,
  };
}

// ---- drill-down: the raw outcomes behind any outcome count ----

export interface OutcomeFilters {
  from?: string;
  to?: string;
  /** Person uuid, or "unassigned" for person IS NULL. */
  person?: string;
  /** Product uuid. */
  product?: string;
  kind?: string;
  /** AI authorship tag on the outcome (outcomes.tools, spec 5). */
  tool?: string;
  limit?: number;
  offset?: number;
}

export interface OutcomeRow {
  id: string;
  ts: string;
  day: string;
  kind: string;
  /** Count-aware: a manual month entry is one row counting N (spec 7). */
  count: number;
  /** As recorded - the original value and currency, per outcome. */
  valueCents: number | null;
  currency: string | null;
  /** The real record behind the outcome (PR URL, ticket id, entry id). */
  sourceRef: string;
  personId: string | null;
  personName: string | null;
  personEmail: string | null;
  productId: string;
  productName: string;
  identityExternalId: string | null;
  /** AI authorship detected on the record (bot author, co-author trailers). */
  tools: string[];
  revertedAt: string | null;
  revertSourceRef: string | null;
}

export interface OutcomePage {
  rows: OutcomeRow[];
  /** Across the WHOLE filter - so the drill provably sums to its tile: */
  totalCount: number;
  /** liveCount is the number every "outcomes" tile shows (reverted ones */
  liveCount: number;
  /** flip out of it, spec 5) and revertedCount is the rest. */
  revertedCount: number;
  limit: number;
  offset: number;
}

export async function listOutcomes(
  filters: OutcomeFilters = {},
  db: Db = getPool(),
): Promise<OutcomePage> {
  const params: unknown[] = [];
  const where: string[] = [];
  const add = (clause: string, value: unknown): void => {
    params.push(value);
    where.push(clause.replace("?", `$${params.length}`));
  };

  if (filters.from !== undefined) {
    assertDay("from", filters.from);
    add("(o.ts AT TIME ZONE 'UTC')::date >= ?::date", filters.from);
  }
  if (filters.to !== undefined) {
    assertDay("to", filters.to);
    add("(o.ts AT TIME ZONE 'UTC')::date <= ?::date", filters.to);
  }
  if (filters.person === "unassigned") {
    where.push("o.person_id IS NULL");
  } else if (filters.person !== undefined) {
    add("o.person_id = ?::uuid", filters.person);
  }
  if (filters.product !== undefined) add("o.product_id = ?::uuid", filters.product);
  if (filters.kind !== undefined) add("o.kind = ?", filters.kind);
  if (filters.tool !== undefined) add("? = ANY (o.tools)", filters.tool);
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const { rows: aggRows } = await db.query(
    `SELECT COALESCE(SUM(o.count), 0)::bigint AS total,
            COALESCE(SUM(o.count) FILTER (WHERE o.reverted_at IS NULL), 0)::bigint AS live
     FROM outcomes o ${whereSql}`,
    params,
  );

  const limit = Math.min(filters.limit ?? FACT_PAGE_DEFAULT, FACT_PAGE_MAX);
  const offset = filters.offset ?? 0;
  const { rows } = await db.query(
    `SELECT o.id::text AS id, o.ts, (o.ts AT TIME ZONE 'UTC')::date::text AS day,
            o.kind, o.count::int AS count,
            o.value_cents::bigint AS "valueCents", o.currency,
            o.source_ref AS "sourceRef",
            o.person_id AS "personId", p.name AS "personName", p.email AS "personEmail",
            o.product_id AS "productId", pr.name AS "productName",
            i.external_id AS "identityExternalId", o.tools,
            o.reverted_at AS "revertedAt", o.revert_source_ref AS "revertSourceRef"
     FROM outcomes o
     JOIN products pr ON pr.id = o.product_id
     LEFT JOIN people p ON p.id = o.person_id
     LEFT JOIN identities i ON i.id = o.identity_id
     ${whereSql}
     ORDER BY o.ts DESC, o.id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );

  const totalCount = Number(aggRows[0].total);
  const liveCount = Number(aggRows[0].live);
  return {
    rows: rows.map((row) => ({
      ...(row as unknown as OutcomeRow),
      ts: new Date(row.ts).toISOString(),
      count: Number(row.count),
      valueCents: row.valueCents === null ? null : Number(row.valueCents),
      revertedAt: row.revertedAt ? new Date(row.revertedAt).toISOString() : null,
    })),
    totalCount,
    liveCount,
    revertedCount: totalCount - liveCount,
    limit,
    offset,
  };
}

// ---- drill-down: the raw usage_metrics behind any counter-derived number ----

export interface MetricFilters {
  from?: string;
  to?: string;
  vendor?: string;
  /** One or more metric names (the Tools page accept-rate pair). */
  metric?: string[];
  /** Person uuid, or "unassigned" for person IS NULL. */
  person?: string;
  /** Identity uuid - the counters a single key/seat/user produced. */
  key?: string;
  limit?: number;
  offset?: number;
}

export interface MetricRow {
  id: string;
  day: string;
  vendor: string;
  metric: string;
  value: number;
  personId: string | null;
  personName: string | null;
  personEmail: string | null;
  identityExternalId: string | null;
  /** The vendor record behind the counter - what makes it drillable. */
  sourceRef: string;
}

export interface MetricPage {
  rows: MetricRow[];
  /** Across the WHOLE filter - so a counter-derived number provably sums
   * to the rows behind it (accept rates, vendor-estimated costs). */
  totalCount: number;
  totalValue: number;
  /** Per-metric totals across the whole filter (the rate's inputs). */
  byMetric: { metric: string; value: number; rowCount: number }[];
  limit: number;
  offset: number;
}

export async function listMetrics(
  filters: MetricFilters = {},
  db: Db = getPool(),
): Promise<MetricPage> {
  const params: unknown[] = [];
  const where: string[] = [];
  const add = (clause: string, value: unknown): void => {
    params.push(value);
    where.push(clause.replace("?", `$${params.length}`));
  };

  if (filters.from !== undefined) {
    assertDay("from", filters.from);
    add("m.day >= ?::date", filters.from);
  }
  if (filters.to !== undefined) {
    assertDay("to", filters.to);
    add("m.day <= ?::date", filters.to);
  }
  if (filters.vendor !== undefined) add("m.vendor = ?", filters.vendor);
  if (filters.metric !== undefined && filters.metric.length > 0) {
    add("m.metric = ANY (?)", filters.metric);
  }
  if (filters.person === "unassigned") {
    where.push("m.person_id IS NULL");
  } else if (filters.person !== undefined) {
    add("m.person_id = ?::uuid", filters.person);
  }
  if (filters.key !== undefined) add("m.identity_id = ?::uuid", filters.key);
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const { rows: aggRows } = await db.query(
    `SELECT m.metric, COUNT(*)::int AS count, COALESCE(SUM(m.value), 0)::bigint AS value
     FROM usage_metrics m ${whereSql}
     GROUP BY m.metric ORDER BY m.metric`,
    params,
  );

  const limit = Math.min(filters.limit ?? FACT_PAGE_DEFAULT, FACT_PAGE_MAX);
  const offset = filters.offset ?? 0;
  const { rows } = await db.query(
    `SELECT m.id::text AS id, m.day::text AS day, m.vendor, m.metric,
            m.value::bigint AS value,
            m.person_id AS "personId", p.name AS "personName", p.email AS "personEmail",
            i.external_id AS "identityExternalId", m.source_ref AS "sourceRef"
     FROM usage_metrics m
     LEFT JOIN people p ON p.id = m.person_id
     LEFT JOIN identities i ON i.id = m.identity_id
     ${whereSql}
     ORDER BY m.day DESC, m.metric, m.id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );

  const byMetric = aggRows.map((row) => ({
    metric: row.metric as string,
    value: Number(row.value),
    rowCount: Number(row.count),
  }));
  return {
    rows: rows.map((row) => ({
      ...(row as unknown as MetricRow),
      value: Number(row.value),
    })),
    totalCount: byMetric.reduce((sum, m) => sum + m.rowCount, 0),
    totalValue: byMetric.reduce((sum, m) => sum + m.value, 0),
    byMetric,
    limit,
    offset,
  };
}

// ---- drill-down: sync runs behind the connector-health tile ----

export interface SyncRunRow {
  id: number;
  connector: string;
  status: "running" | "success" | "error";
  startedAt: string;
  finishedAt: string | null;
  rowsSynced: number;
  /** The vendor's error, verbatim. */
  error: string | null;
}

export const RUNS_MAX = 500;

export async function listSyncRuns(
  opts: { vendor?: string; limit?: number } = {},
  db: Db = getPool(),
): Promise<SyncRunRow[]> {
  const limit = Math.min(opts.limit ?? 200, RUNS_MAX);
  const { rows } = await db.query(
    `SELECT id, connector, status, started_at AS "startedAt",
            finished_at AS "finishedAt", COALESCE(rows_synced, 0)::bigint AS rows, error
     FROM sync_runs
     WHERE $1::text IS NULL OR connector = $1
     ORDER BY started_at DESC, id DESC
     LIMIT $2`,
    [opts.vendor ?? null, limit],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    connector: row.connector,
    status: row.status,
    startedAt: new Date(row.startedAt).toISOString(),
    finishedAt: row.finishedAt ? new Date(row.finishedAt).toISOString() : null,
    rowsSynced: Number(row.rows),
    error: row.error,
  }));
}

// ---- cmd-K search: any person, product, or vendor (spec 10) ----

export interface SearchResults {
  people: { id: string; name: string | null; email: string; status: string }[];
  products: { id: string; name: string; archived: boolean }[];
  vendors: { vendor: string; displayName: string; connected: boolean }[];
}

const SEARCH_LIMIT = 8;

function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

export async function searchEverything(
  q: string,
  db: Db = getPool(),
): Promise<SearchResults> {
  const needle = q.trim().toLowerCase();
  const pattern = likePattern(needle);

  const { rows: people } = await db.query(
    `SELECT id, name, email, status FROM people
     WHERE merged_into IS NULL AND (name ILIKE $1 OR email ILIKE $1)
     ORDER BY lower(email) LIMIT $2`,
    [pattern, SEARCH_LIMIT],
  );
  const { rows: products } = await db.query(
    `SELECT id, name, (archived_at IS NOT NULL) AS archived FROM products
     WHERE name ILIKE $1 ORDER BY lower(name) LIMIT $2`,
    [pattern, SEARCH_LIMIT],
  );
  // Vendors = the registry (connectable) plus anything that ever spent
  // (invoice vendors, manual entries), deduped.
  const { rows: dataVendors } = await db.query(
    `SELECT DISTINCT vendor FROM rollup_daily WHERE vendor ILIKE $1 LIMIT $2`,
    [pattern, SEARCH_LIMIT],
  );
  const connected = new Set((await listConnectedRows(db)).map((r) => r.vendor));
  const vendors = new Map<string, { vendor: string; displayName: string; connected: boolean }>();
  for (const connector of listConnectors()) {
    if (
      connector.vendor.includes(needle) ||
      connector.displayName.toLowerCase().includes(needle)
    ) {
      vendors.set(connector.vendor, {
        vendor: connector.vendor,
        displayName: connector.displayName,
        connected: connected.has(connector.vendor),
      });
    }
  }
  for (const row of dataVendors) {
    if (!vendors.has(row.vendor)) {
      vendors.set(row.vendor, {
        vendor: row.vendor,
        displayName: row.vendor,
        connected: connected.has(row.vendor),
      });
    }
  }

  return {
    people: people.map((p) => ({ id: p.id, name: p.name, email: p.email, status: p.status })),
    products: products.map((p) => ({ id: p.id, name: p.name, archived: p.archived })),
    vendors: [...vendors.values()]
      .sort((a, b) => (a.vendor < b.vendor ? -1 : 1))
      .slice(0, SEARCH_LIMIT),
  };
}
