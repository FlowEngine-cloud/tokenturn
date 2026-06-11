import type { Pool } from "pg";
import { getPool, type Db } from "./db";
import { unknownCurrencies } from "./fx";
import { logger } from "./logger";
import { assertDay, displayLateral, type TrendPoint } from "./display";
import { rangeDays } from "./range";
import { ResolveError } from "./resolve";
import { fxExpr, recomputeRollups } from "./rollup";
import { getSetting } from "./settings";
import { effectiveTagsSql } from "./tag-sql";

/**
 * Products = the user-defined ROI rows (spec section 7; the table keeps
 * its name, only the language changed). A product is anything that
 * spends AI money: a name, where its spend comes from (a connector, a
 * key/project, the SDK, or manual entry), and its success metric - or none.
 *
 * - Spend reaches a product through identity routing (a key/tag points at
 *   it, lib/tags.ts), through connector outcomes (sync.ts), or through
 *   manual entries (tools with no API). This module owns the catalog and
 *   the manual path.
 * - default value per outcome: applied at READ time to outcomes that carry
 *   no explicit value (track() and manual entries override per event), so
 *   changing it re-values history retroactively - the ledger's standard
 *   retroactivity rule.
 * - unit cost = spend / outcomes over the selected range; ROI = value /
 *   spend. Both are null - never invented - when their inputs are missing
 *   (a product with no outcomes gets plain cost, no fake ROI; spec 7).
 * - Products archive, never delete (spec 4): they leave current views,
 *   history and drill-downs stay intact.
 */

export const ATTRIBUTIONS = ["connector", "key", "sdk", "manual"] as const;
export const OUTCOME_KINDS = [
  "none",
  "github_pr",
  "issue_done",
  "sdk_event",
  "manual",
] as const;
export type Attribution = (typeof ATTRIBUTIONS)[number];
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

export function isAttribution(v: unknown): v is Attribution {
  return typeof v === "string" && (ATTRIBUTIONS as readonly string[]).includes(v);
}

export function isOutcomeKind(v: unknown): v is OutcomeKind {
  return typeof v === "string" && (OUTCOME_KINDS as readonly string[]).includes(v);
}

/**
 * Built-in default products per connector outcome kind (spec 7: merged PRs
 * built in for coding; "Issues done" for the Jira/Linear integrations).
 * Created on first use when no product with that outcome_kind exists, so
 * connector outcomes always have an ROI row to land in.
 */
const DEFAULT_OUTCOME_PRODUCTS: Record<string, string> = {
  github_pr: "Coding",
  issue_done: "Issues done",
};

/** Resolve the product an outcome kind routes to (oldest live match wins). */
export async function resolveOutcomeProduct(
  db: Db,
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

/** Money entered by hand: non-negative integer cents. */
export function cleanCents(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

export function cleanCurrency(v: unknown): string | null {
  return typeof v === "string" && /^[A-Z]{3}$/.test(v) ? v : null;
}

/** A calendar month, "YYYY-MM". */
export function cleanMonth(v: unknown): string | null {
  return typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v) ? v : null;
}

/** A UTC day, "YYYY-MM-DD" (the global date-range picker's grain). */
export function cleanDay(v: unknown): string | null {
  return typeof v === "string" &&
    /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(v)
    ? v
    : null;
}

/**
 * The default value per outcome from a request body: undefined = untouched,
 * null = clear, {cents, currency} = set. Throws ResolveError(400) on
 * invalid input - routes map it to HTTP.
 */
export function parseDefaultValue(
  body: Record<string, unknown>,
): { cents: number; currency: string } | null | undefined {
  const rawCents = body.defaultValueCents;
  const rawCurrency = body.defaultValueCurrency;
  if (rawCents === undefined && rawCurrency === undefined) return undefined;
  if (rawCents === null) {
    if (rawCurrency !== undefined && rawCurrency !== null) {
      throw new ResolveError(
        "defaultValueCurrency must be null when defaultValueCents is",
        400,
      );
    }
    return null;
  }
  const cents = cleanCents(rawCents);
  if (cents === null) {
    throw new ResolveError("defaultValueCents must be a non-negative integer", 400);
  }
  const currency = cleanCurrency(rawCurrency);
  if (currency === null) {
    throw new ResolveError("defaultValueCurrency must be a 3-letter code (e.g. USD)", 400);
  }
  return { cents, currency };
}

export interface Product {
  id: string;
  name: string;
  attribution: Attribution;
  outcomeKind: OutcomeKind;
  defaultValueCents: number | null;
  defaultValueCurrency: string | null;
  archivedAt: string | null;
  createdAt: string;
}

export interface ProductListItem extends Product {
  /** All-time, from the daily rollups - the same numbers every chart shows. */
  spendUsdCents: number;
  /** All-time live outcomes (reverted ones excluded). */
  outcomeCount: number;
}

const PRODUCT_COLUMNS = `
  p.id, p.name, p.attribution, p.outcome_kind AS "outcomeKind",
  p.default_value_cents::int AS "defaultValueCents",
  p.default_value_currency AS "defaultValueCurrency",
  p.archived_at AS "archivedAt", p.created_at AS "createdAt"
`;

function toProduct(row: Record<string, unknown>): Product {
  return {
    ...(row as unknown as Product),
    archivedAt: row.archivedAt ? new Date(row.archivedAt as string).toISOString() : null,
    createdAt: new Date(row.createdAt as string).toISOString(),
  };
}

/** Archived products leave current views (spec 4): hidden unless asked for. */
export async function listProducts(
  opts: { includeArchived?: boolean } = {},
  db: Db = getPool(),
): Promise<ProductListItem[]> {
  const { rows } = await db.query(
    `SELECT ${PRODUCT_COLUMNS},
            COALESCE(s.amount, 0)::bigint AS "spendUsdCents",
            COALESCE(o.live, 0)::int AS "outcomeCount"
     FROM products p
     LEFT JOIN LATERAL (
       SELECT SUM(r.amount_usd_cents) AS amount
       FROM rollup_daily r WHERE r.product_id = p.id
     ) s ON true
     LEFT JOIN LATERAL (
       SELECT SUM(r.outcome_count) AS live
       FROM rollup_outcomes_daily r
       WHERE r.product_id = p.id AND r.kind NOT LIKE '%:reverted'
     ) o ON true
     WHERE $1 OR p.archived_at IS NULL
     ORDER BY lower(p.name)`,
    [opts.includeArchived ?? false],
  );
  return rows.map((row) => ({
    ...toProduct(row),
    spendUsdCents: Number(row.spendUsdCents),
    outcomeCount: row.outcomeCount as number,
  }));
}

export interface ProductInput {
  name: string;
  attribution: Attribution;
  outcomeKind?: OutcomeKind;
  defaultValue?: { cents: number; currency: string } | null;
}

export async function createProduct(
  input: ProductInput,
  db: Db = getPool(),
): Promise<Product> {
  try {
    const { rows } = await db.query(
      `INSERT INTO products AS p
         (name, attribution, outcome_kind, default_value_cents, default_value_currency)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${PRODUCT_COLUMNS}`,
      [
        input.name,
        input.attribution,
        input.outcomeKind ?? "none",
        input.defaultValue?.cents ?? null,
        input.defaultValue?.currency ?? null,
      ],
    );
    const product = toProduct(rows[0]);
    logger.info("product created", { productId: product.id, name: product.name });
    return product;
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new ResolveError("a product with that name already exists", 409);
    }
    throw error;
  }
}

