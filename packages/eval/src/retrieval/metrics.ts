import type { ContextBundle } from "@sdd/contracts";

/**
 * The files of a context bundle in the order a reader meets them, each once: primary hits (similarity or keyword matches)
 * first, in rank order, then dependency neighbours. This is the ranking the metrics below score.
 */
export function rankedFiles(bundle: Pick<ContextBundle, "chunks">): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const chunk of bundle.chunks) {
    if (!seen.has(chunk.filePath)) {
      seen.add(chunk.filePath);
      files.push(chunk.filePath);
    }
  }
  return files;
}

const topK = (ranked: readonly string[], k: number) => ranked.slice(0, k);
const hits = (ranked: readonly string[], expected: readonly string[], k: number) => {
  const wanted = new Set(expected);
  return topK(ranked, k).filter((f) => wanted.has(f)).length;
};

function assertScorable(expected: readonly string[], k: number): void {
  if (expected.length === 0) throw new RangeError("A case needs at least one expected file");
  if (!Number.isInteger(k) || k < 1) throw new RangeError(`k must be a positive integer, got ${k}`);
}

/** Share of the expected files found in the first k files. 1 means every file a developer needs is in the bundle's first k. */
export function recallAtK(ranked: readonly string[], expected: readonly string[], k: number): number {
  assertScorable(expected, k);
  return hits(ranked, expected, k) / new Set(expected).size;
}

/**
 * Share of the first k returned files that are expected. When fewer than k files were returned the denominator is the
 * number returned, so a mode that returns a short, accurate list is not punished for being selective (see `returned`).
 */
export function precisionAtK(ranked: readonly string[], expected: readonly string[], k: number): number {
  assertScorable(expected, k);
  const considered = Math.min(k, ranked.length);
  return considered === 0 ? 0 : hits(ranked, expected, k) / considered;
}

/** 1 when at least one expected file is in the first k files, else 0. */
export function hitAtK(ranked: readonly string[], expected: readonly string[], k: number): 0 | 1 {
  assertScorable(expected, k);
  return hits(ranked, expected, k) > 0 ? 1 : 0;
}

/** 1 / (position of the first expected file), or 0 if none was returned. */
export function reciprocalRank(ranked: readonly string[], expected: readonly string[]): number {
  assertScorable(expected, 1);
  const wanted = new Set(expected);
  const index = ranked.findIndex((f) => wanted.has(f));
  return index === -1 ? 0 : 1 / (index + 1);
}

export const mean = (values: readonly number[]): number => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
