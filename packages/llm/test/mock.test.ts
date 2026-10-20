import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FixtureStore,
  LlmMockFixtureMissingError,
  LlmValidationError,
  createGateway,
  fixtureKey,
  setGateway,
  generateStructured,
  generateText,
  toAgentRun,
  type UsageRecord,
} from "../src";
import { Answer, baseRequest, harness, reply } from "./helpers";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-llm-fixtures-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  setGateway(undefined);
});

function mockGateway(extra: Parameters<typeof createGateway>[0] = {}) {
  const usage: UsageRecord[] = [];
  const fixtures = new FixtureStore({ dir });
  const gateway = createGateway({ mode: "mock", env: {}, fixtures, onUsage: (r) => void usage.push(r), ...extra });
  return { gateway, fixtures, usage };
}

describe("fixtureKey", () => {
  it("is stable and depends on agent, name and input", () => {
    const key = fixtureKey("requirement", "answer", "hello");
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(fixtureKey("requirement", "answer", "hello")).toBe(key);
    expect(fixtureKey("design", "answer", "hello")).not.toBe(key);
    expect(fixtureKey("requirement", "other", "hello")).not.toBe(key);
    expect(fixtureKey("requirement", "answer", "hello!")).not.toBe(key);
  });

  it("cannot be confused by moving text between fields", () => {
    expect(fixtureKey("a", "bc", "d")).not.toBe(fixtureKey("ab", "c", "d"));
  });
});

describe("mock mode: structured", () => {
  it("returns a stored fixture, validated, with deterministic usage and a computed cost", async () => {
    const { gateway, fixtures, usage } = mockGateway();
    fixtures.put("requirement", "answer", baseRequest.input, { data: { title: "From fixture", count: 7 } });
    const first = await gateway.generateStructured(baseRequest);
    const second = await gateway.generateStructured(baseRequest);

    expect(first.data).toEqual({ title: "From fixture", count: 7 });
    expect(second.usage).toEqual(first.usage);
    expect(first.usage.latencyMs).toBe(0);
    expect(first.usage.costUsd).toBeGreaterThan(0);
    expect(usage.map((u) => [u.status, u.mocked])).toEqual([
      ["succeeded", true],
      ["succeeded", true],
    ]);
  });

  it("uses recorded token counts when the fixture has them", async () => {
    const { gateway, fixtures } = mockGateway();
    fixtures.put("requirement", "answer", baseRequest.input, {
      data: { title: "abc", count: 1 },
      usage: { inputTokens: 5000, outputTokens: 1000 },
    });
    const { usage } = await gateway.generateStructured(baseRequest);
    expect(usage).toMatchObject({ inputTokens: 5000, outputTokens: 1000, costUsd: 0.001 }); // haiku-5-5
  });

  it("never touches the network or builds a real transport", async () => {
    const { gateway, fixtures } = mockGateway({ env: { ANTHROPIC_API_KEY: "", LLM_MODE: "mock" } });
    fixtures.put("requirement", "answer", baseRequest.input, { data: { title: "abc", count: 1 } });
    await expect(gateway.generateStructured(baseRequest)).resolves.toBeDefined();
  });

  it("reads recorded fixture files from the fixtures directory", async () => {
    const { gateway, fixtures } = mockGateway();
    const file = fixtures.record("requirement", "answer", baseRequest.input, { data: { title: "On disk", count: 2 } }, "claude-sonnet-5-5");
    expect(file.startsWith(dir)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(saved).toMatchObject({
      agent: "requirement",
      name: "answer",
      key: fixtureKey("requirement", "answer", baseRequest.input),
      recordedWith: "claude-sonnet-5-5",
    });
    expect((await gateway.generateStructured(baseRequest)).data).toEqual({ title: "On disk", count: 2 });
  });

  it("answers from a responder when no fixture matches, and fixtures win over responders", async () => {
    const { gateway, fixtures } = mockGateway();
    fixtures.respond("requirement", "answer", (input) => ({ title: `echo ${input.length}`, count: input.length }));
    expect((await gateway.generateStructured(baseRequest)).data).toEqual({
      title: `echo ${baseRequest.input.length}`,
      count: baseRequest.input.length,
    });
    fixtures.put("requirement", "answer", baseRequest.input, { data: { title: "exact", count: 0 } });
    expect((await gateway.generateStructured(baseRequest)).data.title).toBe("exact");
  });

  it("a responder can decline by returning undefined", async () => {
    const { gateway, fixtures } = mockGateway();
    fixtures.respond("requirement", "answer", () => undefined);
    await expect(gateway.generateStructured(baseRequest)).rejects.toThrow(LlmMockFixtureMissingError);
  });

  it("fails loudly, with the key and the fix, when there is no fixture", async () => {
    const { gateway, usage } = mockGateway();
    const error = await gateway.generateStructured(baseRequest).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmMockFixtureMissingError);
    expect((error as LlmMockFixtureMissingError).key).toBe(fixtureKey("requirement", "answer", baseRequest.input));
    expect((error as Error).message).toContain("LLM_MODE=record");
    expect(usage[0]).toMatchObject({ status: "failed", mocked: true });
  });

  it("rejects a fixture that no longer matches the schema, so fixtures cannot rot silently", async () => {
    const { gateway, fixtures } = mockGateway();
    fixtures.put("requirement", "answer", baseRequest.input, { data: { title: "ok", count: "not a number" } });
    await expect(gateway.generateStructured(baseRequest)).rejects.toThrow(LlmValidationError);
  });

  it("still applies request validation", async () => {
    const { gateway } = mockGateway({ maxInputChars: 10 });
    await expect(gateway.generateStructured({ ...baseRequest, input: "x".repeat(50) })).rejects.toThrow(/over the limit/);
  });
});

