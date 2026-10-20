import Anthropic from "@anthropic-ai/sdk";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LlmApiError, createAnthropicTransport, createGateway } from "../src";
import { Answer } from "./helpers";

/**
 * The real @anthropic-ai/sdk talking to a local HTTP server that plays the Messages API.
 * No network and no key: this checks the request the SDK actually sends and how SDK errors map to retry decisions.
 */
interface Seen {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

let server: http.Server;
let baseURL: string;
let seen: Seen[] = [];
let script: ((call: number) => { status: number; body: unknown; headers?: Record<string, string> })[] = [];

const messageBody = (input: unknown) => ({
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-haiku-5-5",
  content: [{ type: "tool_use", id: "toolu_1", name: "answer", input }],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: { input_tokens: 800, output_tokens: 100, cache_creation_input_tokens: null, cache_read_input_tokens: null },
});

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString() || "{}") });
      const step = script[Math.min(seen.length - 1, script.length - 1)](seen.length);
      res.writeHead(step.status, { "content-type": "application/json", ...step.headers });
      res.end(JSON.stringify(step.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  seen = [];
});

function gatewayAgainstServer(extra: Parameters<typeof createGateway>[0] = {}) {
  const sleeps: number[] = [];
  const client = new Anthropic({ apiKey: "test-key", baseURL, maxRetries: 0 });
  const gateway = createGateway({
    mode: "live",
    env: {},
    transport: createAnthropicTransport(client as never),
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0,
    ...extra,
  });
  return { gateway, sleeps };
}

const request = {
  agent: "requirement" as const,
  name: "answer",
  schema: Answer,
  system: "You are a test agent.",
  input: "Produce an answer.",
};

describe("real SDK against a local Messages API", () => {
  it("sends the expected request and returns the validated tool input", async () => {
    script = [() => ({ status: 200, body: messageBody({ title: "Hello", count: 3 }) })];
    const { gateway } = gatewayAgainstServer();
    const result = await gateway.generateStructured({ ...request, effort: "low" });

    expect(result.data).toEqual({ title: "Hello", count: 3 });
    expect(result.usage).toMatchObject({ inputTokens: 800, outputTokens: 100, model: "claude-haiku-5-5", costUsd: 0.00013 });

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("/v1/messages");
    expect(seen[0].headers["x-api-key"]).toBe("test-key");
    const body = seen[0].body as {
      model: string;
      max_tokens: number;
      system: string;
      messages: unknown;
      tools: { name: string; input_schema: Record<string, unknown> }[];
      tool_choice: unknown;
      output_config: unknown;
    };
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.max_tokens).toBe(8192);
    expect(body.system).toContain('calling the "answer" tool exactly once');
    expect(body.messages).toEqual([{ role: "user", content: "Produce an answer." }]);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].name).toBe("answer");
    expect(body.tools[0].input_schema.type).toBe("object");
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(body.output_config).toEqual({ effort: "low" });
    for (const forbidden of ["temperature", "top_p", "top_k", "thinking"]) expect(body).not.toHaveProperty(forbidden);
  });

  it("forces the tool on a model that still allows forced tool use", async () => {
    script = [() => ({ status: 200, body: messageBody({ title: "Hello", count: 3 }) })];
    const { gateway } = gatewayAgainstServer();
    await gateway.generateStructured({ ...request, model: "claude-sonnet-4-6" });
    expect(seen[0].body.tool_choice).toEqual({ type: "tool", name: "answer" });
  });

  it("retries a 429, honouring Retry-After, and the SDK does not retry underneath", async () => {
    script = [
      () => ({
        status: 429,
        body: { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
        headers: { "retry-after": "7" },
      }),
      () => ({ status: 200, body: messageBody({ title: "Hello", count: 1 }) }),
    ];
    const { gateway, sleeps } = gatewayAgainstServer();
    await expect(gateway.generateStructured(request)).resolves.toMatchObject({ data: { count: 1 } });
    expect(seen).toHaveLength(2); // exactly one request per gateway attempt: the SDK's own retries are off
    expect(sleeps).toEqual([7000]);
  });

  it("does not retry a 400", async () => {
    script = [() => ({ status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "bad" } } })];
    const { gateway, sleeps } = gatewayAgainstServer();
    const error = await gateway.generateStructured(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmApiError);
    expect((error as LlmApiError).status).toBe(400);
    expect(seen).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("retries 529 overloaded errors until it gives up", async () => {
    script = [() => ({ status: 529, body: { type: "error", error: { type: "overloaded_error", message: "busy" } } })];
    const { gateway } = gatewayAgainstServer({ maxRetries: 2 });
    const error = await gateway.generateStructured(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmApiError);
    expect((error as LlmApiError).attempts).toBe(3);
    expect(seen).toHaveLength(3);
  });

  it("reads a refusal and its category from the real response shape", async () => {
    script = [
      () => ({
        status: 200,
        body: {
          ...messageBody({}),
          content: [],
          stop_reason: "refusal",
          stop_details: { type: "refusal", category: "cyber", explanation: null },
        },
      }),
    ];
    const { gateway } = gatewayAgainstServer();
    await expect(gateway.generateStructured(request)).rejects.toMatchObject({ name: "LlmRefusalError", category: "cyber" });
  });

  it("treats a refused connection as a retryable network error", async () => {
    const closed = new Anthropic({ apiKey: "k", baseURL: "http://127.0.0.1:9", maxRetries: 0 });
    const sleeps: number[] = [];
    const gateway = createGateway({
      mode: "live",
      env: {},
      transport: createAnthropicTransport(closed as never),
      maxRetries: 1,
      sleep: async (ms) => void sleeps.push(ms),
      random: () => 0,
    });
    const error = await gateway.generateText({ agent: "context", system: "s", input: "i" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmApiError);
    expect((error as LlmApiError).attempts).toBe(2);
    expect(sleeps).toHaveLength(1);
  });
});
