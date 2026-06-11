import type { Pool, PoolClient } from "pg";
import { getPool, type Db } from "./db";
import { unknownCurrencies } from "./fx";
import { logger } from "./logger";
import { cleanCurrency } from "./products";
import { ResolveError } from "./resolve";
import { displayExpr, fxExpr, recomputeRollups } from "./rollup";
import { getSetting } from "./settings";

/**
 * Monthly invoice import (spec section 4): "Monthly invoice import (CSV)
 * trues estimated up to invoiced; Overview shows drift when they diverge."
 *
 * - One invoice per (vendor, month), upserted: re-importing a month corrects
 *   it in place. Nothing hard-deletes; the correction path is a re-import.
 * - The true-up materializes as ONE derived adjustment row in spend_facts:
 *   day = the month's last UTC day, cost_basis 'invoiced', person/product
 *   NULL (no known owner -> the visible Unassigned bucket, spec 4), amount =
 *   invoice total - what the synced facts for that vendor-month already sum
 *   to, in the invoice's currency (negative when the vendor billed less than
 *   estimated). source_ref = 'invoice:<id>', so the adjustment drills to the
 *   invoice, not vendor rows. With the adjustment in place, the ledger sums
 *   to the invoiced total while every per-person/per-product estimate stays
 *   exactly what the vendor reported - no fake rescaling.
 * - The adjustment is derived, so it recomputes wherever its inputs change:
 *   on import, and after every connector sync that wrote facts into an
 *   invoiced month (vendors restate data, spec 4) - see trueUpAfterSync,
 *   called by the sync engine. Drift zero = no adjustment row.
 * - All conversion goes through fx_rates per day, same as the rollup; the
 *   drift report uses the exact same base expression as the materialized
 *   adjustment, so the number on Overview IS the adjustment row it drills to.
 */

export interface InvoiceCsvRow {
  /** 1-based line in the uploaded file. */
  line: number;
  vendor: string | null;
  /** "YYYY-MM". */
  month: string | null;
  amountCents: number | null;
  currency: string | null;
  /** The vendor's invoice number, when the CSV carries one. */
  ref: string | null;
  note: string | null;
  /** Why the row cannot import; null = importable. */
  error: string | null;
}

export interface CsvRecord {
  line: number;
  cells: string[];
}

/** Minimal CSV reader: quoted fields, escaped quotes, CRLF; keeps original
 * line numbers so per-row errors point at the file. */
export function parseCsv(text: string): CsvRecord[] {
  const src = text.replace(/^\uFEFF/, "");
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;
  let rowLine = 1;
  let sawAny = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      sawAny = true;
    } else if (ch === ",") {
      cells.push(field);
      field = "";
      sawAny = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      if (sawAny || field !== "") {
        cells.push(field);
        records.push({ line: rowLine, cells });
      }
      cells = [];
      field = "";
      sawAny = false;
      line++;
      rowLine = line;
    } else {
      sawAny = sawAny || ch.trim() !== "";
      field += ch;
    }
  }
  if (sawAny || field !== "") {
    cells.push(field);
    records.push({ line: rowLine, cells });
  }
  return records.filter((r) => r.cells.some((c) => c.trim() !== ""));
}

type InvoiceColumn = "vendor" | "month" | "amount" | "currency" | "ref" | "note";

/** Header auto-detect (spec 8's CSV convention): common vendor-export names
 * map onto our four columns; unknown extra columns are ignored. */
const HEADER_ALIASES: Record<string, InvoiceColumn> = {
  vendor: "vendor",
  provider: "vendor",
  supplier: "vendor",
  month: "month",
  period: "month",
  billing_month: "month",
  billing_period: "month",
  invoice_month: "month",
  amount: "amount",
  total: "amount",
  amount_due: "amount",
  total_amount: "amount",
  currency: "currency",
  ccy: "currency",
  cur: "currency",
  ref: "ref",
  invoice: "ref",
  invoice_id: "ref",
  invoice_no: "ref",
  invoice_number: "ref",
  number: "ref",
  note: "note",
  memo: "note",
  description: "note",
};

const REQUIRED_COLUMNS: InvoiceColumn[] = ["vendor", "month", "amount", "currency"];

