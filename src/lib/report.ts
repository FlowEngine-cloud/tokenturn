import { getPool, type Db } from "./db";
import { displayLateral } from "./display";
import { cleanMonth, productsView } from "./products";
import { addDays, addMonths, monthBounds } from "./range";
import { ResolveError } from "./resolve";
import { getSetting } from "./settings";

export { addMonths, currentMonth, monthBounds } from "./range";

/**
 * The CFO report (spec 10 page 6): one printable page per calendar month -
 * spend by cost center, unit costs, ROI where defined, month over month -
 * plus the two exports: a summary CSV of the same table, and a FOCUS 1.4
 * file with one row per raw spend fact (the FinOps Open Cost & Usage
 * Specification, focus.finops.org), so the export IS the drill-down.
 *
 * Every number reuses the Products-page reader (productsView) with archived
 * products included: a cost center that was archived mid-quarter leaves the
 * dashboards but can never leave a month's total (spec 4 - history stays
 * intact). Spend on no product at all shows as its own visible row, so the
 * page always sums to the whole ledger - no fake numbers, nothing hidden.
 */

export interface ReportRow {
  /** null = spend routed to no cost center (people's personal tool use). */
  productId: string | null;
  name: string;
  archived: boolean;
  spendCents: number;
  prevSpendCents: number;
  /** (spend - prev) / prev, one decimal; null when last month was zero. */
  momPct: number | null;
  outcomeCount: number;
  unit: string | null;
  unitCostCents: number | null;
  valueCents: number | null;
  roi: number | null;
  activeUsers: number;
  costPerUserCents: number | null;
}

export interface ReportData {
  displayCurrency: string;
  /** The report month, YYYY-MM, and its day bounds (UTC, inclusive). */
  month: string;
  prevMonth: string;
  from: string;
  to: string;
  rows: ReportRow[];
  totals: { spendCents: number; prevSpendCents: number; momPct: number | null };
  /** Trailing months ending at the report month, zero-filled - the
   * month-over-month trend. */
  months: { month: string; from: string; to: string; spendCents: number }[];
}

export const TREND_MONTHS = 6;

export const NO_COST_CENTER = "No cost center";

