import { getPool, type Db } from "./db";
// The index import matters: it is what registers the built-in connectors,
// so vendor search works no matter which route loads first.
import { listConnectedRows, listConnectors } from "./connectors";
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
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDay(name: string, value: string): void {
  if (!DATE_RE.test(value)) {
    throw new ResolveError(`${name} must be YYYY-MM-DD`, 400);
  }
}

/** Per-day USD-cents -> display-currency-cents, as a LATERAL alias `d`.
 * $1 must be the display currency in every query that embeds this. */
function displayLateral(rowAlias: string): string {
  return `CROSS JOIN LATERAL (
    SELECT ${rowAlias}.amount_usd_cents::numeric / ${fxExpr("$1::text", `${rowAlias}.day`)} AS cents
  ) d`;
}

export interface OverviewTotals {
  totalCents: number;
  estimatedCents: number;
  invoicedCents: number;
  /** Spend with a person or a product. */
  assignedCents: number;
  /** No person AND no product - the visible Unassigned bucket. */
  unassignedCents: number;
  /** assigned / total, one decimal; null when there is no spend. */
  coveragePct: number | null;
  factCount: number;
}

export interface TrendPoint {
  day: string;
  cents: number;
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
  const totalCents = Number(t.total);
  const assignedCents = Number(t.assigned);
  const totals: OverviewTotals = {
    totalCents,
    estimatedCents: Number(t.estimated),
    invoicedCents: Number(t.invoiced),
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
  basis?: "estimated" | "invoiced";
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
  if (filters.basis !== undefined) add("f.cost_basis = ?", filters.basis);

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
            f.currency, f.cost_basis AS "costBasis", f.source_ref AS "sourceRef",
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