export interface ProductUpdate {
  name?: string;
  attribution?: Attribution;
  outcomeKind?: OutcomeKind;
  /** Set the default value per outcome, or clear it (null). */
  defaultValue?: { cents: number; currency: string } | null;
  /** true archives (leaves current views, history intact); false restores. */
  archived?: boolean;
}

export async function updateProduct(
  id: string,
  update: ProductUpdate,
  db: Db = getPool(),
): Promise<Product> {
  if (
    update.name === undefined &&
    update.attribution === undefined &&
    update.outcomeKind === undefined &&
    update.defaultValue === undefined &&
    update.archived === undefined
  ) {
    throw new ResolveError(
      "nothing to change: pass name, attribution, outcomeKind, defaultValue and/or archived",
      400,
    );
  }
  try {
    const { rows } = await db.query(
      `UPDATE products p SET
         name = COALESCE($2, p.name),
         attribution = COALESCE($3, p.attribution),
         outcome_kind = COALESCE($4, p.outcome_kind),
         default_value_cents =
           CASE WHEN $5 THEN $6::bigint ELSE p.default_value_cents END,
         default_value_currency =
           CASE WHEN $5 THEN $7::text ELSE p.default_value_currency END,
         archived_at = CASE
           WHEN $8::boolean IS NULL THEN p.archived_at
           WHEN $8 THEN COALESCE(p.archived_at, now())
           ELSE NULL
         END,
         updated_at = now()
       WHERE p.id = $1
       RETURNING ${PRODUCT_COLUMNS}`,
      [
        id,
        update.name ?? null,
        update.attribution ?? null,
        update.outcomeKind ?? null,
        update.defaultValue !== undefined,
        update.defaultValue?.cents ?? null,
        update.defaultValue?.currency ?? null,
        update.archived ?? null,
      ],
    );
    if (rows.length === 0) throw new ResolveError("product not found", 404);
    const product = toProduct(rows[0]);
    logger.info("product updated", { productId: id, ...update });
    return product;
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new ResolveError("a product with that name already exists", 409);
    }
    throw error;
  }
}

export interface DayRange {
  /** Inclusive UTC day, YYYY-MM-DD; absent = unbounded. */
  from?: string;
  to?: string;
}

/**
 * The unit a product measures itself in (spec 7: $/merge, $/ticket, $/user).
 * github_pr products count merges; an event product whose live outcomes are
 * all one named kind uses that name ("ticket_resolved"); anything mixed or
 * hand-counted is a plain "outcome". null = no outcome metric at all - the
 * product shows cost per active user instead, never a fake ROI.
 */
