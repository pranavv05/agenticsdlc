import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { TransportError, createAnthropicTransport, type LlmRequest } from "../src";

const request: LlmRequest = {
  model: "claude-haiku-5-5",
  system: "sys",
  user: "hello",
  maxTokens: 1000,
  effort: "low",
  tool: { name: "answer", description: "d", inputSchema: { type: "object", properties: { a: { type: "string" } } }, forced: false },
};

const body = {
  model: "claude-haiku-5-5",
  content: [
    { type: "thinking", thinking: "" },
    { type: "text", text: "Calling the tool." },
    { type: "tool_use", id: "t1", name: "other", input: { ignored: true } },
    { type: "tool_use", id: "t2", name: "answer", input: { a: "x" } },
  ],
  stop_reason: "tool_use",
  usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 5, cache_creation_input_tokens: null },
};

describe("Anthropic transport", () => {
  it("builds the Messages API call from the neutral request", async () => {
    let params: Record<string, unknown> = {};
    let options: Record<string, unknown> = {};
    const transport = createAnthropicTransport({
      messages: {
        async create(p, o) {
          params = p as unknown as Record<string, unknown>;
          options = (o ?? {}) as Record<string, unknown>;
          return body;
        },
      },
    });
    await transport.send(request);
    expect(params).toEqual({
      model: "claude-haiku-5-5",
      max_tokens: 1000,
      system: "sys",
      messages: [{ role: "user", content: "hello" }],
      output_config: { effort: "low" },
      tools: [{ name: "answer", description: "d", input_schema: { type: "object", properties: { a: { type: "string" } } } }],
      tool_choice: { type: "auto" },
    });
    expect(options.maxRetries).toBe(0); // the gateway owns retries
    expect(params).not.toHaveProperty("temperature");
    expect(params).not.toHaveProperty("thinking");
  });

  it("forces the tool only when asked", async () => {
    let params: { tool_choice?: unknown } = {};
    const transport = createAnthropicTransport({ messages: { create: async (p) => ((params = p as never), body) } });
    await transport.send({ ...request, tool: { ...request.tool!, forced: true } });
    expect(params.tool_choice).toEqual({ type: "tool", name: "answer" });
  });

  it("omits tools and effort when not used", async () => {
    let params: Record<string, unknown> = {};
    const transport = createAnthropicTransport({ messages: { create: async (p) => ((params = p as never), body) } });
    await transport.send({ model: "m", system: "s", user: "u", maxTokens: 5 });
    expect(Object.keys(params).sort()).toEqual(["max_tokens", "messages", "model", "system"]);
  });

  it("parses text, the matching tool_use, stop reason and usage including cache tokens", async () => {
    const transport = createAnthropicTransport({ messages: { create: async () => body } });
    expect(await transport.send(request)).toEqual({
      text: "Calling the tool.",
      toolInput: { a: "x" },
      stopReason: "tool_use",
      refusalCategory: null,
      model: "claude-haiku-5-5",
      usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 5, cacheWriteTokens: 0 },
    });
  });

  it("surfaces the refusal category", async () => {
    const transport = createAnthropicTransport({
      messages: {
        create: async () => ({ ...body, content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber" } }),
      },
    });
    expect((await transport.send(request)).refusalCategory).toBe("cyber");
  });

  describe("error mapping", () => {
    const failWith = (error: unknown) =>
      createAnthropicTransport({ messages: { create: async () => Promise.reject(error) } }).send(request);

    it("marks 429 retryable and reads Retry-After seconds", async () => {
      const error = new Anthropic.APIError(429, { type: "error" }, "rate limited", new Headers({ "retry-after": "3" }));
      const failure = await failWith(error).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(TransportError);
      expect(failure).toMatchObject({ status: 429, retryable: true, retryAfterMs: 3000 });
    });

    it.each([500, 502, 503, 529])("marks %i retryable", async (status) => {
      const failure = await failWith(new Anthropic.APIError(status, {}, "server", new Headers())).catch((e: unknown) => e);
      expect(failure).toMatchObject({ status, retryable: true });
    });

    it.each([400, 401, 403, 404, 422])("marks %i not retryable", async (status) => {
      const failure = await failWith(new Anthropic.APIError(status, {}, "client", new Headers())).catch((e: unknown) => e);
      expect(failure).toMatchObject({ status, retryable: false });
    });

    it("treats connection errors and plain errors as retryable", async () => {
      expect(await failWith(new Anthropic.APIConnectionError({ message: "reset" })).catch((e: unknown) => e)).toMatchObject({
        retryable: true,
      });
      expect(await failWith(new TypeError("fetch failed")).catch((e: unknown) => e)).toMatchObject({ retryable: true });
    });

    it("does not retry an SDK error that is not an HTTP failure (for example no credentials)", async () => {
      const failure = await failWith(new Anthropic.AnthropicError("Could not resolve authentication method")).catch((e: unknown) => e);
      expect(failure).toMatchObject({ retryable: false });
    });
  });
});
