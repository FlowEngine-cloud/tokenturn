/**
 * Pinned Anthropic token prices (spec 4: token-to-dollar estimates use the
 * LiteLLM model-prices file, pinned per release).
 *
 * Why this exists: Anthropic's usage report groups raw API spend by API key
 * and workspace but reports TOKENS, not dollars - and the cost report
 * groups dollars by workspace only, never by key. Per-employee dollars
 * (one key per person, spec 5) therefore have to be priced from tokens.
 * Every fact priced here is marked cost_basis = "estimated".
 *
 * Prices are USD per million tokens, taken from LiteLLM's
 * model_prices_and_context_window.json (pinned 2026-06-10). Cache pricing
 * uses Anthropic's published multipliers on the input rate: cache reads
 * 0.1x, 5-minute cache writes 1.25x, 1-hour cache writes 2x.
 *
 * An unknown model THROWS instead of guessing or writing zero - no fake
 * numbers (spec 3). The sync fails with the model name verbatim in
 * connector health; the fix is one line here.
 */

interface ModelPrice {
  /** USD per 1M uncached input tokens. */
  inputPerMTok: number;
  /** USD per 1M output tokens. */
  outputPerMTok: number;
}

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_5M_WRITE_MULTIPLIER = 1.25;
const CACHE_1H_WRITE_MULTIPLIER = 2;

/** Keys are model ids with any -YYYYMMDD date suffix stripped. */
const PRICES: Record<string, ModelPrice> = {
  "claude-fable-5": { inputPerMTok: 10, outputPerMTok: 50 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-6": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-1": { inputPerMTok: 15, outputPerMTok: 75 },
  "claude-opus-4": { inputPerMTok: 15, outputPerMTok: 75 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-sonnet-4-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-sonnet-4": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-3-7-sonnet": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-3-5-sonnet": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  "claude-3-5-haiku": { inputPerMTok: 0.8, outputPerMTok: 4 },
  "claude-3-haiku": { inputPerMTok: 0.25, outputPerMTok: 1.25 },
};

export interface AnthropicTokenCounts {
  uncachedInput: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

function lookupPrice(model: string): ModelPrice {
  const exact = PRICES[model];
  if (exact) return exact;
  // Usage reports use dated ids ("claude-sonnet-4-20250514"); the pinned
  // table keys are undated.
  const undated = PRICES[model.replace(/-\d{8}$/, "")];
  if (undated) return undated;
  throw new Error(
    `no pinned price for Anthropic model "${model}" - add it to the pinned price table (anthropic-prices.ts)`,
  );
}

/** Estimated cost in whole USD cents for one usage-report row. */
export function estimateAnthropicUsdCents(
  model: string,
  tokens: AnthropicTokenCounts,
): number {
  const price = lookupPrice(model);
  const usd =
    (tokens.uncachedInput * price.inputPerMTok +
      tokens.output * price.outputPerMTok +
      tokens.cacheRead * price.inputPerMTok * CACHE_READ_MULTIPLIER +
      tokens.cacheWrite5m * price.inputPerMTok * CACHE_5M_WRITE_MULTIPLIER +
      tokens.cacheWrite1h * price.inputPerMTok * CACHE_1H_WRITE_MULTIPLIER) /
    1_000_000;
  return Math.round(usd * 100);
}
