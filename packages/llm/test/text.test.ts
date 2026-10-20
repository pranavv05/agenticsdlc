import { describe, expect, it } from "vitest";
import { LlmApiError, LlmError, LlmRefusalError, TransportError } from "../src";
import { harness, reply } from "./helpers";

const request = { agent: "context" as const, name: "module-doc", system: "Write docs.", input: "Describe the auth module." };

describe("generateText", () => {
  it("returns the text with usage and writes a usage record", async () => {
    const h = harness([reply({ text: "# Auth\nDoes login.", stopReason: "end_turn" })]);
    const result = await h.gateway.generateText(request);
    expect(result).toMatchObject({ text: "# Auth\nDoes login.", truncated: false });
    expect(result.usage.costUsd).toBe(0.0002);
    expect(h.usage).toMatchObject([{ agent: "context", name: "module-doc", status: "succeeded", mocked: false }]);
    expect(h.transport.calls[0].tool).toBeUndefined();
  });

  it("defaults the call name to text", async () => {
    const h = harness([reply({ text: "ok", stopReason: "end_turn" })]);
    await h.gateway.generateText({ agent: "context", system: "s", input: "i" });
    expect(h.usage[0].name).toBe("text");
  });

  it("flags truncated output instead of hiding it", async () => {
    const h = harness([reply({ text: "# Auth\nDoes lo", stopReason: "max_tokens" })]);
    expect(await h.gateway.generateText(request)).toMatchObject({ text: "# Auth\nDoes lo", truncated: true });
  });

  it("retries rate limits with backoff", async () => {
    const h = harness([new TransportError("slow", 429, true), reply({ text: "ok", stopReason: "end_turn" })]);
    await h.gateway.generateText(request);
    expect(h.sleeps).toEqual([750]);
  });

  it("throws on a refusal", async () => {
    const h = harness([reply({ stopReason: "refusal", refusalCategory: "bio" })]);
    await expect(h.gateway.generateText(request)).rejects.toThrow(LlmRefusalError);
  });

  it("throws when the model returns no text at all", async () => {
    const h = harness([reply({ text: "", stopReason: "end_turn" })]);
    await expect(h.gateway.generateText(request)).rejects.toThrow(LlmError);
    expect(h.usage[0].status).toBe("failed");
  });

  it("records a failed row and rethrows when the API gives up", async () => {
    const h = harness([new TransportError("down", 503, true)], { maxRetries: 1 });
    await expect(h.gateway.generateText(request)).rejects.toThrow(LlmApiError);
    expect(h.usage).toHaveLength(1);
    expect(h.usage[0].status).toBe("failed");
  });
});
