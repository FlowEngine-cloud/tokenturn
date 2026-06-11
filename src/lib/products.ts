import type { Pool } from "pg";
import { getPool, type Db } from "./db";
import { logger } from "./logger";
import { ResolveError } from "./resolve";
import { fxExpr, recomputeRollups } from "./rollup";

/**
 * Products = cost centers (spec section 7). A product is anything that
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
export const OUTCOME_KINDS = ["none", "github_pr", "sdk_event", "manual"] as const;
export type Attribution = (typeof ATTRIBUTIONS)[number];
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

export function isAttribution(v: unknown): v is Attribution {
  return typeof v === "string" && (ATTRIBUTIONS as readonly string[]).includes(v);
}

export function isOutcomeKind(v: unknown): v is OutcomeKind {
  return typeof v === "string" && (OUTCOME_KINDS as readonly string[]).includes(v);
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

export interface ProductMetrics {
  /** From the daily rollups, normalized to USD cents. */
  spendUsdCents: number;
  spendByBasis: { estimated: number; invoiced: number; manual: number };
  /** Live outcomes; reverted ones sit in revertedOutcomes, never counted. */
  outcomes: number;
  /** How many of those carry an explicit value (the rest use the default). */
  valuedOutcomes: number;
  revertedOutcomes: number;
  /** spend / outcomes over the range; null when there are no outcomes. */
  unitCostUsdCents: number | null;
  /** Explicit values + the product default for unvalued outcomes; null when
   * neither exists - no fake ROI (spec 7). */
  valueUsdCents: number | null;
  /** value / spend, 2 decimals; null when value or spend is missing. */
  roi: number | null;
}

export interface ProductFact {
  day: string;
  vendor: string;
  model: string | null;
  tokens: number;
  amountCents: number;
  currency: string;
  costBasis: string;
  /** Vendor record id - or, for manual rows, the manual entry's id. */
  sourceRef: string;
  identityExternalId: string | null;
  personEmail: string | null;
}

