import { getPool, type Db } from "./db";
import { toolLabel } from "./format";
import { productsView, type Attribution } from "./products";
import { effectiveTagsSql } from "./tag-sql";
import { toolsData, type ToolSpendSource } from "./tools";

/**
 * The ROI page reader (spec 7 + 10 page 3). An ROI is a named calculation:
 * a slice of spend ÷ a definition of success. One list holds them all:
 *
 * - built-in coding-tool rows (toolsData): success = code that survives -
 *   lines still alive in prod 30 days after the merge (the background git
 *   checks, spec 5), with the vendors' accept rates alongside - a dash
 *   until a PR has been checked, never invented. Merges are not a factor.
 * - user-defined rows (productsView - the products table keeps its name,
 *   only the language changed): success = whatever the row defines, or
 *   none - then it is plain cost, no fake ROI.
 *
 * Every row carries its tags and vendors so the filter bar can slice the
 * list without a second read.
 */

export interface RoiRow {
  /** "custom:<productId>" | "coding:<tool>" - stable across the merge. */
  key: string;
  kind: "custom" | "coding";
  productId: string | null;
  tool: string | null;
  name: string;
  /** Where the spend slice comes from (custom rows); coding rows are built in. */
  attribution: Attribution | null;
  spendCents: number | null;
  tokens: number;
  /** Live successes in range. Coding rows: lines still alive at 30 days
   * (0 until the survival job has checked a PR - survivalPct says whether
   * anything was measured). Custom rows: outcomes, reverted ones out. */
  successes: number;
  revertedCount: number;
  /** What one success is called ("1k lines", "ticket_resolved"); null =
   * none defined - costPerUserCents is the row's number instead. */
  unit: string | null;
  costPerSuccessCents: number | null;
  tokensPerSuccess: number | null;
  valueCents: number | null;
  roi: number | null;
  activeUsers: number;
  costPerUserCents: number | null;
  /** Coding rows only - from the vendors' own counters. */
  acceptRatePct: number | null;
  /** % of AI-written lines still alive 30 days after merge (spec 5);
   * null until the survival job has checked a PR in range. */
  survivalPct: number | null;
  /** For the filter bar. Coding rows carry their own tool tag. */
  tags: string[];
  vendors: string[];
  /** Coding rows: where the spend number is sourced (drill links). */
  spendSource: ToolSpendSource | null;
}

export interface RoiViewData {
  displayCurrency: string;
  from: string;
  to: string;
  rows: RoiRow[];
}

export async function roiView(
  range: { from: string; to: string },
  db: Db = getPool(),
): Promise<RoiViewData> {
  const products = await productsView(range, db);
  const tools = await toolsData(range, db);

  // Tags per product: the tags on keys routed to it plus the tags pointed at
  // it in tag_settings (the routing convention, spec 7b).
  const { rows: tagRows } = await db.query(
    `SELECT product_id AS "productId", array_agg(DISTINCT tag) AS tags FROM (
       SELECT i.product_id, t.tag
       FROM identities i CROSS JOIN LATERAL unnest(${effectiveTagsSql("i")}) AS t(tag)
       WHERE i.product_id IS NOT NULL
       UNION
       SELECT ts.product_id, ts.tag FROM tag_settings ts
       WHERE ts.product_id IS NOT NULL
     ) x GROUP BY product_id`,
  );
  const tagsByProduct = new Map<string, string[]>(
    tagRows.map((row) => [row.productId as string, row.tags as string[]]),
  );
  const productById = new Map(products.products.map((p) => [p.id, p]));

  const rows: RoiRow[] = [];

  for (const t of tools.tools) {
    const routed =
      t.spendSource?.type === "product" && t.spendSource.productId
        ? productById.get(t.spendSource.productId)
        : undefined;
    rows.push({
      key: `coding:${t.tool}`,
      kind: "coding",
      productId: null,
      tool: t.tool,
      name: toolLabel(t.tool),
      attribution: null,
      spendCents: t.spendCents,
      tokens: t.tokens,
      successes: t.linesAlive,
      revertedCount: t.reverted,
      unit: "1k lines",
      costPerSuccessCents: t.costPer1kSurvivingCents,
      tokensPerSuccess:
        t.tokens > 0 && t.linesAlive > 0
          ? Math.round((t.tokens / t.linesAlive) * 1000)
          : null,
      valueCents: null,
      roi: null,
      activeUsers: t.peopleCount,
      costPerUserCents: null,
      acceptRatePct: t.acceptRatePct,
      survivalPct: t.survivalPct,
      tags: [
        ...new Set([t.tool, ...(routed ? (tagsByProduct.get(routed.id) ?? []) : [])]),
      ],
      vendors:
        t.spendSource?.type === "product"
          ? (routed?.vendors ?? [])
          : t.spendSource?.vendor
            ? [t.spendSource.vendor]
            : [],
      spendSource: t.spendSource,
    });
  }

  for (const p of products.products) {
    rows.push({
      key: `custom:${p.id}`,
      kind: "custom",
      productId: p.id,
      tool: null,
      name: p.name,
      attribution: p.attribution,
      spendCents: p.spendCents,
      tokens: p.tokens,
      successes: p.outcomeCount,
      revertedCount: p.revertedCount,
      unit: p.unit,
      costPerSuccessCents: p.unitCostCents,
      tokensPerSuccess:
        p.tokens > 0 && p.outcomeCount > 0
          ? Math.round(p.tokens / p.outcomeCount)
          : null,
      valueCents: p.valueCents,
      roi: p.roi,
      activeUsers: p.activeUsers,
      costPerUserCents: p.costPerUserCents,
      acceptRatePct: null,
      survivalPct: null,
      tags: tagsByProduct.get(p.id) ?? [],
      vendors: p.vendors,
      spendSource: null,
    });
  }

  rows.sort(
    (a, b) =>
      (b.spendCents ?? -1) - (a.spendCents ?? -1) ||
      b.successes - a.successes ||
      a.name.localeCompare(b.name),
  );

  return {
    displayCurrency: products.displayCurrency,
    from: range.from,
    to: range.to,
    rows,
  };
}