export function productUnit(
  outcomeKind: OutcomeKind,
  liveKinds: string[],
): string | null {
  if (outcomeKind === "none") return null;
  if (outcomeKind === "github_pr") return "merge";
  if (outcomeKind === "issue_done") return "issue";
  if (liveKinds.length === 1 && liveKinds[0] !== "manual") return liveKinds[0];
  return "outcome";
}

export interface ProductMetrics {
  /** From the daily rollups, in the org's display currency. */
  spendCents: number;
  spendByBasis: { estimated: number; invoiced: number; manual: number };
  factCount: number;
  /** Live outcomes; reverted ones sit in revertedOutcomes, never counted. */
  outcomes: number;
  /** How many of those carry an explicit value (the rest use the default). */
  valuedOutcomes: number;
  revertedOutcomes: number;
  /** spend / outcomes over the range; null when there are no outcomes. */
  unitCostCents: number | null;
  /** What one unit is called; null = no outcome metric (cost/user instead). */
  unit: string | null;
  /** Explicit values + the product default for unvalued outcomes; null when
   * neither exists - no fake ROI (spec 7). */
  valueCents: number | null;
  /** value / spend, 2 decimals; null when value or spend is missing. */
  roi: number | null;
  /** People with spend attributed on this product in range. */
  activeUsers: number;
  /** spend / activeUsers; null when nobody's spend is attributed. */
  costPerUserCents: number | null;
}

export interface ManualEntry {
  id: string;
  kind: "cost" | "outcomes";
  month: string;
  amountCents: number | null;
  currency: string | null;
  outcomeCount: number | null;
  valueCents: number | null;
  valueCurrency: string | null;
  note: string | null;
  updatedAt: string;
}

export interface ProductVendorSpend {
  vendor: string;
  cents: number;
  factCount: number;
}

export interface ProductPersonRow {
  /** null = spend with no person on this product (shared keys, agents,
   * manual entries) - never hidden. */
  personId: string | null;
  name: string | null;
  email: string | null;
  cents: number;
  factCount: number;
  /** Live outcomes this person earned for the product in range. */
  outcomeCount: number;
}

export interface ProductDailyRow {
  day: string;
  vendor: string;
  cents: number;
  factCount: number;
  tokens: number;
}

export interface ProductKeyRow {
  id: string;
  vendor: string;
  externalId: string;
  kind: string;
  displayName: string | null;
  tags: string[];
  /** Spend this key produced in range (raw facts - rollups carry no key
   * grain; equals the /drill?key= total by construction). */
  cents: number;
  factCount: number;
  /** All-time last fact day - null = never used. */
  lastUsedDay: string | null;
}

export interface ProductOutcomeKind {
  kind: string;
  count: number;
}

export interface ProductDetail {
  displayCurrency: string;
  from: string | null;
  to: string | null;
  product: Product;
  metrics: ProductMetrics;
  outcomesByKind: ProductOutcomeKind[];
  byVendor: ProductVendorSpend[];
  byPerson: ProductPersonRow[];
  trend: TrendPoint[];
  daily: ProductDailyRow[];
  /** Keys routed to this product (identities.product_id, spec 7b). */
  keys: ProductKeyRow[];
  manualEntries: ManualEntry[];
}

interface OutcomeStats {
  outcomes: number;
  valued: number;
  reverted: number;
  explicitDisplay: number;
  defaultDisplay: number;
  byKind: ProductOutcomeKind[];
}

/** Apply the no-fake-ROI rule (spec 7): value exists when an outcome carries
 * an explicit value or the product default covers the unvalued ones. */
function valueAndRoi(
  product: Pick<Product, "defaultValueCents">,
  stats: Pick<OutcomeStats, "outcomes" | "valued" | "explicitDisplay" | "defaultDisplay">,
  spendCents: number,
): { valueCents: number | null; roi: number | null } {
  const hasValue =
    stats.valued > 0 ||
    (product.defaultValueCents !== null && stats.outcomes > stats.valued);
  const valueCents = hasValue
    ? Math.round(stats.explicitDisplay + stats.defaultDisplay)
    : null;
  return {
    valueCents,
    roi:
      valueCents !== null && spendCents > 0
        ? Math.round((valueCents / spendCents) * 100) / 100
        : null,
  };
}

function assertRange(range: DayRange): void {
  if (range.from !== undefined) assertDay("from", range.from);
  if (range.to !== undefined) assertDay("to", range.to);
  if (range.from && range.to && range.from > range.to) {
    throw new ResolveError(`from ${range.from} is after to ${range.to}`, 400);
  }
}

const FX_MISSING = (currency: string) =>
  new ResolveError(
    `no FX rate for the display currency ${currency} - sync FX rates first`,
    409,
  );

/** Per-day display-currency value of explicit outcome values plus the
 * product default for unvalued ones - the read-time default-value math.
 * Expects $1 = display currency and (defCents, defCcy) param slots. */
function outcomeValueSql(
  alias: string,
  defCents: string,
  defCcy: string,
): { explicit: string; fallback: string } {
  return {
    explicit: `${alias}.value_usd_cents / ${fxExpr("$1::text", `${alias}.day`)}`,
    fallback: `(${alias}.outcome_count - ${alias}.valued_count) * ${defCents}::bigint
      * ${fxExpr(`${defCcy}::text`, `${alias}.day`)} / ${fxExpr("$1::text", `${alias}.day`)}`,
  };
}

