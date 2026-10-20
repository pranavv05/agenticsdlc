import type { ChunkRecord } from "../types";
import { Bm25, addTerms } from "./bm25";
import { terms } from "./text";

/** How much a chunk's score is raised, at most, when its module's CLAUDE.md matches the task well. */
export const MODULE_BOOST = 0.5;
const PATH_WEIGHT = 3;
const SYMBOL_WEIGHT = 4;
const CODE_WEIGHT = 1;

export interface LexicalHit {
  chunk: ChunkRecord;
  score: number;
}

export interface ModuleHit {
  dir: string;
  /** 0 to 1, relative to the best-matching module. */
  relevance: number;
}

/**
 * The "agentic grep" retrieval mode, without embeddings: BM25 over the repo's chunks (file path and symbol name count more
 * than the body), with a boost for chunks that live in a module whose generated CLAUDE.md matches the task. So the module
 * docs steer the search toward the right part of the repo first, then the code search ranks within it.
 */
export class LexicalIndex {
  private readonly chunks: Bm25<ChunkRecord>;
  private readonly modules: Bm25<string> | null;
  private readonly moduleDirs: string[];

  /** `moduleDocs` maps a module directory (repo-relative, no trailing slash) to the text of its generated CLAUDE.md. */
  constructor(chunks: ChunkRecord[], moduleDocs: Map<string, string> = new Map()) {
    this.chunks = new Bm25(
      chunks.map((chunk) => {
        const termWeights = new Map<string, number>();
        addTerms(termWeights, terms(chunk.filePath), PATH_WEIGHT);
        if (chunk.symbolName) addTerms(termWeights, terms(chunk.symbolName), SYMBOL_WEIGHT);
        addTerms(termWeights, terms(chunk.code), CODE_WEIGHT);
        return { item: chunk, termWeights };
      }),
    );
    this.moduleDirs = [...moduleDocs.keys()].sort((a, b) => b.length - a.length); // deepest first
    this.modules = moduleDocs.size
      ? new Bm25(
          [...moduleDocs].map(([dir, text]) => {
            const termWeights = new Map<string, number>();
            addTerms(termWeights, terms(dir), PATH_WEIGHT);
            addTerms(termWeights, terms(text), CODE_WEIGHT);
            return { item: dir, termWeights };
          }),
        )
      : null;
  }

  get size(): number {
    return this.chunks.size;
  }

  /** Modules whose documentation matches the task, best first. */
  relevantModules(task: string, limit = 3): ModuleHit[] {
    if (!this.modules) return [];
    const hits = this.modules.search(terms(task));
    const best = hits[0]?.score ?? 0;
    return hits.slice(0, limit).map((h) => ({ dir: h.item, relevance: best ? h.score / best : 0 }));
  }

  private moduleOf(filePath: string): string | null {
    return this.moduleDirs.find((d) => filePath.startsWith(d + "/")) ?? null;
  }

  search(task: string, limit: number): LexicalHit[] {
    const queryTerms = terms(task);
    if (!queryTerms.length) return [];
    const relevance = new Map(this.relevantModules(task, Infinity).map((m) => [m.dir, m.relevance]));
    return this.chunks
      .search(queryTerms)
      .map((h, order) => {
        const dir = this.moduleOf(h.item.filePath);
        const boost = dir ? 1 + MODULE_BOOST * (relevance.get(dir) ?? 0) : 1;
        return { chunk: h.item, score: h.score * boost, order };
      })
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .slice(0, limit)
      .map(({ chunk, score }) => ({ chunk, score }));
  }
}
