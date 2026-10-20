import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  LlmApiError,
  LlmConfigError,
  LlmInputError,
  LlmRefusalError,
  LlmTruncatedError,
  LlmValidationError,
  TransportError,
  resolveModel,
} from "../src";
import { baseRequest, harness, reply } from "./helpers";

afterEach(() => vi.useRealTimers());

const good = { title: "Hello", count: 3 };

describe("generateStructured: happy path", () => {
  it("returns schema-valid data and usage with cost", async () => {
    const h = harness([reply({ toolInput: good })]);
    const result = await h.gateway.generateStructured(baseRequest);
    expect(result.data).toEqual(good);
    // claude-haiku-5-5: 1000 in * $0.10/M + 200 out * $0.50/M
    expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 200, costUsd: 0.0002, model: "claude-haiku-5-5", latencyMs: 10 });
    expect(h.transport.calls).toHaveLength(1);
  });

  it("writes exactly one usage record per billed call", async () => {
    const h = harness([reply({ toolInput: good })]);
    await h.gateway.generateStructured({ ...baseRequest, initiativeId: "3f2b8c1e-5a7d-4e29-9c4b-1d6e8f0a2b34" });
    expect(h.usage).toEqual([
      {
        inputTokens: 1000,
        outputTokens: 200,
        costUsd: 0.0002,
        model: "claude-haiku-5-5",
        latencyMs: 10,
        agent: "requirement",
        name: "answer",
        status: "succeeded",
        initiativeId: "3f2b8c1e-5a7d-4e29-9c4b-1d6e8f0a2b34",
        mocked: false,
      },
    ]);
  });

  it("counts cache tokens in the prompt size and the cost", async () => {
    const h = harness(
      [
        reply({
          toolInput: good,
          model: "claude-sonnet-5-5",
          usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 10_000, cacheWriteTokens: 0 },
        }),
      ],
      {
        env: { LLM_MODEL: "claude-sonnet-5-5" },
      },
    );
    const { usage } = await h.gateway.generateStructured(baseRequest);
    expect(usage.inputTokens).toBe(11_000);
    // (1000 + 10000 * 0.1) * $2/M + 100 * $10/M
    expect(usage.costUsd).toBe(0.005);
  });
});

describe("generateStructured: the request that is sent", () => {
  it("never sends sampling parameters or a thinking budget", async () => {
    const h = harness([reply({ toolInput: good })]);
    await h.gateway.generateStructured(baseRequest);
    const sent = h.transport.calls[0] as unknown as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(["effort", "maxTokens", "model", "signal", "system", "tool", "user"].sort());
  });

  it("uses tool_choice auto plus an explicit instruction on models that reject forced tool use", async () => {
    for (const model of ["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1", "claude-haiku-5-5"]) {
      const h = harness([reply({ toolInput: good, model })]);
      await h.gateway.generateStructured({ ...baseRequest, model });
      const sent = h.transport.calls[0];
      expect(sent.tool?.forced, model).toBe(false);
      expect(sent.system, model).toContain('calling the "answer" tool exactly once');
    }
  });

  it("forces the tool on models that still allow it", async () => {
    for (const model of ["claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5"]) {
      const h = harness([reply({ toolInput: good, model })]);
      await h.gateway.generateStructured({ ...baseRequest, model });
      expect(h.transport.calls[0].tool?.forced, model).toBe(true);
      expect(h.transport.calls[0].system, model).toBe(baseRequest.system);
    }
  });

  it("sends the Zod schema as a JSON-schema object tool without $schema", async () => {
    const h = harness([reply({ toolInput: good })]);
    await h.gateway.generateStructured(baseRequest);
    const tool = h.transport.calls[0].tool!;
    expect(tool.name).toBe("answer");
    expect(tool.inputSchema.$schema).toBeUndefined();
    expect(tool.inputSchema.type).toBe("object");
    expect(Object.keys(tool.inputSchema.properties as object)).toEqual(["title", "count"]);
    expect(tool.inputSchema.required).toEqual(["title", "count"]);
  });

  it("passes effort and the per-call model through, and defaults maxTokens", async () => {
    const h = harness([reply({ toolInput: good, model: "claude-opus-5-5" })]);
    await h.gateway.generateStructured({ ...baseRequest, model: "claude-opus-5-5", effort: "low" });
    expect(h.transport.calls[0]).toMatchObject({ model: "claude-opus-5-5", effort: "low", maxTokens: 8192 });
  });
});