describe("mock mode: text", () => {
  it("returns a stored text fixture", async () => {
    const { gateway, fixtures } = mockGateway();
    fixtures.put("context", "module-doc", "describe auth", { data: "# Auth module" });
    const result = await gateway.generateText({ agent: "context", name: "module-doc", system: "s", input: "describe auth" });
    expect(result).toMatchObject({ text: "# Auth module", truncated: false });
  });

  it("returns a clearly marked deterministic placeholder for an unknown prompt", async () => {
    const { gateway } = mockGateway();
    const request = { agent: "context" as const, system: "s", input: "something new" };
    const a = await gateway.generateText(request);
    const b = await gateway.generateText(request);
    expect(a.text).toBe(b.text);
    expect(a.text).toMatch(/^\[mock\] context\/text [0-9a-f]{16}$/);
  });
});

describe("record mode", () => {
  it("calls the model, saves a fixture, and mock mode then replays it", async () => {
    const live = harness([reply({ toolInput: { title: "Recorded", count: 9 } })], { mode: "record", fixtures: new FixtureStore({ dir }) });
    const recorded = await live.gateway.generateStructured(baseRequest);
    expect(live.transport.calls).toHaveLength(1);

    const replay = mockGateway();
    const replayed = await replay.gateway.generateStructured(baseRequest);
    expect(replayed.data).toEqual(recorded.data);
    expect(replayed.usage).toMatchObject({ inputTokens: 1000, outputTokens: 200 });
  });

  it("records text too", async () => {
    const live = harness([reply({ text: "Generated doc", stopReason: "end_turn" })], {
      mode: "record",
      fixtures: new FixtureStore({ dir }),
    });
    await live.gateway.generateText({ agent: "context", name: "doc", system: "s", input: "i" });
    const replay = mockGateway();
    expect((await replay.gateway.generateText({ agent: "context", name: "doc", system: "s", input: "i" })).text).toBe("Generated doc");
  });
});

describe("configuration from the environment", () => {
  it("reads LLM_MODE", () => {
    expect(createGateway({ env: { LLM_MODE: "mock" } }).mode).toBe("mock");
    expect(createGateway({ env: {} }).mode).toBe("live");
    expect(() => createGateway({ env: { LLM_MODE: "fake" } })).toThrow(/LLM_MODE/);
  });

  it("the default gateway functions delegate to the installed gateway", async () => {
    const { gateway, fixtures } = mockGateway();
    fixtures.put("requirement", "answer", baseRequest.input, { data: { title: "global", count: 1 } });
    fixtures.put("context", "text", "hi", { data: "hello" });
    setGateway(gateway);
    expect((await generateStructured(baseRequest)).data.title).toBe("global");
    expect((await generateText({ agent: "context", system: "s", input: "hi" })).text).toBe("hello");
  });
});

describe("toAgentRun", () => {
  it("turns a usage record into a valid AgentRun", async () => {
    const { gateway, usage } = mockGateway({ fixtures: new FixtureStore({ dir }) });
    gateway.fixtures.put("requirement", "answer", baseRequest.input, { data: { title: "abc", count: 1 } });
    await gateway.generateStructured({ ...baseRequest, initiativeId: "3f2b8c1e-5a7d-4e29-9c4b-1d6e8f0a2b34" });
    const run = toAgentRun(usage[0], { id: "a1c4e7b2-8d3f-4a56-b2c9-5e0f1a7d3c68", createdAt: "2026-10-21T09:30:00.000Z" });
    expect(run).toMatchObject({
      agent: "requirement",
      status: "succeeded",
      initiativeId: "3f2b8c1e-5a7d-4e29-9c4b-1d6e8f0a2b34",
      model: usage[0].model,
    });
    expect(Answer.safeParse({ title: "abc", count: 1 }).success).toBe(true);
  });
});