const LIVE_SQL = "kind NOT LIKE '%:reverted'";

/**
 * One product over the selected range (spec 10 page 3 click-through), in the
 * org's display currency: spend by basis/vendor/person/day, its outcomes and
 * unit cost in its own unit, value and ROI, the keys routed to it, and its
 * manual entries. Every number equals listFacts/listOutcomes under the drill
 * filter the UI links it to (spec 3). Archived products stay fully readable -
 * history never disappears.
 */
export async function productDetail(
  id: string,
  range: DayRange = {},
  db: Db = getPool(),
): Promise<ProductDetail> {
  assertRange(range);
  const { rows: products } = await db.query(
    `SELECT ${PRODUCT_COLUMNS} FROM products p WHERE p.id = $1`,
    [id],
  );
  if (products.length === 0) throw new ResolveError("product not found", 404);
  const product = toProduct(products[0]);

  const displayCurrency = await getSetting("display_currency", db);
  const params = [displayCurrency, range.from ?? null, range.to ?? null, id];
  const rangeSql = `($2::date IS NULL OR r.day >= $2) AND ($3::date IS NULL OR r.day <= $3)`;

  // Daily breakdown per vendor - the rollups at full grain for this product.
  const { rows: dailyRows } = await db.query(
    `SELECT r.day::text AS day, r.vendor,
            ROUND(SUM(d.cents))::bigint AS cents,
            SUM(r.fact_count)::int AS facts,
            SUM(r.tokens)::bigint AS tokens,
            COALESCE(BOOL_OR(d.cents IS NULL), false) AS fx_missing
     FROM rollup_daily r
     ${displayLateral("r")}
     WHERE ${rangeSql} AND r.product_id = $4
     GROUP BY r.day, r.vendor
     ORDER BY r.day DESC, r.vendor`,
    params,
  );
  if (dailyRows.some((row) => row.fx_missing)) throw FX_MISSING(displayCurrency);
  const daily: ProductDailyRow[] = dailyRows.map((row) => ({
    day: row.day,
    vendor: row.vendor,
    cents: Number(row.cents),
    factCount: Number(row.facts),
    tokens: Number(row.tokens),
  }));

  // By-vendor, totals and the trend, derived from the same daily rows so
  // the views can never disagree.
  const byVendorMap = new Map<string, ProductVendorSpend>();
  const trendMap = new Map<string, number>();
  let spendCents = 0;
  let factCount = 0;
  for (const row of daily) {
    spendCents += row.cents;
    factCount += row.factCount;
    const vendor = byVendorMap.get(row.vendor) ?? {
      vendor: row.vendor,
      cents: 0,
      factCount: 0,
    };
    vendor.cents += row.cents;
    vendor.factCount += row.factCount;
    byVendorMap.set(row.vendor, vendor);
    trendMap.set(row.day, (trendMap.get(row.day) ?? 0) + row.cents);
  }
  const byVendor = [...byVendorMap.values()].sort(
    (a, b) => b.cents - a.cents || a.vendor.localeCompare(b.vendor),
  );
  // Trend axis: the picker range; for an all-time read, the data's own span.
  const from = range.from ?? daily.at(-1)?.day ?? null;
  const to = range.to ?? daily[0]?.day ?? null;
  const trend: TrendPoint[] =
    from !== null && to !== null
      ? rangeDays(from, to).map((day) => ({ day, cents: trendMap.get(day) ?? 0 }))
      : [];

  const { rows: basisRows } = await db.query(
    `SELECT r.cost_basis AS basis, ROUND(SUM(d.cents))::bigint AS cents
     FROM rollup_daily r
     ${displayLateral("r")}
     WHERE ${rangeSql} AND r.product_id = $4
     GROUP BY r.cost_basis`,
    params,
  );
  const spendByBasis = { estimated: 0, invoiced: 0, manual: 0 };
  for (const row of basisRows) {
    spendByBasis[row.basis as keyof typeof spendByBasis] = Number(row.cents);
  }

  // Outcomes per kind, live vs reverted, with the read-time default-value
  // math (explicit values roll up in value_usd_cents; outcomes without one
  // take the product default, FX-converted on their day).
  const value = outcomeValueSql("r", "$5", "$6");
  const { rows: kindRows } = await db.query(
    `SELECT CASE WHEN r.${LIVE_SQL} THEN r.kind
            ELSE left(r.kind, -length(':reverted')) END AS kind,
            (r.${LIVE_SQL}) AS live,
            SUM(r.outcome_count)::int AS outcomes,
            SUM(r.valued_count)::int AS valued,
            SUM(${value.explicit}) AS explicit_display,
            SUM(${value.fallback}) AS default_display,
            COALESCE(BOOL_OR((${fxExpr("$1::text", "r.day")}) IS NULL
              OR ($6::text IS NOT NULL
                  AND (${fxExpr("$6::text", "r.day")}) IS NULL)), false) AS fx_missing
     FROM rollup_outcomes_daily r
     WHERE ${rangeSql} AND r.product_id = $4
     GROUP BY 1, 2 ORDER BY 3 DESC, 1`,
    [...params, product.defaultValueCents, product.defaultValueCurrency],
  );
  if (kindRows.some((row) => row.fx_missing)) throw FX_MISSING(displayCurrency);
  const stats: OutcomeStats = {
    outcomes: 0,
    valued: 0,
    reverted: 0,
    explicitDisplay: 0,
    defaultDisplay: 0,
    byKind: [],
  };
  for (const row of kindRows) {
    if (row.live) {
      stats.outcomes += Number(row.outcomes);
      stats.valued += Number(row.valued);
      stats.explicitDisplay += Number(row.explicit_display ?? 0);
      stats.defaultDisplay += Number(row.default_display ?? 0);
      stats.byKind.push({ kind: row.kind, count: Number(row.outcomes) });
    } else {
      stats.reverted += Number(row.outcomes);
    }
  }

  // By person: spend (rollup person grain) merged with live outcomes - the
  // person NULL row is shared/agent/manual spend, visible, never dropped.
  const { rows: personSpend } = await db.query(
    `SELECT r.person_id AS "personId", p.name, p.email,
            ROUND(SUM(d.cents))::bigint AS cents,
            SUM(r.fact_count)::int AS facts
     FROM rollup_daily r
     LEFT JOIN people p ON p.id = r.person_id
     ${displayLateral("r")}
     WHERE ${rangeSql} AND r.product_id = $4
     GROUP BY r.person_id, p.name, p.email`,
    params,
  );
  const { rows: personOutcomes } = await db.query(
    `SELECT r.person_id AS "personId", p.name, p.email,
            SUM(r.outcome_count)::int AS outcomes
     FROM rollup_outcomes_daily r
     LEFT JOIN people p ON p.id = r.person_id
     WHERE ($1::date IS NULL OR r.day >= $1) AND ($2::date IS NULL OR r.day <= $2)
       AND r.product_id = $3 AND r.${LIVE_SQL}
     GROUP BY r.person_id, p.name, p.email`,
    [range.from ?? null, range.to ?? null, id],
  );
  const byPersonMap = new Map<string | null, ProductPersonRow>();
  const personRow = (row: {
    personId: string | null;
    name: string | null;
    email: string | null;
  }): ProductPersonRow => {
    let entry = byPersonMap.get(row.personId);
    if (!entry) {
      entry = {
        personId: row.personId,
        name: row.name,
        email: row.email,
        cents: 0,
        factCount: 0,
        outcomeCount: 0,
      };
      byPersonMap.set(row.personId, entry);
    }
    return entry;
  };
  for (const row of personSpend) {
    const entry = personRow(row);
    entry.cents = Number(row.cents);
    entry.factCount = Number(row.facts);
  }
  for (const row of personOutcomes) {
    personRow(row).outcomeCount = Number(row.outcomes);
  }
  const byPerson = [...byPersonMap.values()].sort(
    (a, b) =>
      b.cents - a.cents ||
      b.outcomeCount - a.outcomeCount ||
      (a.email ?? "￿").localeCompare(b.email ?? "￿"),
  );
  const activeUsers = byPerson.filter(
    (row) => row.personId !== null && row.factCount > 0,
  ).length;

  // Keys routed to this product, with the spend they produced in range and
  // their all-time last use. Raw facts - rollups carry no key grain, so the
  // number IS its own drill (/drill?key=).
  const factDisplaySql = `f.amount_cents::numeric * ${fxExpr("f.currency", "f.day")}
    / ${fxExpr("$1::text", "f.day")}`;
  const { rows: keyRows } = await db.query(
    `SELECT i.id, i.vendor, i.external_id AS "externalId", i.kind,
            i.display_name AS "displayName",
            ${effectiveTagsSql("i")} AS tags,
            COALESCE(ROUND(s.cents), 0)::bigint AS cents,
            COALESCE(s.facts, 0)::int AS facts,
            u.last_day::text AS "lastUsedDay",
            COALESCE(s.fx_missing, false) AS fx_missing
     FROM identities i
     LEFT JOIN LATERAL (
       SELECT SUM(${factDisplaySql}) AS cents, COUNT(*)::int AS facts,
              BOOL_OR((${factDisplaySql}) IS NULL) AS fx_missing
       FROM spend_facts f
       WHERE f.identity_id = i.id
         AND ($2::date IS NULL OR f.day >= $2) AND ($3::date IS NULL OR f.day <= $3)
     ) s ON true
     LEFT JOIN LATERAL (
       SELECT MAX(f.day) AS last_day FROM spend_facts f WHERE f.identity_id = i.id
     ) u ON true
     WHERE i.product_id = $4
     ORDER BY i.vendor, i.kind, i.external_id`,
    params,
  );
  if (keyRows.some((row) => row.fx_missing)) throw FX_MISSING(displayCurrency);

  const { rows: entries } = await db.query(
    `SELECT id, kind, to_char(month, 'YYYY-MM') AS month,
            amount_cents::int AS "amountCents", currency,
            outcome_count AS "outcomeCount", value_cents::int AS "valueCents",
            value_currency AS "valueCurrency", note, updated_at AS "updatedAt"
     FROM manual_entries WHERE product_id = $1
     ORDER BY month DESC, kind`,
    [id],
  );

  const metrics: ProductMetrics = {
    spendCents,
    spendByBasis,
    factCount,
    outcomes: stats.outcomes,
    valuedOutcomes: stats.valued,
    revertedOutcomes: stats.reverted,
    unitCostCents:
      stats.outcomes > 0 ? Math.round(spendCents / stats.outcomes) : null,
    unit: productUnit(
      product.outcomeKind,
      stats.byKind.map((k) => k.kind),
    ),
    ...valueAndRoi(product, stats, spendCents),
    activeUsers,
    costPerUserCents:
      activeUsers > 0 ? Math.round(spendCents / activeUsers) : null,
  };

  return {
    displayCurrency,
    from,
    to,
    product,
    metrics,
    outcomesByKind: stats.byKind,
    byVendor,
    byPerson,
    trend,
    daily,
    keys: keyRows.map((row) => ({
      id: row.id,
      vendor: row.vendor,
      externalId: row.externalId,
      kind: row.kind,
      displayName: row.displayName,
      tags: [...new Set(row.tags as string[])],
      cents: Number(row.cents),
      factCount: Number(row.facts),
      lastUsedDay: row.lastUsedDay,
    })),
    manualEntries: entries.map((row) => ({
      ...(row as unknown as ManualEntry),
      updatedAt: new Date(row.updatedAt as string).toISOString(),
    })),
  };
}