describe("generateStructured: exactly one retry on a malformed response", () => {
  it("retries once with the validation error fed back, then succeeds", async () => {
    const h = harness([reply({ toolInput: { title: "x", count: "many" } }), reply({ toolInput: good })]);
    const result = await h.gateway.generateStructured(baseRequest);

    expect(result.data).toEqual(good);
    expect(h.transport.calls).toHaveLength(2);
    const retry = h.transport.calls[1].user;
    expect(retry.startsWith(baseRequest.input)).toBe(true);
    expect(retry).toContain("<validation_feedback>");
    expect(retry).toContain("title:"); // too short
    expect(retry).toContain("count:"); // not a number
    expect(retry).toContain('{"title":"x","count":"many"}');
  });

  it("bills both attempts: two usage records and summed usage", async () => {
    const h = harness([reply({ toolInput: { nope: true } }), reply({ toolInput: good })]);
    const result = await h.gateway.generateStructured(baseRequest);
    expect(h.usage.map((u) => u.status)).toEqual(["failed", "succeeded"]);
    expect(h.usage[0].error).toContain("Schema validation failed");
    expect(result.usage).toMatchObject({ inputTokens: 2000, outputTokens: 400, costUsd: 0.0004, latencyMs: 20 });
  });

  it("does not retry a second time: a second malformed response throws LlmValidationError", async () => {
    const h = harness([reply({ toolInput: { nope: 1 } }), reply({ toolInput: { nope: 2 } }), reply({ toolInput: good })]);
    const error = await h.gateway.generateStructured(baseRequest).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmValidationError);
    expect((error as LlmValidationError).rawOutput).toEqual({ nope: 2 });
    expect((error as LlmValidationError).issues.length).toBeGreaterThan(0);
    expect(h.transport.calls).toHaveLength(2);
    expect(h.usage.map((u) => u.status)).toEqual(["failed", "failed"]);
  });

  it("treats a text-only answer (no tool call) as malformed and retries", async () => {
    const h = harness([reply({ text: "Sure, here you go", stopReason: "end_turn" }), reply({ toolInput: good })]);
    await h.gateway.generateStructured(baseRequest);
    expect(h.transport.calls).toHaveLength(2);
    expect(h.transport.calls[1].user).toContain('You did not call the "answer" tool');
  });
});

describe("generateStructured: outcomes that must not be retried", () => {
  it("throws LlmRefusalError with the category and does not retry", async () => {
    const h = harness([reply({ stopReason: "refusal", refusalCategory: "cyber" })]);
    const error = await h.gateway.generateStructured(baseRequest).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmRefusalError);
    expect((error as LlmRefusalError).category).toBe("cyber");
    expect(h.transport.calls).toHaveLength(1);
    expect(h.usage[0].status).toBe("failed");
  });

  it("throws LlmTruncatedError when output hits maxTokens and does not retry", async () => {
    const h = harness([reply({ stopReason: "max_tokens", toolInput: { title: "cut" } })]);
    await expect(h.gateway.generateStructured({ ...baseRequest, maxTokens: 500 })).rejects.toThrow(LlmTruncatedError);
    expect(h.transport.calls).toHaveLength(1);
  });
});

