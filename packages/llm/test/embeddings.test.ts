import { describe, expect, it } from "vitest";
import {
  EMBEDDING_DIMENSIONS,
  LlmApiError,
  LlmConfigError,
  createEmbedder,
  embedTexts,
  mockEmbedding,
  setEmbedder,
  tokenize,
  type UsageRecord,
} from "../src";

const cosine = (a: number[], b: number[]) => a.reduce((acc, v, i) => acc + v * b[i], 0);
const norm = (v: number[]) => Math.sqrt(v.reduce((acc, x) => acc + x * x, 0));

describe("mock embeddings", () => {
  it("are deterministic, 1024-dimensional and unit length", () => {
    const a = mockEmbedding("InvoiceService.createInvoice");
    expect(a).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(mockEmbedding("InvoiceService.createInvoice")).toEqual(a);
    expect(norm(a)).toBeCloseTo(1, 10);
  });

  it("give higher similarity to texts that share words, so offline ranking is meaningful", () => {
    const query = mockEmbedding("export invoices as csv");
    const related = mockEmbedding("function exportInvoicesCsv(invoices) { return toCsv(invoices) }");
    const unrelated = mockEmbedding("class PasswordHasher { hash(password) { return bcrypt(password) } }");
    expect(cosine(query, related)).toBeGreaterThan(cosine(query, unrelated));
    expect(cosine(query, query)).toBeCloseTo(1, 10);
  });

  it("never returns a zero vector, even for text with no words", () => {
    for (const text of ["", "   ", "!!! ???", "a"]) {
      const v = mockEmbedding(text);
      expect(norm(v)).toBeCloseTo(1, 10);
      expect(v.every(Number.isFinite)).toBe(true);
    }
  });

  it("splits identifiers into words", () => {
    expect(tokenize("InvoiceService.createInvoice_v2")).toEqual(["invoice", "service", "create", "invoice", "v2"]);
  });
});

describe("embedder in mock mode", () => {
  it("embeds without a key or network, and reports a computed cost", async () => {
    const usage: UsageRecord[] = [];
    const embedder = createEmbedder({
      mode: "mock",
      env: {},
      onUsage: (r) => void usage.push(r),
      fetch: async () => Promise.reject(new Error("network used")),
    });
    const result = await embedder.embed(["alpha beta", "gamma"], "query");
    expect(result.vectors).toHaveLength(2);
    expect(result.usage.tokens).toBeGreaterThan(0);
    expect(result.usage.costUsd).toBeGreaterThanOrEqual(0);
    expect(usage).toMatchObject([
      { agent: "context", name: "embeddings", model: "voyage-code-3", mocked: true, status: "succeeded", outputTokens: 0 },
    ]);
  });

  it("returns nothing for no texts", async () => {
    const embedder = createEmbedder({ mode: "mock", env: {} });
    expect(await embedder.embed([])).toEqual({ vectors: [], usage: { tokens: 0, costUsd: 0, model: "voyage-code-3" } });
  });

  it("is what embedTexts uses once installed as the default", async () => {
    setEmbedder(createEmbedder({ mode: "mock", env: {} }));
    try {
      expect(await embedTexts(["one", "two"])).toEqual([mockEmbedding("one"), mockEmbedding("two")]);
    } finally {
      setEmbedder(undefined);
    }
  });

  it("is chosen by LLM_MODE=mock", () => {
    expect(createEmbedder({ env: { LLM_MODE: "mock" } }).mode).toBe("mock");
    expect(() => createEmbedder({ env: { LLM_MODE: "nope" } })).toThrow(LlmConfigError);
  });
});

