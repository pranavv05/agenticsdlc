import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { LlmConfigError, TransportError, createAnthropicTransport, createBedrockTransport, createGateway, type LlmRequest } from "../src";

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

describe("Bedrock transport", () => {
  const ok = (json: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" }, ...init });

  it("posts to the regional invoke endpoint with a bearer token and the Bedrock body", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const transport = createBedrockTransport({
      apiKey: "key-123",
      region: "us-east-1",
      fetch: async (url, init) => {
        seen = { url: String(url), init: init! };
        return ok(body);
      },
    });
    const response = await transport.send({ ...request, model: "us.anthropic.claude-haiku-5-5-v1:0" });

    expect(seen!.url).toBe("https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-haiku-5-5-v1%3A0/invoke");
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe("Bearer key-123");
    expect(JSON.parse(seen!.init.body as string)).toMatchObject({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 1000,
      system: "sys",
      tool_choice: { type: "auto" },
      output_config: { effort: "low" },
    });
    expect(response.toolInput).toEqual({ a: "x" });
    expect(response.usage.inputTokens).toBe(120);
  });

  it("maps HTTP failures to retryable or fatal transport errors with Retry-After", async () => {
    const make = (status: number, headers: Record<string, string> = {}) =>
      createBedrockTransport({ apiKey: "k", region: "r", fetch: async () => new Response("nope", { status, headers }) });
    expect(
      await make(429, { "retry-after": "2" })
        .send(request)
        .catch((e: unknown) => e),
    ).toMatchObject({ status: 429, retryable: true, retryAfterMs: 2000 });
    expect(
      await make(503)
        .send(request)
        .catch((e: unknown) => e),
    ).toMatchObject({ status: 503, retryable: true });
    expect(
      await make(403)
        .send(request)
        .catch((e: unknown) => e),
    ).toMatchObject({ status: 403, retryable: false });
  });

  it("treats a network failure as retryable", async () => {
    const transport = createBedrockTransport({
      apiKey: "k",
      region: "r",
      fetch: async () => Promise.reject(new TypeError("fetch failed")),
    });
    expect(await transport.send(request).catch((e: unknown) => e)).toMatchObject({ retryable: true, status: undefined });
  });

  it("refuses to start without a key or region", () => {
    expect(() => createBedrockTransport({ apiKey: "", region: "us-east-1" })).toThrow(LlmConfigError);
    expect(() => createBedrockTransport({ apiKey: "k", region: "" })).toThrow(LlmConfigError);
  });

  it("is selected by LLM_PROVIDER=bedrock and reports a missing key as a config error without retrying", async () => {
    const sleeps: number[] = [];
    const gateway = createGateway({
      mode: "live",
      env: { LLM_PROVIDER: "bedrock", LLM_MODEL: "us.anthropic.claude-haiku-5-5-v1:0" },
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(gateway.provider).toBe("bedrock");
    await expect(gateway.generateText({ agent: "context", system: "s", input: "i" })).rejects.toThrow(/BEDROCK_API_KEY/);
    expect(sleeps).toEqual([]);
  });
});