describe("retry and backoff", () => {
  const rateLimited = new TransportError("rate limited", 429, true);

  it("backs off exponentially with jitter on 429, then succeeds", async () => {
    const h = harness([rateLimited, rateLimited, reply({ toolInput: good })]);
    await h.gateway.generateStructured(baseRequest);
    expect(h.transport.calls).toHaveLength(3);
    // random() = 0.5 -> delay = ceiling * 0.75; ceilings 1000 then 2000
    expect(h.sleeps).toEqual([750, 1500]);
  });

  it("keeps each delay inside [ceiling / 2, ceiling]", async () => {
    for (const random of [0, 0.999999]) {
      const h = harness([rateLimited, rateLimited, rateLimited, reply({ toolInput: good })], { random: () => random });
      await h.gateway.generateStructured(baseRequest);
      h.sleeps.forEach((delay, i) => {
        const ceiling = 1000 * 2 ** i;
        expect(delay).toBeGreaterThanOrEqual(ceiling / 2);
        expect(delay).toBeLessThanOrEqual(ceiling);
      });
    }
  });

  it("caps the delay at maxDelayMs", async () => {
    const h = harness([rateLimited, rateLimited, rateLimited, rateLimited, reply({ toolInput: good })], {
      maxDelayMs: 2500,
      random: () => 0.999999,
    });
    await h.gateway.generateStructured(baseRequest);
    expect(Math.max(...h.sleeps)).toBeLessThanOrEqual(2500);
    expect(h.sleeps[3]).toBeGreaterThan(2400);
  });

  it("waits at least as long as Retry-After asks", async () => {
    const h = harness([new TransportError("slow down", 429, true, 10_000), reply({ toolInput: good })]);
    await h.gateway.generateStructured(baseRequest);
    expect(h.sleeps).toEqual([10_000]);
  });

  it("retries 5xx and network errors", async () => {
    const h = harness([
      new TransportError("overloaded", 529, true),
      new TransportError("reset", undefined, true),
      reply({ toolInput: good }),
    ]);
    await h.gateway.generateStructured(baseRequest);
    expect(h.transport.calls).toHaveLength(3);
  });

  it("does not retry a 400: fails at once with the status", async () => {
    const h = harness([new TransportError("bad request", 400, false), reply({ toolInput: good })]);
    const error = await h.gateway.generateStructured(baseRequest).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmApiError);
    expect((error as LlmApiError).status).toBe(400);
    expect((error as LlmApiError).attempts).toBe(1);
    expect(h.transport.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  it("gives up after maxRetries and reports the attempts", async () => {
    const h = harness([rateLimited], { maxRetries: 2 });
    const error = await h.gateway.generateStructured(baseRequest).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmApiError);
    expect((error as LlmApiError).attempts).toBe(3);
    expect(h.transport.calls).toHaveLength(3);
    expect(h.sleeps).toHaveLength(2);
    expect(h.usage).toHaveLength(1);
    expect(h.usage[0]).toMatchObject({ status: "failed", inputTokens: 0, outputTokens: 0, costUsd: 0 });
  });

  it("times out a hung request, aborts it, and retries", async () => {
    vi.useFakeTimers();
    let first = true;
    let aborted = false;
    const h = harness(
      [
        (request) => {
          if (first) {
            first = false;
            request.signal?.addEventListener("abort", () => (aborted = true));
            return new Promise<never>(() => {}); // never answers
          }
          return reply({ toolInput: good });
        },
      ],
      { timeoutMs: 1_000 },
    );
    const pending = h.gateway.generateStructured(baseRequest);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({ data: good });
    expect(aborted).toBe(true);
    expect(h.transport.calls).toHaveLength(2);
    expect(h.sleeps).toHaveLength(1);
  });

  it("reports a timeout as LlmApiError when retries are exhausted", async () => {
    vi.useFakeTimers();
    const h = harness([() => new Promise<never>(() => {})], { timeoutMs: 500, maxRetries: 0 });
    const pending = h.gateway.generateStructured(baseRequest);
    const assertion = expect(pending).rejects.toThrow(/timed out after 500ms/);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });

  it("stops at once when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness([new TransportError("whatever", 503, true)]);
    await expect(h.gateway.generateStructured({ ...baseRequest, signal: controller.signal })).rejects.toThrow(/aborted by the caller/);
    expect(h.sleeps).toEqual([]);
  });
});

