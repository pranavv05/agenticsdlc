import { describe, expect, it } from "vitest";
import { MODEL_PRICES, PRICE_TABLE_VERSION, computeCostUsd, computeEmbeddingCostUsd, normalizeModelId } from "../src";

describe("computeCostUsd", () => {
  it("multiplies tokens by the per-million price for input and output", () => {
    // claude-sonnet-5-5: $2 in, $10 out per million
    expect(computeCostUsd("claude-sonnet-5-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(12);
    expect(computeCostUsd("claude-sonnet-5-5", { inputTokens: 1_000, outputTokens: 0 })).toBe(0.002);
    expect(computeCostUsd("claude-sonnet-5-5", { inputTokens: 0, outputTokens: 500 })).toBe(0.005);
    expect(computeCostUsd("claude-opus-5-5", { inputTokens: 250_000, outputTokens: 50_000 })).toBe(2); // 1 + 1
    expect(computeCostUsd("claude-fable-5-1", { inputTokens: 100_000, outputTokens: 10_000 })).toBe(1.5); // 1 + 0.5
  });

  it("is zero for zero usage", () => {
    expect(computeCostUsd("claude-haiku-5-5", { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it("applies Haiku 5.5's higher price above 100K prompt tokens", () => {
    expect(computeCostUsd("claude-haiku-5-5", { inputTokens: 100_000, outputTokens: 10_000 })).toBe(0.015); // 0.01 + 0.005
    expect(computeCostUsd("claude-haiku-5-5", { inputTokens: 100_002, outputTokens: 10_000 })).toBe(0.075001); // 0.050001 + 0.025
  });

  it("counts cache reads at 0.1x and cache writes at 1.25x the input price, and in the prompt-size tier", () => {
    expect(computeCostUsd("claude-sonnet-5-5", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 })).toBe(0.2);
    expect(computeCostUsd("claude-sonnet-5-5", { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 })).toBe(2.5);
    // 60K input + 50K cache read = 110K prompt tokens: Haiku 5.5's upper tier applies
    expect(computeCostUsd("claude-haiku-5-5", { inputTokens: 60_000, outputTokens: 0, cacheReadTokens: 50_000 })).toBe(0.0325); // (60000 + 5000) * 0.5 / 1M
  });

  it("rounds to micro-dollars so sums do not accumulate float noise", () => {
    expect(computeCostUsd("claude-haiku-5-5", { inputTokens: 3, outputTokens: 3 })).toBe(0.000002);
    const cents = computeCostUsd("claude-sonnet-5-5", { inputTokens: 1234, outputTokens: 567 });
    expect(cents).toBe(0.008138);
    expect(String(cents).length).toBeLessThan(12);
  });

  it("throws for a model without a price instead of reporting $0", () => {
    expect(() => computeCostUsd("claude-sonnet-9-9", { inputTokens: 1, outputTokens: 1 })).toThrow(/No price for model/);
    expect(() => computeCostUsd("gpt-5", { inputTokens: 1, outputTokens: 1 })).toThrow(/prices\.ts/);
  });

  it("has a positive price for every model, ordered tiers, and a version", () => {
    expect(PRICE_TABLE_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const [model, tiers] of Object.entries(MODEL_PRICES)) {
      expect(tiers.length, model).toBeGreaterThan(0);
      for (const tier of tiers) {
        expect(tier.inputPerMTok, model).toBeGreaterThan(0);
        expect(tier.outputPerMTok, model).toBeGreaterThan(tier.inputPerMTok);
      }
      expect(tiers[tiers.length - 1].maxPromptTokens, `${model}: last tier must be open-ended`).toBeUndefined();
    }
  });
});

describe("normalizeModelId", () => {
  it.each([
    ["claude-sonnet-5-5", "claude-sonnet-5-5"],
    ["claude-haiku-4-5-20251001", "claude-haiku-4-5"],
    ["claude-opus-5", "claude-opus-5"],
    ["CLAUDE-OPUS-5-5", "claude-opus-5-5"],
    ["claude-sonnet-5@20260101", "claude-sonnet-5"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeModelId(input)).toBe(expected);
  });

  it("leaves unknown names alone (lowercased) so they fail the price lookup", () => {
    expect(normalizeModelId("Some-Other-Model")).toBe("some-other-model");
  });

  it("maps every priced model to itself", () => {
    for (const model of Object.keys(MODEL_PRICES)) expect(normalizeModelId(model)).toBe(model);
  });
});

describe("computeEmbeddingCostUsd", () => {
  it("charges $0.18 per million tokens for voyage-code-3", () => {
    expect(computeEmbeddingCostUsd("voyage-code-3", 1_000_000)).toBe(0.18);
    expect(computeEmbeddingCostUsd("voyage-code-3", 1_500_000)).toBe(0.27);
    expect(computeEmbeddingCostUsd("voyage-code-3", 0)).toBe(0);
  });

  it("throws for an unpriced embedding model", () => {
    expect(() => computeEmbeddingCostUsd("voyage-9", 10)).toThrow(/No price/);
  });
});