// ---- the ROI list (spec 10 page 3): every user-defined row at a glance ----

export interface ProductViewRow {
  id: string;
  name: string;
  attribution: Attribution;
  outcomeKind: OutcomeKind;
  /** Only when the caller asked for archived rows (the Report month must
   * sum to the whole ledger - spec 4: rows leave views, never totals). */
  archived: boolean;
  spendCents: number;
  /** Tokens behind the spend, from the same rollup rows. */
  tokens: number;
  /** The vendors the spend came from in range - the ROI page's vendor filter. */
  vendors: string[];
  factCount: number;
  /** Live outcomes in range; reverted ones never count (spec 5). */
  outcomeCount: number;
  revertedCount: number;
  unitCostCents: number | null;
  /** What one unit is called ($/merge, $/ticket_resolved); null = no
   * outcome metric - costPerUserCents is the product's number instead. */
  unit: string | null;
  valueCents: number | null;
  roi: number | null;
  activeUsers: number;
  costPerUserCents: number | null;
  /** Per-day cents over the range's days, zero-filled (sparkline). */
  trend: number[];
}

export interface ProductsViewData {
  displayCurrency: string;
  from: string;
  to: string;
  days: string[];
  products: ProductViewRow[];
}

/**
 * Per ROI row over the range: spend and its own metric in its own unit
 * ($/merge, $/ticket, $/user) - manual products included. Archived products
 * leave this view (spec 4); their history stays in every drill-down. The
 * Report asks for them back (includeArchived) so a month's total never loses
 * money to an archive click. Every number equals listFacts/listOutcomes
 * under the product's drill filter.
 */