describe("request validation (nothing is sent)", () => {
  it("rejects oversize input", async () => {
    const h = harness([reply({ toolInput: good })], { maxInputChars: 1000 });
    await expect(h.gateway.generateStructured({ ...baseRequest, input: "x".repeat(1001) })).rejects.toThrow(LlmInputError);
    expect(h.transport.calls).toHaveLength(0);
  });

  it("counts the system prompt toward the input limit", async () => {
    const h = harness([reply({ toolInput: good })], { maxInputChars: 100 });
    await expect(h.gateway.generateStructured({ ...baseRequest, system: "s".repeat(90), input: "i".repeat(20) })).rejects.toThrow(
      /over the limit/,
    );
  });

  it("enforces the hard cap on tokens per call", async () => {
    const h = harness([reply({ toolInput: good })], { maxTokensCap: 4000 });
    await expect(h.gateway.generateStructured({ ...baseRequest, maxTokens: 4001 })).rejects.toThrow(/hard cap of 4000/);
    await expect(h.gateway.generateStructured({ ...baseRequest, maxTokens: 4000 })).resolves.toBeDefined();
    expect(h.transport.calls).toHaveLength(1);
  });

  it.each([
    ["empty input", { input: "   " }],
    ["bad call name", { name: "has space" }],
    ["unknown agent", { agent: "reviewer" as never }],
    ["zero maxTokens", { maxTokens: 0 }],
    ["fractional maxTokens", { maxTokens: 10.5 }],
  ])("rejects %s", async (_label, patch) => {
    const h = harness([reply({ toolInput: good })]);
    await expect(h.gateway.generateStructured({ ...baseRequest, ...patch })).rejects.toThrow(LlmInputError);
    expect(h.transport.calls).toHaveLength(0);
  });

  it("refuses a model it has no price for, before sending anything", async () => {
    const h = harness([reply({ toolInput: good })]);
    await expect(h.gateway.generateStructured({ ...baseRequest, model: "claude-unknown-9-9" })).rejects.toThrow(LlmConfigError);
    expect(h.transport.calls).toHaveLength(0);
  });

  it("rejects a schema that cannot be sent as a tool", async () => {
    const h = harness([reply({ toolInput: good })]);
    await expect(h.gateway.generateStructured({ ...baseRequest, schema: z.string() })).rejects.toThrow(/must describe a JSON object/);
    await expect(
      h.gateway.generateStructured({ ...baseRequest, schema: z.object({ d: z.string().transform((s) => new Date(s)) }) }),
    ).rejects.toThrow(LlmConfigError);
    expect(h.transport.calls).toHaveLength(0);
  });
});

describe("usage hook", () => {
  it("lets a failing hook surface instead of silently losing the cost row", async () => {
    const h = harness([reply({ toolInput: good })], {
      onUsage: () => {
        throw new Error("database is down");
      },
    });
    await expect(h.gateway.generateStructured(baseRequest)).rejects.toThrow("database is down");
  });
});

describe("model selection", () => {
  it("prefers the call, then LLM_MODEL, then the legacy names", () => {
    expect(resolveModel("claude-opus-5-5", { LLM_MODEL: "claude-haiku-5-5" })).toBe("claude-opus-5-5");
    expect(resolveModel(undefined, { LLM_MODEL: "claude-sonnet-5-5", SDD_MODEL: "x" })).toBe("claude-sonnet-5-5");
    expect(resolveModel(undefined, { SDD_MODEL: "claude-sonnet-5" })).toBe("claude-sonnet-5");
    expect(resolveModel(undefined, { CLAUDE_MODEL: "claude-opus-5" })).toBe("claude-opus-5");
  });

  it("defaults to the cheap model in development and the stronger model in production", () => {
    expect(resolveModel(undefined, {})).toBe("claude-haiku-5-5");
    expect(resolveModel(undefined, { NODE_ENV: "test" })).toBe("claude-haiku-5-5");
    expect(resolveModel(undefined, { NODE_ENV: "production" })).toBe("claude-sonnet-5-5");
  });

  it("requires an explicit model on Bedrock", () => {
    expect(() => resolveModel(undefined, {}, "bedrock")).toThrow(LlmConfigError);
    expect(resolveModel(undefined, { LLM_MODEL: "us.anthropic.claude-sonnet-5-5-v1:0" }, "bedrock")).toBe(
      "us.anthropic.claude-sonnet-5-5-v1:0",
    );
  });

  it("prices a Bedrock inference-profile id like the model it wraps", async () => {
    const model = "us.anthropic.claude-sonnet-5-5-v1:0";
    const h = harness([reply({ toolInput: good, model })], { env: { LLM_MODEL: model } });
    const { usage } = await h.gateway.generateStructured(baseRequest);
    expect(usage.costUsd).toBe(0.004); // 1000 * $2/M + 200 * $10/M
  });
});
