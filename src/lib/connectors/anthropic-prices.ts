import { lookupPinnedPrice, PRICE_PIN_FILE } from "./prices";

/**
 * Anthropic token-to-dollar estimation over the shared pinned price table
 * (prices.ts / model-prices.json).
 *
 * Why this exists: Anthropic's usage report groups raw API spend by API key
 * and workspace but reports TOKENS, not dollars - and the cost report
 * groups dollars by workspace only, never by key. Per-employee dollars
 * (one key per person, spec 5) therefore have to be priced from tokens.
 * Every fact priced here is marked cost_basis = "estimated".
 *
 * Cache rates come from the pin's explicit columns (Anthropic's published
 * multipliers on the input rate: reads 0.1x, 5-minute writes 1.25x, 1-hour
 * writes 2x). An unknown model, or cache traffic on a model pinned without
 * cache rates, THROWS instead of guessing or writing zero - no fake numbers
 * (spec 3); the fix is one entry in the pinned price file.
 */

export interface AnthropicTokenCounts {
  uncachedInput: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

function cacheRate(
  model: string,
  perMTok: number | undefined,
  tokens: number,
  kind: string,
): number {
  if (tokens === 0) return 0;
  if (perMTok === undefined) {
    throw new Error(
      `no pinned ${kind} price for Anthropic model "${model}" - add it to the pinned price file (${PRICE_PIN_FILE})`,
    );
  }
  return perMTok;
}

/** Estimated cost in whole USD cents for one usage-report row. */
export function estimateAnthropicUsdCents(
  model: string,
  tokens: AnthropicTokenCounts,
): number {
  const price = lookupPinnedPrice("anthropic", model);
  const usd =
    (tokens.uncachedInput * price.inputPerMTok +
      tokens.output * price.outputPerMTok +
      tokens.cacheRead *
        cacheRate(model, price.cacheReadPerMTok, tokens.cacheRead, "cache-read") +
      tokens.cacheWrite5m *
        cacheRate(model, price.cacheWrite5mPerMTok, tokens.cacheWrite5m, "5-minute cache-write") +
      tokens.cacheWrite1h *
        cacheRate(model, price.cacheWrite1hPerMTok, tokens.cacheWrite1h, "1-hour cache-write")) /
    1_000_000;
  return Math.round(usd * 100);
}
