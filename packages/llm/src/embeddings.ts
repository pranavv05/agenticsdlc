import { createHash } from "node:crypto";
import { LlmApiError, LlmConfigError, LlmInputError, TransportError, isRetryableStatus, parseRetryAfter } from "./errors";
import type { LlmMode, UsageHook } from "./gateway";
import { computeEmbeddingCostUsd } from "./prices";
import { backoffDelay } from "./retry";

export const EMBEDDING_MODEL = "voyage-code-3";
export const EMBEDDING_DIMENSIONS = 1024;
const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";

export type EmbedInputType = "document" | "query";

export interface EmbedResult {
  vectors: number[][];
  usage: { tokens: number; costUsd: number; model: string };
}

export interface Embedder {
  readonly mode: LlmMode;
  embed(texts: string[], inputType?: EmbedInputType): Promise<EmbedResult>;
}

export interface EmbedderOptions {
  /** "mock" returns deterministic offline vectors; "live" and "record" call Voyage. Default: LLM_MODE or "live". */
  mode?: LlmMode;
  apiKey?: string;
  fetch?: typeof fetch;
  onUsage?: UsageHook;
  /** Texts per request. Keeps each request under Voyage's per-request token cap. Default 32. */
  batchSize?: number;
  /** Each text is cut to this many characters before sending, as in the prototype. Default 6,000. */
  maxInputChars?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  clock?: () => number;
}

// ---- offline mock ----

/** Splits identifiers and prose into lowercase word pieces: "InvoiceService.createInvoice" -> invoice, service, create, invoice. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

/**
 * Deterministic stand-in for a real embedding: feature hashing of word pieces into 1,024 signed buckets, L2-normalised.
 * Texts that share words get a higher cosine similarity, so retrieval tests offline rank sensibly. It is not a semantic model.
 */