function normalizeHeader(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const VENDOR_RE = /^[a-z0-9][a-z0-9_.-]*$/;
/** Plain decimal, optional well-formed thousands commas, <= 2 decimals. A
 * European decimal comma ("12,34") fails the shape instead of misparsing. */
const AMOUNT_RE = /^-?(\d+|\d{1,3}(,\d{3})+)(\.\d{1,2})?$/;

function parseAmountCents(raw: string): number | null {
  const cleaned = raw.trim();
  if (!AMOUNT_RE.test(cleaned)) return null;
  const negative = cleaned.startsWith("-");
  const [whole, frac = ""] = cleaned.replace(/^-/, "").replace(/,/g, "").split(".");
  const cents = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

/** "YYYY-MM" or "YYYY-MM-DD" (day ignored) -> "YYYY-MM"; null when invalid. */
function parseMonth(raw: string): string | null {
  const m = raw.trim().match(/^(\d{4})-(0[1-9]|1[0-2])(-\d{2})?$/);
  return m ? `${m[1]}-${m[2]}` : null;
}

/** Last UTC day of a "YYYY-MM" month - where the adjustment fact lands. */
export function monthEndDay(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export interface ParsedInvoiceCsv {
  rows: InvoiceCsvRow[];
  /** True when every row can import. */
  ok: boolean;
}

/**
 * Parse + validate an invoice CSV. Structural problems (no usable header)
 * throw ResolveError(400); row problems land on the row, so the preview can
 * show per-row errors (spec 8 convention: preview before commit). `now`
 * gates incomplete months: an invoice trues a month up, so the month must be
 * over - importing a still-accruing month would fabricate negative drift.
 */
export async function parseInvoiceCsv(
  text: string,
  now: Date,
  db: Db = getPool(),
): Promise<ParsedInvoiceCsv> {
  const records = parseCsv(text);
  if (records.length === 0) throw new ResolveError("the CSV is empty", 400);

  const columns = new Map<string, number>();
  for (const [index, cell] of records[0].cells.entries()) {
    const role = HEADER_ALIASES[normalizeHeader(cell)];
    if (role && !columns.has(role)) columns.set(role, index);
  }
  const missing = REQUIRED_COLUMNS.filter((c) => !columns.has(c));
  if (missing.length > 0) {
    throw new ResolveError(
      `the CSV header needs ${missing.join(", ")} columns (vendor, month, amount, currency; extras are ignored)`,
      400,
    );
  }
  if (records.length === 1) {
    throw new ResolveError("the CSV has a header but no rows", 400);
  }

  const currentMonth = now.toISOString().slice(0, 7);
  const seen = new Set<string>();
  const rows: InvoiceCsvRow[] = [];
  for (const record of records.slice(1)) {
    const cell = (role: string): string => record.cells[columns.get(role)!] ?? "";
    const row: InvoiceCsvRow = {
      line: record.line,
      vendor: null,
      month: null,
      amountCents: null,
      currency: null,
      ref: columns.has("ref") ? cell("ref").trim() || null : null,
      note: columns.has("note") ? cell("note").trim() || null : null,
      error: null,
    };
    const fail = (error: string) => {
      row.error ??= error;
    };

    const vendor = cell("vendor").trim().toLowerCase();
    if (!VENDOR_RE.test(vendor)) {
      fail(`bad vendor ${JSON.stringify(cell("vendor").trim())}`);
    } else if (vendor === "manual") {
      fail('vendor "manual" is reserved for manual product entries');
    } else {
      row.vendor = vendor;
    }

    row.month = parseMonth(cell("month"));
    if (row.month === null) {
      fail(`bad month ${JSON.stringify(cell("month").trim())} - want YYYY-MM`);
    } else if (row.month >= currentMonth) {
      fail(`${row.month} is not over yet - import after the month closes`);
    }

    row.amountCents = parseAmountCents(cell("amount"));
    if (row.amountCents === null) {
      fail(`bad amount ${JSON.stringify(cell("amount").trim())} - want a plain decimal like 1234.56`);
    }

    row.currency = cleanCurrency(cell("currency").trim().toUpperCase());
    if (row.currency === null) {
      fail(`bad currency ${JSON.stringify(cell("currency").trim())} - want a 3-letter code like USD`);
    }

    if (row.vendor && row.month) {
      const key = `${row.vendor} ${row.month}`;
      if (seen.has(key)) fail(`duplicate row for ${row.vendor} ${row.month}`);
      seen.add(key);
    }
    rows.push(row);
  }

  // No fake numbers: an invoice in a currency with no FX rate at all could
  // never convert, so it is rejected at the door (same rule as manual
  // entries).
  const unknown = new Set(
    await unknownCurrencies(
      rows.filter((r) => r.error === null).map((r) => r.currency!),
      db,
    ),
  );
  for (const row of rows) {
    if (row.error === null && unknown.has(row.currency!)) {
      row.error = `no FX rate for ${row.currency} yet - sync FX rates first`;
    }
  }

  return { rows, ok: rows.every((r) => r.error === null) };
}

interface InvoiceRef {
  id: string;
  vendor: string;
  /** "YYYY-MM". */
  month: string;
  amountCents: number;
  currency: string;
}

/** The reconciliation base: everything the synced facts for the vendor-month
 * sum to, in the given currency, each fact converted on its own day -
 * excluding adjustment rows themselves. Shared by the true-up and the drift
 * report so the displayed drift IS the materialized adjustment. */
function baseCentsSql(currencyExpr: string, vendorExpr: string, monthExpr: string): string {
  return `(
    SELECT COALESCE(ROUND(SUM(
      f.amount_cents::numeric * ${fxExpr("f.currency", "f.day")}
        / ${fxExpr(currencyExpr, "f.day")}
    )), 0)::bigint
    FROM spend_facts f
    WHERE f.vendor = ${vendorExpr}
      AND f.day >= ${monthExpr}
      AND f.day < (${monthExpr} + interval '1 month')::date
      AND f.source_ref NOT LIKE 'invoice:%'
  )`;
}

/**
 * Recompute one invoice's adjustment fact. Returns the adjustment day (the
 * month's last UTC day) and the amount in the invoice's currency; a zero
 * drift removes the row - the derived adjustment exists only while the
 * numbers diverge.
 */
async function trueUpInvoice(client: PoolClient, invoice: InvoiceRef): Promise<{
  day: string;
  adjustmentCents: number;
}> {
  const monthDay = `${invoice.month}-01`;

  // A fact in a currency with no FX rate at all would silently drop out of
  // the SUM. Refuse loudly instead - the same recompute these facts would
  // already abort (lib/rollup.ts).
  const { rows: bad } = await client.query(
    `SELECT DISTINCT f.currency FROM spend_facts f
     WHERE f.vendor = $1 AND f.day >= $2::date
       AND f.day < ($2::date + interval '1 month')::date
       AND f.source_ref NOT LIKE 'invoice:%' AND f.currency <> 'USD'
       AND NOT EXISTS (SELECT 1 FROM fx_rates r WHERE r.currency = f.currency)
     ORDER BY 1`,
    [invoice.vendor, monthDay],
  );
  if (bad.length > 0) {
    throw new ResolveError(
      `cannot true up ${invoice.vendor} ${invoice.month}: no FX rate for ${bad
        .map((r) => r.currency)
        .join(", ")} - sync FX rates first`,
      409,
    );
  }

  const { rows } = await client.query(
    `SELECT ${baseCentsSql("$2::text", "$1::text", "$3::date")} AS base`,
    [invoice.vendor, invoice.currency, monthDay],
  );
  const adjustmentCents = invoice.amountCents - Number(rows[0].base);
  const day = monthEndDay(invoice.month);
  const sourceRef = `invoice:${invoice.id}`;

  if (adjustmentCents === 0) {
    await client.query("DELETE FROM spend_facts WHERE vendor = $1 AND source_ref = $2", [
      invoice.vendor,
      sourceRef,
    ]);
  } else {
    await client.query(
      `INSERT INTO spend_facts
         (day, person_id, product_id, vendor, model, tokens, amount_cents,
          currency, cost_basis, source_ref)
       VALUES ($1::date, NULL, NULL, $2, NULL, 0, $3, $4, 'invoiced', $5)
       ON CONFLICT (vendor, source_ref) DO UPDATE SET
         day = EXCLUDED.day,
         amount_cents = EXCLUDED.amount_cents,
         currency = EXCLUDED.currency`,
      [day, invoice.vendor, adjustmentCents, invoice.currency, sourceRef],
    );
  }
  return { day, adjustmentCents };
}

export interface ImportedInvoice {
  id: string;
  vendor: string;
  month: string;
  amountCents: number;
  currency: string;
  /** invoice - synced facts, in the invoice's currency; 0 = reconciled. */
  driftCents: number;
}

export interface ImportResult {
  imported: number;
  invoices: ImportedInvoice[];
  /** Adjustment days whose rollups were recomputed. */
  rollupDays: string[];
}

/** Commit validated CSV rows: upsert invoices + recompute their adjustments
 * in one transaction, then recompute the touched rollup days. */
export async function importInvoices(
  rows: InvoiceCsvRow[],
  pool: Pool = getPool(),
): Promise<ImportResult> {
  const invalid = rows.find((r) => r.error !== null);
  if (invalid) {
    throw new ResolveError(`line ${invalid.line}: ${invalid.error}`, 400);
  }
  const client = await pool.connect();
  const invoices: ImportedInvoice[] = [];
  const days = new Set<string>();
  try {
    await client.query("BEGIN");
    for (const row of rows) {
      const { rows: upserted } = await client.query(
        `INSERT INTO invoices (vendor, month, amount_cents, currency, source_ref, note)
         VALUES ($1, $2::date, $3, $4, $5, $6)
         ON CONFLICT (vendor, month) DO UPDATE SET
           amount_cents = EXCLUDED.amount_cents,
           currency = EXCLUDED.currency,
           source_ref = EXCLUDED.source_ref,
           note = EXCLUDED.note,
           updated_at = now()
         RETURNING id`,
        [row.vendor, `${row.month}-01`, row.amountCents, row.currency, row.ref, row.note],
      );
      const invoice: InvoiceRef = {
        id: upserted[0].id as string,
        vendor: row.vendor!,
        month: row.month!,
        amountCents: row.amountCents!,
        currency: row.currency!,
      };
      const { day, adjustmentCents } = await trueUpInvoice(client, invoice);
      days.add(day);
      invoices.push({ ...invoice, driftCents: adjustmentCents });
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const rollupDays = [...days].sort();
  for (const day of rollupDays) {
    await recomputeRollups({ from: day, to: day }, pool);
  }
  logger.info("invoices imported", {
    imported: invoices.length,
    months: invoices.map((i) => `${i.vendor} ${i.month}`),
  });
  return { imported: invoices.length, invoices, rollupDays };
}

/**
 * Re-true every invoiced month a sync wrote facts into - vendors restate
 * data (spec 4), and a restated estimate changes the drift. Called by the
 * sync engine with the day span of the facts it committed.
 */
export async function trueUpAfterSync(
  vendor: string,
  span: { min: string; max: string },
  pool: Pool = getPool(),
): Promise<{ days: string[] }> {
  const { rows } = await pool.query(
    `SELECT id, vendor, to_char(month, 'YYYY-MM') AS month,
            amount_cents AS "amountCents", currency
     FROM invoices
     WHERE vendor = $1 AND month <= $3::date
       AND (month + interval '1 month')::date > $2::date
     ORDER BY month`,
    [vendor, span.min, span.max],
  );
  if (rows.length === 0) return { days: [] };

  const client = await pool.connect();
  const days = new Set<string>();
  try {
    await client.query("BEGIN");
    for (const row of rows) {
      const { day } = await trueUpInvoice(client, {
        id: row.id,
        vendor: row.vendor,
        month: row.month,
        amountCents: Number(row.amountCents),
        currency: row.currency,
      });
      days.add(day);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const sorted = [...days].sort();
  for (const day of sorted) {
    await recomputeRollups({ from: day, to: day }, pool);
  }
  return { days: sorted };
}

export interface InvoiceDriftRow {
  id: string;
  vendor: string;
  /** "YYYY-MM". */
  month: string;
  /** The invoice as billed - the original, shown in drill-downs. */
  amountCents: number;
  currency: string;
  sourceRef: string | null;
  note: string | null;
  updatedAt: string;
  /** What the synced facts say, USD cents, by basis (adjustments excluded). */
  estimatedUsdCents: number;
  invoicedFactsUsdCents: number;
  /** The invoice converted at the month's last day. */
  invoiceUsdCents: number;
  /** invoice - synced facts: exactly the materialized adjustment. */
  driftCents: number;
  driftUsdCents: number;
  /** driftUsdCents in the org's display currency, month-end rate. */
  driftDisplayCents: number;
}

export interface InvoiceDrift {
  displayCurrency: string;
  invoices: InvoiceDriftRow[];
}

const MONTH_END = `((i.month + interval '1 month')::date - 1)`;

/**
 * The drift report behind Overview's estimated/invoiced tile: per invoiced
 * vendor-month, what the synced facts say vs what the vendor billed. Drift
 * uses the same base expression the true-up materialized, so the number
 * shown drills to the adjustment row and the invoice behind it.
 */
export async function invoiceDrift(
  range: { from?: string; to?: string } = {},
  db: Db = getPool(),
): Promise<InvoiceDrift> {
  const displayCurrency = await getSetting("display_currency", db);
  const driftUsdExpr = `(i.amount_cents - base.base_ccy)::numeric * ${fxExpr("i.currency", MONTH_END)}`;
  const { rows } = await db.query(
    `SELECT i.id, i.vendor, to_char(i.month, 'YYYY-MM') AS month,
            i.amount_cents AS "amountCents", i.currency,
            i.source_ref AS "sourceRef", i.note, i.updated_at AS "updatedAt",
            base.est_usd AS "estimatedUsdCents",
            base.fact_usd AS "invoicedFactsUsdCents",
            base.fx_missing AS "fxMissing",
            ROUND(i.amount_cents::numeric * ${fxExpr("i.currency", MONTH_END)})
              AS "invoiceUsdCents",
            (i.amount_cents - base.base_ccy) AS "driftCents",
            ROUND(${driftUsdExpr}) AS "driftUsdCents",
            ${displayExpr(driftUsdExpr, "$3::text", MONTH_END)} AS "driftDisplayCents"
     FROM invoices i
     CROSS JOIN LATERAL (
       SELECT
         COALESCE(ROUND(SUM(f.amount_cents::numeric * ${fxExpr("f.currency", "f.day")})
           FILTER (WHERE f.cost_basis = 'estimated')), 0) AS est_usd,
         COALESCE(ROUND(SUM(f.amount_cents::numeric * ${fxExpr("f.currency", "f.day")})
           FILTER (WHERE f.cost_basis = 'invoiced')), 0) AS fact_usd,
         ${baseCentsSql("i.currency", "i.vendor", "i.month")} AS base_ccy,
         COALESCE(BOOL_OR(${fxExpr("f.currency", "f.day")} IS NULL), false) AS fx_missing
       FROM spend_facts f
       WHERE f.vendor = i.vendor AND f.day >= i.month
         AND f.day < (i.month + interval '1 month')::date
         AND f.source_ref NOT LIKE 'invoice:%'
     ) base
     WHERE ($1::date IS NULL OR i.month >= $1::date)
       AND ($2::date IS NULL OR i.month <= $2::date)
     ORDER BY i.month DESC, i.vendor`,
    [
      range.from ? `${range.from}-01` : null,
      range.to ? `${range.to}-01` : null,
      displayCurrency,
    ],
  );

  const broken = rows.find((r) => r.fxMissing);
  if (broken) {
    throw new ResolveError(
      `cannot compute drift for ${broken.vendor} ${broken.month}: a fact's currency has no FX rate - sync FX rates first`,
      409,
    );
  }
  return {
    displayCurrency,
    invoices: rows.map((row) => ({
      id: row.id,
      vendor: row.vendor,
      month: row.month,
      amountCents: Number(row.amountCents),
      currency: row.currency,
      sourceRef: row.sourceRef,
      note: row.note,
      updatedAt: new Date(row.updatedAt).toISOString(),
      estimatedUsdCents: Number(row.estimatedUsdCents),
      invoicedFactsUsdCents: Number(row.invoicedFactsUsdCents),
      invoiceUsdCents: Number(row.invoiceUsdCents),
      driftCents: Number(row.driftCents),
      driftUsdCents: Number(row.driftUsdCents),
      driftDisplayCents: Number(row.driftDisplayCents),
    })),
  };
}
