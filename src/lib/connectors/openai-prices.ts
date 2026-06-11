import { lookupPinnedPrice, PRICE_PIN_FILE } from "./prices";

/**
 * OpenAI token-to-dollar estimation over the shared pinned price table
 * (prices.ts / model-prices.json).
 *
 * Why this exists: OpenAI's cost report groups dollars by project and line
 * item only - never by user or key. The usage report DOES group tokens by
 * user and key, so per-user dollars are those tokens priced from the pin,
 * and every fact priced here is marked cost_basis = "estimated" (spec 5
 * vendor limits).
 *
 * Pricing truths, all strict - anything unpriceable THROWS instead of
 * guessing (no fake numbers, spec 3; the fix is one entry in the pin):
 * - input_tokens includes cached tokens; cached tokens bill at the model's
 *   cache-read rate, the rest at the input rate.
 * - Batch usage bills at the pinned batch rates (50% list). Batch rows with
 *   cached or audio tokens have no published combined rate - throw.
 * - Audio tokens bill at the pinned audio rates. The usage report does not
 *   split cached audio, so audio input is priced at the full audio rate.
 */

export interface OpenAiTokenCounts {
  /** Text input tokens, INCLUDING cached ones (vendor semantics). */
  input: number;
  /** Cached text input tokens - a subset of `input`. */
  cachedInput: number;
  output: number;
  audioInput: number;
  audioOutput: number;
  batch: boolean;
}

function rateFor(
  model: string,
  perMTok: number | undefined,
  tokens: number,
  kind: string,
): number {
  if (tokens === 0) return 0;
  if (perMTok === undefined) {
    throw new Error(
      `no pinned ${kind} price for OpenAI model "${model}" - add it to the pinned price file (${PRICE_PIN_FILE})`,
    );
  }
  return perMTok;
}

/** Estimated cost in whole USD cents for one usage-report row. */
export function estimateOpenAiUsdCents(
  model: string,
  tokens: OpenAiTokenCounts,
): number {
  const price = lookupPinnedPrice("openai", model);
  if (tokens.cachedInput > tokens.input) {
    throw new Error(
      `OpenAI reported more cached than total input tokens for "${model}" (${tokens.cachedInput} > ${tokens.input})`,
    );
  }

  let usd: number;
  if (tokens.batch) {
    if (tokens.cachedInput > 0 || tokens.audioInput > 0 || tokens.audioOutput > 0) {
      throw new Error(
        `OpenAI reported cached or audio tokens on batch usage for "${model}" - no pinned rate for that combination`,
      );
    }
    usd =
      (tokens.input * rateFor(model, price.batchInputPerMTok, tokens.input, "batch input") +
        tokens.output *
          rateFor(model, price.batchOutputPerMTok, tokens.output, "batch output")) /
      1_000_000;
  } else {
    usd =
      ((tokens.input - tokens.cachedInput) * price.inputPerMTok +
        tokens.cachedInput *
          rateFor(model, price.cacheReadPerMTok, tokens.cachedInput, "cache-read") +
        tokens.output * price.outputPerMTok +
        tokens.audioInput *
          rateFor(model, price.audioInputPerMTok, tokens.audioInput, "audio input") +
        tokens.audioOutput *
          rateFor(model, price.audioOutputPerMTok, tokens.audioOutput, "audio output")) /
      1_000_000;
  }
  return Math.round(usd * 100);
}