function momPct(cur: number, prev: number): number | null {
  if (prev === 0) return null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

function assertMonth(month: string): void {
  if (cleanMonth(month) === null) {
    throw new ResolveError("month must be YYYY-MM", 400);
  }
}

const FX_MISSING = (currency: string) =>
  new ResolveError(
    `no FX rate for the display currency ${currency} - sync FX rates first`,
    409,
  );

export async function reportData(
  month: string,
  db: Db = getPool(),
): Promise<ReportData> {
  assertMonth(month);
  const prevMonth = addMonths(month, -1);
  const cur = monthBounds(month);
  const prev = monthBounds(prevMonth);
  const displayCurrency = await getSetting("display_currency", db);

  // Cost centers, archived included, for both months. productsView already
  // owns unit-cost/ROI math and the drill-equality guarantee.
  const curView = await productsView(cur, db, { includeArchived: true });
  const prevView = await productsView(prev, db, { includeArchived: true });
  const prevById = new Map(prevView.products.map((p) => [p.id, p.spendCents]));

  // Spend with no product at all - visible, never dropped (drills to
  // /drill?product=none). Prev month is adjacent, so one contiguous scan.
  const { rows: bucketRows } = await db.query(
    `SELECT
       COALESCE(ROUND(SUM(d.cents) FILTER (
         WHERE r.day BETWEEN $2::date AND $3::date)), 0)::bigint AS cur,
       COALESCE(ROUND(SUM(d.cents) FILTER (
         WHERE r.day BETWEEN $4::date AND $5::date)), 0)::bigint AS prev,
       COALESCE(BOOL_OR(d.cents IS NULL), false) AS fx_missing
     FROM rollup_daily r
     ${displayLateral("r")}
     WHERE r.product_id IS NULL AND r.day BETWEEN $4::date AND $3::date`,
    [displayCurrency, cur.from, cur.to, prev.from, prev.to],
  );
  if (bucketRows[0].fx_missing) throw FX_MISSING(displayCurrency);

  const rows: ReportRow[] = [];
  for (const p of curView.products) {
    const prevSpendCents = prevById.get(p.id) ?? 0;
    if (
      p.spendCents === 0 &&
      prevSpendCents === 0 &&
      p.outcomeCount === 0 &&
      p.revertedCount === 0
    ) {
      continue; // an idle roster row says nothing to a CFO
    }
    rows.push({
      productId: p.id,
      name: p.name,
      archived: p.archived,
      spendCents: p.spendCents,
      prevSpendCents,
      momPct: momPct(p.spendCents, prevSpendCents),
      outcomeCount: p.outcomeCount,
      unit: p.unit,
      unitCostCents: p.unitCostCents,
      valueCents: p.valueCents,
      roi: p.roi,
      activeUsers: p.activeUsers,
      costPerUserCents: p.costPerUserCents,
    });
  }
  const bucketCur = Number(bucketRows[0].cur);
  const bucketPrev = Number(bucketRows[0].prev);
  if (bucketCur !== 0 || bucketPrev !== 0) {
    rows.push({
      productId: null,
      name: NO_COST_CENTER,
      archived: false,
      spendCents: bucketCur,
      prevSpendCents: bucketPrev,
      momPct: momPct(bucketCur, bucketPrev),
      outcomeCount: 0,
      unit: null,
      unitCostCents: null,
      valueCents: null,
      roi: null,
      activeUsers: 0,
      costPerUserCents: null,
    });
  }
  rows.sort((a, b) => b.spendCents - a.spendCents || a.name.localeCompare(b.name));

  const spendCents = rows.reduce((sum, r) => sum + r.spendCents, 0);
  const prevSpendCents = rows.reduce((sum, r) => sum + r.prevSpendCents, 0);

  // Month-over-month trend: total spend per trailing month, zero-filled.
  const firstMonth = addMonths(month, -(TREND_MONTHS - 1));
  const { rows: monthRows } = await db.query(
    `SELECT to_char(r.day, 'YYYY-MM') AS month,
            ROUND(SUM(d.cents))::bigint AS cents,
            COALESCE(BOOL_OR(d.cents IS NULL), false) AS fx_missing
     FROM rollup_daily r
     ${displayLateral("r")}
     WHERE r.day BETWEEN $2::date AND $3::date
     GROUP BY 1`,
    [displayCurrency, `${firstMonth}-01`, cur.to],
  );
  if (monthRows.some((row) => row.fx_missing)) throw FX_MISSING(displayCurrency);
  const byMonth = new Map(monthRows.map((row) => [row.month, Number(row.cents)]));
  const months = Array.from({ length: TREND_MONTHS }, (_, i) => {
    const m = addMonths(firstMonth, i);
    const bounds = monthBounds(m);
    return { month: m, ...bounds, spendCents: byMonth.get(m) ?? 0 };
  });

  return {
    displayCurrency,
    month,
    prevMonth,
    from: cur.from,
    to: cur.to,
    rows,
    totals: { spendCents, prevSpendCents, momPct: momPct(spendCents, prevSpendCents) },
    months,
  };
}

// ---- CSV exports ----------------------------------------------------------

function csvCell(value: string | number | null): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function csvLine(cells: (string | number | null)[]): string {
  return cells.map(csvCell).join(",");
}

const cents2 = (cents: number | null): string | null =>
  cents === null ? null : (cents / 100).toFixed(2);

/** The report table as CSV - the same rows, plus the total line. */
export function reportCsv(data: ReportData): string {
  const ccy = data.displayCurrency;
  const lines = [
    csvLine([
      "Month",
      "Cost center",
      "Status",
      `Spend (${ccy})`,
      `Last month (${ccy})`,
      "MoM %",
      "Outcomes",
      "Unit",
      `Unit cost (${ccy})`,
      `Value (${ccy})`,
      "ROI",
      "Active users",
      `Cost per active user (${ccy})`,
    ]),
  ];
  for (const row of data.rows) {
    lines.push(
      csvLine([
        data.month,
        row.name,
        row.archived ? "archived" : "active",
        cents2(row.spendCents),
        cents2(row.prevSpendCents),
        row.momPct,
        row.unit === null ? null : row.outcomeCount,
        row.unit,
        cents2(row.unitCostCents),
        cents2(row.valueCents),
        row.roi,
        row.activeUsers,
        cents2(row.costPerUserCents),
      ]),
    );
  }
  lines.push(
    csvLine([
      data.month,
      "Total",
      "",
      cents2(data.totals.spendCents),
      cents2(data.totals.prevSpendCents),
      data.totals.momPct,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]),
  );
  return lines.join("\n");
}

// ---- FOCUS 1.4 export -----------------------------------------------------

export const FOCUS_VERSION = "1.4";

/**
 * One row per raw spend fact. FOCUS costs are decimal amounts in the billed
 * currency, charge periods are ISO-8601 UTC instants (end exclusive). This
 * ledger has no amortized commitments, so Billed = Effective = List cost.
 * The employee is the sub-account - that is this product's whole point -
 * and ledger-specific fields ride in x_ extension columns per the spec.
 */
export const FOCUS_COLUMNS = [
  "BilledCost",
  "BillingCurrency",
  "BillingPeriodStart",
  "BillingPeriodEnd",
  "ChargeCategory",
  "ChargeDescription",
  "ChargePeriodStart",
  "ChargePeriodEnd",
  "ConsumedQuantity",
  "ConsumedUnit",
  "EffectiveCost",
  "InvoiceIssuerName",
  "ListCost",
  "ProviderName",
  "PublisherName",
  "ResourceId",
  "ResourceName",
  "ServiceCategory",
  "ServiceName",
  "SubAccountId",
  "SubAccountName",
  "x_CostBasis",
  "x_Model",
  "x_ProductId",
  "x_ProductName",
  "x_SourceRef",
] as const;

const FOCUS_BATCH_DEFAULT = 5000;

interface FocusFactRow {
  id: string;
  day: string;
  vendor: string;
  model: string | null;
  tokens: number;
  cents: number;
  currency: string;
  basis: string;
  ref: string;
  personId: string | null;
  personEmail: string | null;
  productId: string | null;
  productName: string | null;
  keyExternalId: string | null;
  keyName: string | null;
}

const instant = (day: string): string => `${day}T00:00:00Z`;

function focusLine(fact: FocusFactRow, period: { from: string; to: string }): string {
  const cost = (fact.cents / 100).toFixed(2);
  const usage = fact.basis !== "manual";
  return csvLine([
    cost,
    fact.currency,
    instant(period.from),
    instant(addDays(period.to, 1)),
    usage ? "Usage" : "Purchase",
    usage
      ? `${fact.vendor}${fact.model ? ` ${fact.model}` : ""} usage`
      : `${fact.vendor} monthly cost entry`,
    instant(fact.day),
    instant(addDays(fact.day, 1)),
    fact.tokens > 0 ? fact.tokens : null,
    fact.tokens > 0 ? "tokens" : null,
    cost, // EffectiveCost
    fact.vendor, // InvoiceIssuerName
    cost, // ListCost - no negotiated discounts in this ledger
    fact.vendor, // ProviderName
    fact.vendor, // PublisherName
    fact.keyExternalId, // ResourceId
    fact.keyName ?? fact.keyExternalId, // ResourceName
    "AI and Machine Learning", // ServiceCategory
    fact.vendor, // ServiceName
    fact.personId,
    fact.personEmail,
    fact.basis,
    fact.model,
    fact.productId,
    fact.productName,
    fact.ref,
  ]);
}

/**
 * FOCUS 1.4 CSV lines for one month, header first, then one line per spend
 * fact - keyset-paged so a big month streams without holding every row.
 */
export async function* focusLines(
  month: string,
  db: Db = getPool(),
  batchSize: number = FOCUS_BATCH_DEFAULT,
): AsyncGenerator<string> {
  assertMonth(month);
  const bounds = monthBounds(month);
  yield csvLine([...FOCUS_COLUMNS]);

  let cursor: { day: string; id: string } | null = null;
  for (;;) {
    const { rows } = (await db.query(
      `SELECT f.id::text AS id, f.day::text AS day, f.vendor, f.model,
              COALESCE(f.tokens, 0)::bigint AS tokens,
              f.amount_cents::bigint AS cents, f.currency,
              f.cost_basis AS basis, f.source_ref AS ref,
              f.person_id AS "personId", p.email AS "personEmail",
              f.product_id AS "productId", pr.name AS "productName",
              i.external_id AS "keyExternalId", i.display_name AS "keyName"
       FROM spend_facts f
       LEFT JOIN people p ON p.id = f.person_id
       LEFT JOIN products pr ON pr.id = f.product_id
       LEFT JOIN identities i ON i.id = f.identity_id
       WHERE f.day BETWEEN $1::date AND $2::date
         AND ($3::date IS NULL OR (f.day, f.id) > ($3::date, $4::bigint))
       ORDER BY f.day, f.id
       LIMIT $5`,
      [bounds.from, bounds.to, cursor?.day ?? null, cursor?.id ?? null, batchSize],
    )) as { rows: (FocusFactRow & { tokens: string | number; cents: string | number })[] };
    for (const row of rows) {
      yield focusLine(
        { ...row, tokens: Number(row.tokens), cents: Number(row.cents) },
        bounds,
      );
    }
    if (rows.length < batchSize) return;
    const last = rows[rows.length - 1];
    cursor = { day: last.day, id: last.id };
  }
}

/** The whole FOCUS file as one string (tests; small months). */
export async function focusCsv(
  month: string,
  db: Db = getPool(),
  batchSize: number = FOCUS_BATCH_DEFAULT,
): Promise<string> {
  const lines: string[] = [];
  for await (const line of focusLines(month, db, batchSize)) lines.push(line);
  return lines.join("\n");
}