export function mockEmbedding(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  const counts = new Map<string, number>();
  for (const token of tokenize(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
  for (const [token, count] of counts) {
    const digest = createHash("sha256").update(token).digest();
    const bucket = digest.readUInt32BE(0) % EMBEDDING_DIMENSIONS;
    const sign = (digest[4] & 1) === 0 ? 1 : -1;
    vector[bucket] += sign * (1 + Math.log(count));
  }
  const norm = Math.sqrt(vector.reduce((acc, v) => acc + v * v, 0));
  if (norm === 0) {
    vector[0] = 1; // never return a zero vector: cosine distance on it is undefined
    return vector;
  }
  return vector.map((v) => v / norm);
}

const estimateTokens = (texts: string[]) => Math.ceil(texts.reduce((acc, t) => acc + t.length, 0) / 4);

// ---- Voyage ----

export function createEmbedder(options: EmbedderOptions = {}): Embedder {
  const env = options.env ?? process.env;
  const rawMode = options.mode ?? env.LLM_MODE ?? "live";
  if (rawMode !== "live" && rawMode !== "mock" && rawMode !== "record")
    throw new LlmConfigError(`LLM_MODE must be "live", "mock" or "record", got "${rawMode}"`);
  const mode: LlmMode = rawMode;
  const batchSize = options.batchSize ?? 32;
  const maxInputChars = options.maxInputChars ?? 6_000;
  const maxRetries = options.maxRetries ?? 6;
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const clock = options.clock ?? (() => performance.now());

  async function requestBatch(
    inputs: string[],
    inputType: EmbedInputType,
    apiKey: string,
  ): Promise<{ vectors: number[][]; tokens: number }> {
    for (let attempt = 1; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let res: Response;
        try {
          res = await doFetch(VOYAGE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
              input: inputs.map((s) => s.slice(0, maxInputChars)),
              model: EMBEDDING_MODEL,
              input_type: inputType,
              output_dimension: EMBEDDING_DIMENSIONS,
            }),
            signal: controller.signal,
          });
        } catch (error) {
          throw new TransportError(error instanceof Error ? error.message : String(error), undefined, true, undefined, { cause: error });
        }
        if (!res.ok) {
          const detail = (await res.text().catch(() => "")).slice(0, 500);
          throw new TransportError(
            `Voyage embeddings failed: ${res.status} ${detail}`,
            res.status,
            isRetryableStatus(res.status),
            parseRetryAfter(res.headers.get("retry-after")),
          );
        }
        const json = (await res.json()) as { data: { index: number; embedding: number[] }[]; usage?: { total_tokens?: number } };
        const vectors = json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
        if (vectors.length !== inputs.length)
          throw new LlmApiError(`Voyage returned ${vectors.length} vectors for ${inputs.length} inputs`, res.status, attempt);
        return { vectors, tokens: json.usage?.total_tokens ?? estimateTokens(inputs) };
      } catch (error) {
        if (!(error instanceof TransportError)) throw error;
        if (!error.retryable || attempt > maxRetries) {
          throw new LlmApiError(
            `Embedding request failed after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${error.message}`,
            error.status,
            attempt,
            { cause: error },
          );
        }
        await sleep(backoffDelay(attempt - 1, { baseDelayMs, maxDelayMs, random, retryAfterMs: error.retryAfterMs }));
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async function report(
    tokens: number,
    costUsd: number,
    latencyMs: number,
    status: "succeeded" | "failed",
    mocked: boolean,
    error?: string,
  ) {
    await options.onUsage?.({
      agent: "context",
      name: "embeddings",
      model: EMBEDDING_MODEL,
      inputTokens: tokens,
      outputTokens: 0,
      costUsd,
      latencyMs,
      status,
      ...(error ? { error: error.slice(0, 2_000) } : {}),
      mocked,
    });
  }

  return {
    mode,
    async embed(texts, inputType = "document") {
      if (!texts.length) return { vectors: [], usage: { tokens: 0, costUsd: 0, model: EMBEDDING_MODEL } };
      if (texts.some((t) => typeof t !== "string")) throw new LlmInputError("embed() takes an array of strings");

      if (mode === "mock") {
        const tokens = estimateTokens(texts);
        const costUsd = computeEmbeddingCostUsd(EMBEDDING_MODEL, tokens);
        await report(tokens, costUsd, 0, "succeeded", true);
        return { vectors: texts.map(mockEmbedding), usage: { tokens, costUsd, model: EMBEDDING_MODEL } };
      }

      const apiKey = options.apiKey ?? env.VOYAGE_API_KEY;
      if (!apiKey) throw new LlmConfigError("VOYAGE_API_KEY is not set");

      const started = clock();
      const vectors: number[][] = [];
      let tokens = 0;
      try {
        for (let i = 0; i < texts.length; i += batchSize) {
          const batch = await requestBatch(texts.slice(i, i + batchSize), inputType, apiKey);
          vectors.push(...batch.vectors);
          tokens += batch.tokens;
        }
      } catch (error) {
        await report(
          tokens,
          computeEmbeddingCostUsd(EMBEDDING_MODEL, tokens),
          Math.round(clock() - started),
          "failed",
          false,
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
      const costUsd = computeEmbeddingCostUsd(EMBEDDING_MODEL, tokens);
      await report(tokens, costUsd, Math.max(0, Math.round(clock() - started)), "succeeded", false);
      return { vectors, usage: { tokens, costUsd, model: EMBEDDING_MODEL } };
    },
  };
}

// ---- process-wide default ----

let currentEmbedder: Embedder | undefined;

export function getEmbedder(): Embedder {
  return (currentEmbedder ??= createEmbedder());
}

/** Replace the default embedder (the orchestrator installs one with its usage hook; tests install a mock). Pass undefined to reset. */
export function setEmbedder(embedder: Embedder | undefined): void {
  currentEmbedder = embedder;
}

/** Embeds texts with the default embedder and returns just the vectors. */
export async function embedTexts(texts: string[], inputType: EmbedInputType = "document"): Promise<number[][]> {
  return (await getEmbedder().embed(texts, inputType)).vectors;
}