export interface ProductOutcome {
  ts: string;
  kind: string;
  count: number;
  valueCents: number | null;
  currency: string | null;
  sourceRef: string;
  personEmail: string | null;
  revertedAt: string | null;
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

export interface ProductDetail {
  product: Product;
  metrics: ProductMetrics;
  /** The drill-down: the rows behind every number above, range-bounded. */
  facts: ProductFact[];
  outcomes: ProductOutcome[];
  manualEntries: ManualEntry[];
}

const RANGE_WHERE = `($2::date IS NULL OR day >= $2) AND ($3::date IS NULL OR day <= $3)`;

/**
 * One product with its metrics over the selected range. Chart numbers come
 * from the rollups; the facts/outcomes arrays are the raw rows behind them,
 * so every displayed number drills to its source (spec 3). Archived products
 * stay fully readable - history never disappears.
 */
export async function productDetail(
  id: string,
  range: DayRange = {},
  db: Db = getPool(),
): Promise<ProductDetail> {
  const { rows: products } = await db.query(
    `SELECT ${PRODUCT_COLUMNS} FROM products p WHERE p.id = $1`,
    [id],
  );
  if (products.length === 0) throw new ResolveError("product not found", 404);
  const product = toProduct(products[0]);
  const args = [id, range.from ?? null, range.to ?? null];

  const { rows: spendRows } = await db.query(
    `SELECT cost_basis AS basis, SUM(amount_usd_cents)::bigint AS amount
     FROM rollup_daily WHERE product_id = $1 AND ${RANGE_WHERE}
     GROUP BY cost_basis`,
    args,
  );
  const spendByBasis = { estimated: 0, invoiced: 0, manual: 0 };
  for (const row of spendRows) {
    spendByBasis[row.basis as keyof typeof spendByBasis] = Number(row.amount);
  }
  const spendUsdCents =
    spendByBasis.estimated + spendByBasis.invoiced + spendByBasis.manual;

  // Live vs reverted split, plus the read-time default-value math: explicit
  // values roll up in value_usd_cents; outcomes without one (outcome_count -
  // valued_count) take the product's default, FX-converted on their day.
  const { rows: outcomeRows } = await db.query(
    `SELECT
       COALESCE(SUM(ro.outcome_count) FILTER (WHERE ro.kind NOT LIKE '%:reverted'), 0)::int
         AS outcomes,
       COALESCE(SUM(ro.valued_count) FILTER (WHERE ro.kind NOT LIKE '%:reverted'), 0)::int
         AS valued,
       SUM(ro.value_usd_cents) FILTER (WHERE ro.kind NOT LIKE '%:reverted')::bigint
         AS explicit_value,
       COALESCE(SUM(ro.outcome_count) FILTER (WHERE ro.kind LIKE '%:reverted'), 0)::int
         AS reverted,
       ROUND(SUM(
         (ro.outcome_count - ro.valued_count) * $4::bigint
           * ${fxExpr("$5::text", "ro.day")}
       ) FILTER (WHERE ro.kind NOT LIKE '%:reverted'))::bigint AS default_value
     FROM rollup_outcomes_daily ro
     WHERE ro.product_id = $1
       AND ($2::date IS NULL OR ro.day >= $2) AND ($3::date IS NULL OR ro.day <= $3)`,
    [...args, product.defaultValueCents, product.defaultValueCurrency],
  );
  const o = outcomeRows[0];
  const outcomes = o.outcomes as number;
  const valuedOutcomes = o.valued as number;
  const explicit = o.explicit_value === null ? 0 : Number(o.explicit_value);
  const defaultPart = o.default_value === null ? 0 : Number(o.default_value);
  // Value is defined when any outcome carries an explicit value, or the
  // product default covers the unvalued ones. Otherwise null - plain cost
  // per outcome, no fake ROI (spec 7: the Company Brain case).
  const hasValue =
    valuedOutcomes > 0 ||
    (product.defaultValueCents !== null && outcomes > valuedOutcomes);
  const valueUsdCents = hasValue ? explicit + defaultPart : null;
  const metrics: ProductMetrics = {
    spendUsdCents,
    spendByBasis,
    outcomes,
    valuedOutcomes,
    revertedOutcomes: o.reverted as number,
    unitCostUsdCents: outcomes > 0 ? Math.round(spendUsdCents / outcomes) : null,
    valueUsdCents,
    roi:
      valueUsdCents !== null && spendUsdCents > 0
        ? Math.round((valueUsdCents / spendUsdCents) * 100) / 100
        : null,
  };

  const { rows: facts } = await db.query(
    `SELECT f.day::text AS day, f.vendor, f.model, f.tokens::int AS tokens,
            f.amount_cents::int AS "amountCents", f.currency,
            f.cost_basis AS "costBasis", f.source_ref AS "sourceRef",
            i.external_id AS "identityExternalId", pe.email AS "personEmail"
     FROM spend_facts f
     LEFT JOIN identities i ON i.id = f.identity_id
     LEFT JOIN people pe ON pe.id = f.person_id
     WHERE f.product_id = $1
       AND ($2::date IS NULL OR f.day >= $2) AND ($3::date IS NULL OR f.day <= $3)
     ORDER BY f.day DESC, f.source_ref`,
    args,
  );

  const { rows: outcomeDrill } = await db.query(
    `SELECT o.ts, o.kind, o.count::int AS count,
            o.value_cents::int AS "valueCents", o.currency,
            o.source_ref AS "sourceRef", pe.email AS "personEmail",
            o.reverted_at AS "revertedAt"
     FROM outcomes o
     LEFT JOIN people pe ON pe.id = o.person_id
     WHERE o.product_id = $1
       AND ($2::date IS NULL OR (o.ts AT TIME ZONE 'UTC')::date >= $2)
       AND ($3::date IS NULL OR (o.ts AT TIME ZONE 'UTC')::date <= $3)
     ORDER BY o.ts DESC, o.source_ref`,
    args,
  );

  const { rows: entries } = await db.query(
    `SELECT id, kind, to_char(month, 'YYYY-MM') AS month,
            amount_cents::int AS "amountCents", currency,
            outcome_count AS "outcomeCount", value_cents::int AS "valueCents",
            value_currency AS "valueCurrency", note, updated_at AS "updatedAt"
     FROM manual_entries WHERE product_id = $1
     ORDER BY month DESC, kind`,
    [id],
  );

  return {
    product,
    metrics,
    facts: facts as ProductFact[],
    outcomes: outcomeDrill.map((row) => ({
      ...(row as unknown as ProductOutcome),
      ts: new Date(row.ts as string).toISOString(),
      revertedAt: row.revertedAt
        ? new Date(row.revertedAt as string).toISOString()
        : null,
    })),
    manualEntries: entries.map((row) => ({
      ...(row as unknown as ManualEntry),
      updatedAt: new Date(row.updatedAt as string).toISOString(),
    })),
  };
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
  if (currency === "USD") return;
  const { rows } = await db.query(
    "SELECT 1 FROM fx_rates WHERE currency = $1 LIMIT 1",
    [currency],
  );
  if (rows.length === 0) {
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