describe("embedder against Voyage", () => {
  const voyage = (
    handler: (
      body: { input: string[]; model: string; input_type: string; output_dimension: number },
      call: number,
    ) => Response | Promise<Response>,
  ) => {
    const calls: { input: string[]; model: string; input_type: string; output_dimension: number; auth: string }[] = [];
    const fetchFn = (async (_url: unknown, init: RequestInit) => {
      const parsed = JSON.parse(init.body as string);
      calls.push({ ...parsed, auth: (init.headers as Record<string, string>).Authorization });
      return handler(parsed, calls.length);
    }) as typeof fetch;
    return { calls, fetchFn };
  };
  const okBody = (input: string[], tokens = input.length * 10) =>
    new Response(
      JSON.stringify({
        data: input.map((_, i) => ({ index: input.length - 1 - i, embedding: [input.length - 1 - i] })),
        usage: { total_tokens: tokens },
      }),
      { status: 200 },
    );

  const base = { mode: "live" as const, apiKey: "pa-test", env: {}, sleep: async () => {}, random: () => 0.5 };

  it("sends voyage-code-3 requests with the input type and dimension, and returns vectors in input order", async () => {
    const { calls, fetchFn } = voyage((body) => okBody(body.input));
    const embedder = createEmbedder({ ...base, fetch: fetchFn });
    const result = await embedder.embed(["a", "b", "c"], "query");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model: "voyage-code-3", input_type: "query", output_dimension: 1024, auth: "Bearer pa-test" });
    // the fake returns data out of order; the embedder sorts by index
    expect(result.vectors).toEqual([[0], [1], [2]]);
  });

  it("splits large inputs into batches of 32 and sums tokens and cost", async () => {
    const { calls, fetchFn } = voyage((body) => okBody(body.input, 1_000_000));
    const usage: UsageRecord[] = [];
    const embedder = createEmbedder({ ...base, fetch: fetchFn, onUsage: (r) => void usage.push(r) });
    const result = await embedder.embed(Array.from({ length: 70 }, (_, i) => `text ${i}`));
    expect(calls.map((c) => c.input.length)).toEqual([32, 32, 6]);
    expect(result.vectors).toHaveLength(70);
    expect(result.usage).toEqual({ tokens: 3_000_000, costUsd: 0.54, model: "voyage-code-3" });
    expect(usage).toHaveLength(1); // one usage record per embed() call, not per batch
    expect(usage[0]).toMatchObject({ inputTokens: 3_000_000, costUsd: 0.54, mocked: false, status: "succeeded" });
  });

  it("cuts each text to 6000 characters, as the prototype did", async () => {
    const { calls, fetchFn } = voyage((body) => okBody(body.input));
    await createEmbedder({ ...base, fetch: fetchFn }).embed(["x".repeat(10_000)]);
    expect(calls[0].input[0]).toHaveLength(6000);
  });

  it("retries 429 and 5xx with backoff, then succeeds", async () => {
    const sleeps: number[] = [];
    const { calls, fetchFn } = voyage((body, call) =>
      call === 1
        ? new Response("slow", { status: 429, headers: { "retry-after": "5" } })
        : call === 2
          ? new Response("oops", { status: 503 })
          : okBody(body.input),
    );
    const embedder = createEmbedder({ ...base, fetch: fetchFn, sleep: async (ms) => void sleeps.push(ms) });
    await embedder.embed(["a"]);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([5000, 1500]); // Retry-After wins over 750ms; second ceiling is 2000 -> 1500
  });

  it("does not retry a 401 and records a failed usage row", async () => {
    const { calls, fetchFn } = voyage(() => new Response("bad key", { status: 401 }));
    const usage: UsageRecord[] = [];
    const embedder = createEmbedder({ ...base, fetch: fetchFn, onUsage: (r) => void usage.push(r) });
    const error = await embedder.embed(["a"]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmApiError);
    expect((error as LlmApiError).status).toBe(401);
    expect(calls).toHaveLength(1);
    expect(usage).toMatchObject([{ status: "failed", mocked: false }]);
  });

  it("gives up after maxRetries", async () => {
    const { calls, fetchFn } = voyage(() => new Response("down", { status: 500 }));
    const embedder = createEmbedder({ ...base, fetch: fetchFn, maxRetries: 2 });
    await expect(embedder.embed(["a"])).rejects.toThrow(/after 3 attempts/);
    expect(calls).toHaveLength(3);
  });

  it("retries a network failure", async () => {
    let n = 0;
    const fetchFn = (async (_url: unknown, init: RequestInit) => {
      if (++n === 1) throw new TypeError("fetch failed");
      return okBody(JSON.parse(init.body as string).input);
    }) as typeof fetch;
    await expect(createEmbedder({ ...base, fetch: fetchFn }).embed(["a"])).resolves.toBeDefined();
    expect(n).toBe(2);
  });

  it("requires VOYAGE_API_KEY in live mode", async () => {
    await expect(createEmbedder({ mode: "live", env: {} }).embed(["a"])).rejects.toThrow(/VOYAGE_API_KEY/);
    await expect(
      createEmbedder({
        mode: "live",
        env: { VOYAGE_API_KEY: "k" },
        fetch: (async (_u: unknown, init: RequestInit) => okBody(JSON.parse(init.body as string).input)) as typeof fetch,
      }).embed(["a"]),
    ).resolves.toBeDefined();
  });

  it("rejects a response with the wrong number of vectors", async () => {
    const { fetchFn } = voyage(() => new Response(JSON.stringify({ data: [], usage: { total_tokens: 1 } }), { status: 200 }));
    await expect(createEmbedder({ ...base, fetch: fetchFn }).embed(["a"])).rejects.toThrow(/0 vectors for 1 inputs/);
  });
});