export async function productsView(
  range: { from: string; to: string },
  db: Db = getPool(),
  opts: { includeArchived?: boolean } = {},
): Promise<ProductsViewData> {
  assertDay("from", range.from);
  assertDay("to", range.to);
  if (range.from > range.to) {
    throw new ResolveError(`from ${range.from} is after to ${range.to}`, 400);
  }
  const displayCurrency = await getSetting("display_currency", db);
  const includeArchived = opts.includeArchived ?? false;
  const params = [displayCurrency, range.from, range.to, includeArchived];

  const { rows: roster } = await db.query(
    `SELECT ${PRODUCT_COLUMNS} FROM products p
     WHERE $1 OR p.archived_at IS NULL ORDER BY lower(p.name)`,
    [includeArchived],
  );
  const products = roster.map(toProduct);

  const { rows: spendRows } = await db.query(
    `SELECT r.product_id AS "productId",
            ROUND(SUM(d.cents))::bigint AS cents,
            SUM(r.tokens)::bigint AS tokens,
            array_agg(DISTINCT r.vendor) AS vendors,
            SUM(r.fact_count)::int AS facts,
            COUNT(DISTINCT r.person_id) FILTER (WHERE r.person_id IS NOT NULL)::int
              AS users,
            COALESCE(BOOL_OR(d.cents IS NULL), false) AS fx_missing
     FROM rollup_daily r
     JOIN products p ON p.id = r.product_id AND ($4 OR p.archived_at IS NULL)
     ${displayLateral("r")}
     WHERE r.day BETWEEN $2::date AND $3::date
     GROUP BY r.product_id`,
    params,
  );
  if (spendRows.some((row) => row.fx_missing)) throw FX_MISSING(displayCurrency);

  const { rows: trendRows } = await db.query(
    `SELECT r.product_id AS "productId", r.day::text AS day,
            ROUND(SUM(d.cents))::bigint AS cents
     FROM rollup_daily r
     JOIN products p ON p.id = r.product_id AND ($4 OR p.archived_at IS NULL)
     ${displayLateral("r")}
     WHERE r.day BETWEEN $2::date AND $3::date
     GROUP BY r.product_id, r.day`,
    params,
  );

  const value = outcomeValueSql("r", "p.default_value_cents", "p.default_value_currency");
  const { rows: outcomeRows } = await db.query(
    `SELECT r.product_id AS "productId",
            CASE WHEN r.${LIVE_SQL} THEN r.kind
            ELSE left(r.kind, -length(':reverted')) END AS kind,
            (r.${LIVE_SQL}) AS live,
            SUM(r.outcome_count)::int AS outcomes,
            SUM(r.valued_count)::int AS valued,
            SUM(${value.explicit}) AS explicit_display,
            SUM(${value.fallback}) AS default_display,
            COALESCE(BOOL_OR((${fxExpr("$1::text", "r.day")}) IS NULL
              OR (p.default_value_currency IS NOT NULL
                  AND (${fxExpr("p.default_value_currency", "r.day")}) IS NULL)),
              false) AS fx_missing
     FROM rollup_outcomes_daily r
     JOIN products p ON p.id = r.product_id AND ($4 OR p.archived_at IS NULL)
     WHERE r.day BETWEEN $2::date AND $3::date
     GROUP BY r.product_id, 2, 3`,
    params,
  );
  if (outcomeRows.some((row) => row.fx_missing)) throw FX_MISSING(displayCurrency);

  const days = rangeDays(range.from, range.to);
  const dayIndex = new Map(days.map((day, i) => [day, i]));
  const statsByProduct = new Map<string, OutcomeStats>();
  for (const row of outcomeRows) {
    const stats = statsByProduct.get(row.productId) ?? {
      outcomes: 0,
      valued: 0,
      reverted: 0,
      explicitDisplay: 0,
      defaultDisplay: 0,
      byKind: [],
    };
    if (row.live) {
      stats.outcomes += Number(row.outcomes);
      stats.valued += Number(row.valued);
      stats.explicitDisplay += Number(row.explicit_display ?? 0);
      stats.defaultDisplay += Number(row.default_display ?? 0);
      stats.byKind.push({ kind: row.kind, count: Number(row.outcomes) });
    } else {
      stats.reverted += Number(row.outcomes);
    }
    statsByProduct.set(row.productId, stats);
  }
  const spendByProduct = new Map(spendRows.map((row) => [row.productId, row]));
  const trendByProduct = new Map<string, number[]>();
  for (const row of trendRows) {
    const index = dayIndex.get(row.day);
    if (index === undefined) continue;
    let trend = trendByProduct.get(row.productId);
    if (!trend) {
      trend = days.map(() => 0);
      trendByProduct.set(row.productId, trend);
    }
    trend[index] += Number(row.cents);
  }

  const rows: ProductViewRow[] = products.map((product) => {
    const spend = spendByProduct.get(product.id);
    const stats = statsByProduct.get(product.id) ?? {
      outcomes: 0,
      valued: 0,
      reverted: 0,
      explicitDisplay: 0,
      defaultDisplay: 0,
      byKind: [],
    };
    const spendCents = spend ? Number(spend.cents) : 0;
    const activeUsers = spend ? Number(spend.users) : 0;
    return {
      id: product.id,
      name: product.name,
      attribution: product.attribution,
      outcomeKind: product.outcomeKind,
      archived: product.archivedAt !== null,
      spendCents,
      tokens: spend ? Number(spend.tokens) : 0,
      vendors: spend ? ((spend.vendors as string[]) ?? []) : [],
      factCount: spend ? Number(spend.facts) : 0,
      outcomeCount: stats.outcomes,
      revertedCount: stats.reverted,
      unitCostCents:
        stats.outcomes > 0 ? Math.round(spendCents / stats.outcomes) : null,
      unit: productUnit(
        product.outcomeKind,
        stats.byKind.map((k) => k.kind),
      ),
      ...valueAndRoi(product, stats, spendCents),
      activeUsers,
      costPerUserCents:
        activeUsers > 0 ? Math.round(spendCents / activeUsers) : null,
      trend: trendByProduct.get(product.id) ?? days.map(() => 0),
    };
  });
  rows.sort(
    (a, b) =>
      b.spendCents - a.spendCents ||
      b.outcomeCount - a.outcomeCount ||
      a.name.localeCompare(b.name),
  );

  return { displayCurrency, from: range.from, to: range.to, days, products: rows };
}

