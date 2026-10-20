import type { ChunkRecord } from "./types";
import { log } from "./log";

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const MODEL = "voyage-code-3";
const DIMENSIONS = 1024;
const BATCH_SIZE = 32; // keeps each request well under Voyage's per-request token cap
const MAX_INPUT_CHARS = 6_000;
const MAX_RETRIES = 6;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function embedBatch(inputs: string[], inputType: "document" | "query"): Promise<number[][]> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error("VOYAGE_API_KEY is not set");

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(VOYAGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        input: inputs.map((s) => s.slice(0, MAX_INPUT_CHARS)),
        model: MODEL,
        input_type: inputType,
        output_dimension: DIMENSIONS,
      }),
    });
    if (res.ok) {
      const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
      return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_RETRIES) {
      throw new Error(`Voyage embeddings failed: ${res.status} ${await res.text()}`);
    }
    const wait = Math.min(30_000, 1_000 * 2 ** attempt);
    log("voyage", "embeddings", `HTTP ${res.status}, retrying in ${wait}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
    await sleep(wait);
  }
}

/** Embed arbitrary texts in batches. Used for queries (inputType "query") and documents. */
export async function embedTexts(texts: string[], inputType: "document" | "query" = "document"): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    out.push(...(await embedBatch(texts.slice(i, i + BATCH_SIZE), inputType)));
  }
  return out;
}

/** Batch-embed chunks with voyage-code-3; returns chunks with `embedding` attached. */
export async function embedChunks(
  chunks: ChunkRecord[],
  onBatch?: (done: number, total: number) => void,
): Promise<ChunkRecord[]> {
  const result: ChunkRecord[] = [];
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const vectors = await embedBatch(
      batch.map((c) => `${c.filePath}${c.symbolName ? ` :: ${c.symbolName}` : ""}\n${c.code}`),
      "document",
    );
    batch.forEach((c, j) => result.push({ ...c, embedding: vectors[j] }));
    onBatch?.(result.length, chunks.length);
  }
  return result;
}
