import { ResolveError } from "./resolve";
import { fxExpr } from "./rollup";

/**
 * Read-layer primitives shared by every dashboard reader (overview, people,
 * products, tools). A leaf module on purpose: products.ts sits inside the
 * connector import chain (sync -> invoices -> products), so anything it
 * needs must not pull in ./connectors the way overview.ts does.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function assertDay(name: string, value: string): void {
  if (!DATE_RE.test(value)) {
    throw new ResolveError(`${name} must be YYYY-MM-DD`, 400);
  }
}

/** Per-day USD-cents -> display-currency-cents, as a LATERAL alias `d`.
 * $1 must be the display currency in every query that embeds this. */
export function displayLateral(rowAlias: string): string {
  return `CROSS JOIN LATERAL (
    SELECT ${rowAlias}.amount_usd_cents::numeric / ${fxExpr("$1::text", `${rowAlias}.day`)} AS cents
  ) d`;
}

export interface TrendPoint {
  day: string;
  cents: number;
}