export type ManualEntryInput =
  | {
      kind: "cost";
      /** "YYYY-MM" - the month the cost covers. */
      month: string;
      amountCents: number;
      currency: string;
      note?: string | null;
    }
  | {
      kind: "outcomes";
      month: string;
      count: number;
      /** Per-outcome value; absent, the product default applies at read time. */
      value?: { cents: number; currency: string } | null;
      note?: string | null;
    };

export interface ManualEntryResult {
  entry: ManualEntry;
  rollups: { from: string | null; to: string | null };
}

/** No fake numbers: money in a currency with no FX rate at all can never
 * roll up, so it is rejected at the door instead of poisoning recomputes. */
async function assertFxKnown(db: Db, currency: string): Promise<void> {
  if ((await unknownCurrencies([currency], db)).length > 0) {
    throw new ResolveError(
      `no FX rate for ${currency} yet - enter the amount in USD or a currency with known rates`,
      409,
    );
  }
}

/**
 * Record (or correct - one entry per product, kind and month, rewritten in
 * place; nothing hard-deletes, spec 4) a manual monthly entry, and
 * materialize it into the ledger:
 *
 * - cost -> one spend_facts row on the month's first day, vendor "manual",
 *   cost_basis "manual" - typed-in money is always marked.
 * - outcomes -> one outcomes row, kind "manual", count = the entry's count.
 *
 * Both carry source_ref = the entry id, so the manual rows drill down to
 * the entry, not vendor rows (spec 7). Rollups recompute for the month's
 * day, so charts agree immediately.
 */
