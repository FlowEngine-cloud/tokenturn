import pinned from "./model-prices.json";

/**
 * The shared pinned price table (spec 4: token-to-dollar estimates use the
 * LiteLLM model-prices file, pinned per release).
 *
 * model-prices.json is a pruned snapshot of LiteLLM's
 * model_prices_and_context_window.json, kept in their schema (USD per
 * token) so re-pinning a release is a copy of upstream entries. This module
 * converts each entry to exact-decimal USD per million tokens once at load
 * (picodollar rounding kills the float noise in values like 1.25e-6), and
 * the vendor estimators (anthropic-prices.ts, openai-prices.ts) do the cent
 * math from there. Every fact priced from this table is cost_basis
 * "estimated" - vendors report tokens here, never dollars.
 *
 * An unknown model THROWS instead of guessing or writing zero - no fake
 * numbers (spec 3). The sync fails with the model name verbatim in
 * connector health; the fix is one new entry in model-prices.json.
 *
 * Only pin models a connector actually estimates per user/key: the OpenAI
 * cost-report skip rule treats a pinned model's token line items as money
 * already on the ledger.
 */

export const PRICE_PIN_FILE = "src/lib/connectors/model-prices.json";

export type PinnedProvider = "anthropic" | "openai";

/** USD per million tokens, exact decimals. */
export interface PinnedPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  cacheWrite5mPerMTok?: number;
  cacheWrite1hPerMTok?: number;
  batchInputPerMTok?: number;
  batchOutputPerMTok?: number;
  audioInputPerMTok?: number;
  audioOutputPerMTok?: number;
}

const PROVIDER_LABEL: Record<PinnedProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

interface LiteLlmEntry {
  litellm_provider?: string;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  cache_creation_input_token_cost_above_1hr?: number;
  input_cost_per_token_batches?: number;
  output_cost_per_token_batches?: number;
  input_cost_per_audio_token?: number;
  output_cost_per_audio_token?: number;
}

/** USD/token -> exact-decimal USD/MTok (round at picodollars). */
function perMTok(perToken: number): number;
function perMTok(perToken: number | undefined): number | undefined;
function perMTok(perToken: number | undefined): number | undefined {
  if (perToken === undefined) return undefined;
  return Math.round(perToken * 1e12) / 1e6;
}

function buildTables(): Record<PinnedProvider, Map<string, PinnedPrice>> {
  const tables: Record<PinnedProvider, Map<string, PinnedPrice>> = {
    anthropic: new Map(),
    openai: new Map(),
  };
  for (const [model, entry] of Object.entries(
    pinned as Record<string, LiteLlmEntry | Record<string, unknown>>,
  )) {
    const raw = entry as LiteLlmEntry;
    const provider = raw.litellm_provider;
    if (provider !== "anthropic" && provider !== "openai") continue; // sample_spec etc.
    if (
      typeof raw.input_cost_per_token !== "number" ||
      typeof raw.output_cost_per_token !== "number"
    ) {
      throw new Error(
        `pinned price entry "${model}" is missing input/output token costs (${PRICE_PIN_FILE})`,
      );
    }
    tables[provider].set(model, {
      inputPerMTok: perMTok(raw.input_cost_per_token),
      outputPerMTok: perMTok(raw.output_cost_per_token),
      cacheReadPerMTok: perMTok(raw.cache_read_input_token_cost),
      cacheWrite5mPerMTok: perMTok(raw.cache_creation_input_token_cost),
      cacheWrite1hPerMTok: perMTok(raw.cache_creation_input_token_cost_above_1hr),
      batchInputPerMTok: perMTok(raw.input_cost_per_token_batches),
      batchOutputPerMTok: perMTok(raw.output_cost_per_token_batches),
      audioInputPerMTok: perMTok(raw.input_cost_per_audio_token),
      audioOutputPerMTok: perMTok(raw.output_cost_per_audio_token),
    });
  }
  return tables;
}

const TABLES = buildTables();

/**
 * Usage reports use dated model ids; the pinned table keys are undated.
 * Anthropic dates look like "claude-sonnet-4-20250514", OpenAI like
 * "gpt-4o-2024-08-06".
 */
const DATE_SUFFIXES = [/-\d{4}-\d{2}-\d{2}$/, /-\d{8}$/];

export function tryLookupPinnedPrice(
  provider: PinnedProvider,
  model: string,
): PinnedPrice | null {
  const table = TABLES[provider];
  const exact = table.get(model);
  if (exact) return exact;
  for (const suffix of DATE_SUFFIXES) {
    const undated = model.replace(suffix, "");
    if (undated !== model) {
      const hit = table.get(undated);
      if (hit) return hit;
    }
  }
  return null;
}

export function hasPinnedPrice(provider: PinnedProvider, model: string): boolean {
  return tryLookupPinnedPrice(provider, model) !== null;
}

export function lookupPinnedPrice(
  provider: PinnedProvider,
  model: string,
): PinnedPrice {
  const price = tryLookupPinnedPrice(provider, model);
  if (!price) {
    throw new Error(
      `no pinned price for ${PROVIDER_LABEL[provider]} model "${model}" - add it to the pinned price file (${PRICE_PIN_FILE})`,
    );
  }
  return price;
}
