/**
 * Versioned price table. One file on purpose: when Anthropic changes prices, this is the only place to edit,
 * and PRICE_TABLE_VERSION says which snapshot the recorded costs were computed with.
 *
 * Source: first-party Claude API list prices (USD per million tokens), snapshot 2026-10-06.
 * Voyage: scope section 3 ("$0.18/million tokens" after the free allowance).
 *
 * Costs are estimates for budgeting and the Case A vs Case B comparison, not an invoice.
 */
export const PRICE_TABLE_VERSION = "2026-10-06";

export interface PriceTier {
  /** Applies when the prompt (input + cache tokens) has at most this many tokens. Omit for "above every other tier". */
  maxPromptTokens?: number;
  inputPerMTok: number;
  outputPerMTok: number;
}

/** Ordered from the smallest `maxPromptTokens` to the open-ended last tier. */
export type ModelPrice = readonly PriceTier[];

const flat = (inputPerMTok: number, outputPerMTok: number): ModelPrice => [{ inputPerMTok, outputPerMTok }];

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-fable-5-1": flat(10, 50),
  "claude-mythos-5-1": flat(10, 50),
  "claude-fable-5": flat(10, 50),
  "claude-opus-5-5": flat(4, 20),
  "claude-opus-5": flat(5, 25),
  "claude-opus-4-8": flat(5, 25),
  "claude-opus-4-7": flat(5, 25),
  "claude-opus-4-6": flat(5, 25),
  "claude-sonnet-5-5": flat(2, 10),
  "claude-sonnet-5": flat(2, 10),
  "claude-sonnet-4-6": flat(3, 15),
  // Haiku 5.5 is cheaper for prompts up to 100K tokens.
  "claude-haiku-5-5": [
    { maxPromptTokens: 100_000, inputPerMTok: 0.1, outputPerMTok: 0.5 },
    { inputPerMTok: 0.5, outputPerMTok: 2.5 },
  ],
  "claude-haiku-4-5": flat(1, 5),
};

/** Prompt caching multipliers on the input price (5-minute TTL). The gateway does not use caching yet; these keep the arithmetic right if usage reports it. */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;

export const EMBEDDING_PRICES: Readonly<Record<string, number>> = {
  /** USD per million tokens. */
  "voyage-code-3": 0.18,
};

/**
 * Maps any provider spelling of a model id to the key used in MODEL_PRICES:
 * "claude-sonnet-5-5", "anthropic.claude-sonnet-5-5", "us.anthropic.claude-sonnet-5-5-v1:0", "claude-haiku-4-5-20251001".
 */
export function normalizeModelId(model: string): string {
  const match = /claude-(?:opus|sonnet|haiku|fable|mythos)-\d+(?:-\d{1,2})?(?!\d)/i.exec(model);
  return (match ? match[0] : model).toLowerCase();
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Estimated cost in USD. Throws for a model with no price so a new model cannot silently report $0. */
export function computeCostUsd(model: string, usage: TokenUsage): number {
  const price = MODEL_PRICES[normalizeModelId(model)];
  if (!price) throw new Error(`No price for model "${model}". Add it to MODEL_PRICES in packages/llm/src/prices.ts.`);
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const promptTokens = usage.inputTokens + cacheRead + cacheWrite;
  const tier = price.find((t) => t.maxPromptTokens === undefined || promptTokens <= t.maxPromptTokens) ?? price[price.length - 1];
  const input = usage.inputTokens + cacheRead * CACHE_READ_MULTIPLIER + cacheWrite * CACHE_WRITE_MULTIPLIER;
  return round6((input * tier.inputPerMTok + usage.outputTokens * tier.outputPerMTok) / 1_000_000);
}

export function computeEmbeddingCostUsd(model: string, tokens: number): number {
  const perMTok = EMBEDDING_PRICES[model];
  if (perMTok === undefined)
    throw new Error(`No price for embedding model "${model}". Add it to EMBEDDING_PRICES in packages/llm/src/prices.ts.`);
  return round6((tokens * perMTok) / 1_000_000);
}