export async function upsertManualEntry(
  productId: string,
  input: ManualEntryInput,
  pool: Pool = getPool(),
): Promise<ManualEntryResult> {
  const monthDay = `${input.month}-01`;
  const client = await pool.connect();
  let entry: ManualEntry;
  try {
    await client.query("BEGIN");
    const { rows: products } = await client.query(
      `SELECT attribution, outcome_kind, archived_at
       FROM products WHERE id = $1 FOR UPDATE`,
      [productId],
    );
    if (products.length === 0) throw new ResolveError("product not found", 404);
    const product = products[0];
    if (product.archived_at !== null) {
      throw new ResolveError("product is archived", 409);
    }
    if (input.kind === "cost" && product.attribution !== "manual") {
      throw new ResolveError(
        `manual cost entries need attribution "manual" (this product's spend comes from ${product.attribution})`,
        409,
      );
    }
    if (input.kind === "outcomes" && product.outcome_kind !== "manual") {
      throw new ResolveError(
        `manual outcome entries need outcome_kind "manual" (this product's is ${product.outcome_kind})`,
        409,
      );
    }
    if (input.kind === "cost") await assertFxKnown(client, input.currency);
    if (input.kind === "outcomes" && input.value) {
      await assertFxKnown(client, input.value.currency);
    }

    const { rows: upserted } = await client.query(
      `INSERT INTO manual_entries
         (product_id, kind, month, amount_cents, currency,
          outcome_count, value_cents, value_currency, note)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (product_id, kind, month) DO UPDATE SET
         amount_cents = EXCLUDED.amount_cents,
         currency = EXCLUDED.currency,
         outcome_count = EXCLUDED.outcome_count,
         value_cents = EXCLUDED.value_cents,
         value_currency = EXCLUDED.value_currency,
         note = EXCLUDED.note,
         updated_at = now()
       RETURNING id, kind, to_char(month, 'YYYY-MM') AS month,
         amount_cents::int AS "amountCents", currency,
         outcome_count AS "outcomeCount", value_cents::int AS "valueCents",
         value_currency AS "valueCurrency", note, updated_at AS "updatedAt"`,
      [
        productId,
        input.kind,
        monthDay,
        input.kind === "cost" ? input.amountCents : null,
        input.kind === "cost" ? input.currency : null,
        input.kind === "outcomes" ? input.count : null,
        input.kind === "outcomes" ? (input.value?.cents ?? null) : null,
        input.kind === "outcomes" ? (input.value?.currency ?? null) : null,
        input.note?.trim() || null,
      ],
    );
    entry = {
      ...(upserted[0] as unknown as ManualEntry),
      updatedAt: new Date(upserted[0].updatedAt as string).toISOString(),
    };

    if (input.kind === "cost") {
      await client.query(
        `INSERT INTO spend_facts
           (day, person_id, product_id, vendor, model, tokens, amount_cents,
            currency, cost_basis, source_ref)
         VALUES ($1::date, NULL, $2, 'manual', NULL, 0, $3, $4, 'manual', $5)
         ON CONFLICT (vendor, source_ref) DO UPDATE SET
           amount_cents = EXCLUDED.amount_cents,
           currency = EXCLUDED.currency`,
        [monthDay, productId, input.amountCents, input.currency, entry.id],
      );
    } else {
      await client.query(
        `INSERT INTO outcomes
           (ts, product_id, person_id, kind, count, value_cents, currency, source_ref)
         VALUES ($1::timestamptz, $2, NULL, 'manual', $3, $4, $5, $6)
         ON CONFLICT (kind, source_ref) DO UPDATE SET
           count = EXCLUDED.count,
           value_cents = EXCLUDED.value_cents,
           currency = EXCLUDED.currency`,
        [
          `${monthDay}T00:00:00Z`,
          productId,
          input.count,
          input.value?.cents ?? null,
          input.value?.currency ?? null,
          entry.id,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const { from, to } = await recomputeRollups({ from: monthDay, to: monthDay }, pool);
  const result: ManualEntryResult = { entry, rollups: { from, to } };
  logger.info("manual entry recorded", {
    productId,
    entryId: entry.id,
    kind: entry.kind,
    month: entry.month,
  });
  return result;
}
