import { embedTexts as gatewayEmbedTexts } from "@sdd/llm";
import type { ChunkRecord } from "./types";

const BATCH_SIZE = 32; // matches the gateway's request batch, so progress callbacks line up with real requests

/**
 * Embed arbitrary texts. Used for queries (inputType "query") and documents.
 * Goes through the @sdd/llm embeddings client: Voyage, or deterministic offline vectors when LLM_MODE=mock.
 */
export async function embedTexts(texts: string[], inputType: "document" | "query" = "document"): Promise<number[][]> {
  return gatewayEmbedTexts(texts, inputType);
}

/** Batch-embed chunks with voyage-code-3; returns chunks with `embedding` attached. */
export async function embedChunks(chunks: ChunkRecord[], onBatch?: (done: number, total: number) => void): Promise<ChunkRecord[]> {
  const result: ChunkRecord[] = [];
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const vectors = await embedTexts(
      batch.map((c) => `${c.filePath}${c.symbolName ? ` :: ${c.symbolName}` : ""}\n${c.code}`),
      "document",
    );
    batch.forEach((c, j) => result.push({ ...c, embedding: vectors[j] }));
    onBatch?.(result.length, chunks.length);
  }
  return result;
}
