import type { ClaudeMdSection, ContextBundle, ContextChunk } from "@sdd/contracts";
import { DocsOutput, defaultOutputRoot } from "./docsOutput";
import { embedTexts } from "./embed";
import type { ContextStore, StoredChunk } from "./store/types";
import { GENERATED_CLAUDE_MD } from "./walk";

const MAX_SECTION_CHARS = 3_500;
const MAX_MINDMAP_CHARS = 4_000;
const HOP_CHUNKS_PER_FILE = 3;

const toContextChunk = (c: StoredChunk, score: number | null, via: ContextChunk["via"]): ContextChunk => ({
  repoId: c.repoId,
  filePath: c.filePath,
  symbolName: c.symbolName,
  chunkType: c.chunkType,
  code: c.code,
  startLine: c.startLine,
  endLine: c.endLine,
  score,
  via,
});

async function findClaudeMdSections(chunks: ContextChunk[], docs: DocsOutput): Promise<ClaudeMdSection[]> {
  const seen = new Set<string>();
  const sections: ClaudeMdSection[] = [];
  for (const c of chunks) {
    // deepest module doc first, then ancestors, up to the repo root doc
    const parts = c.filePath.split("/").slice(0, -1);
    for (let i = parts.length; i >= 0; i--) {
      const dir = parts.slice(0, i).join("/");
      const rel = dir ? `${dir}/${GENERATED_CLAUDE_MD}` : GENERATED_CLAUDE_MD;
      const key = `${c.repoId}:${rel}`;
      if (seen.has(key)) continue;
      const content = await docs.read(c.repoId, rel, MAX_SECTION_CHARS);
      if (content) {
        seen.add(key);
        sections.push({ repoId: c.repoId, path: rel, content });
      }
    }
  }
  return sections;
}

async function findMindmapExcerpt(chunks: ContextChunk[], docs: DocsOutput): Promise<string> {
  const parts: string[] = [];
  const system = await docs.readMindmap(docs.systemBase(), MAX_MINDMAP_CHARS);
  if (system) parts.push(system);
  for (const repoId of new Set(chunks.map((c) => c.repoId))) {
    const text = await docs.readMindmap(docs.mindmapBase(repoId), MAX_MINDMAP_CHARS);
    if (text) parts.push(text);
  }
  return parts.join("\n\n---\n\n");
}

export interface QueryOptions {
  store: ContextStore;
  /** Where the generated docs were written. Default: CONTEXT_OUTPUT_DIR or ./output. */
  outputRoot?: string;
  /** Limit the search to these repos. Default: every repo in the store. */
  repoIds?: string[];
  topK?: number;
}

/**
 * Embed the task, cosine-search the stored chunks across repos, expand one hop through the import graph (files imported by the
 * hits), and attach the generated CLAUDE.md sections and mind maps. This is the "embeddings" retrieval path.
 */
export async function queryContext(task: string, opts: QueryOptions): Promise<ContextBundle> {
  const { store } = opts;
  const topK = opts.topK ?? 15;
  const docs = new DocsOutput(opts.outputRoot ?? defaultOutputRoot());
  const repoIds = opts.repoIds ?? (await store.listRepos()).map((r) => r.id);

  const [vector] = await embedTexts([task], "query");
  const hits = await store.searchSimilar({ repoIds, vector, limit: topK });
  const chunks: ContextChunk[] = hits.map((h) => toContextChunk(h, h.score, "similarity"));
  const have = new Set(hits.map((h) => `${h.repoId}:${h.id}`));

  for (const repoId of new Set(hits.map((h) => h.repoId))) {
    const files = [...new Set(hits.filter((h) => h.repoId === repoId).map((h) => h.filePath))];
    const { imports } = await store.getNeighbourFiles(repoId, files);
    if (!imports.length) continue;
    const perFile = new Map<string, number>();
    for (const c of await store.getChunks(repoId, { files: imports })) {
      const n = perFile.get(c.filePath) ?? 0;
      if (n >= HOP_CHUNKS_PER_FILE || have.has(`${c.repoId}:${c.id}`)) continue;
      perFile.set(c.filePath, n + 1);
      have.add(`${c.repoId}:${c.id}`);
      chunks.push(toContextChunk(c, null, "dependency"));
    }
  }

  const text = (c: ContextChunk) => c.code.length;
  return {
    mode: "embeddings",
    chunks,
    relevantClaudeMdSections: await findClaudeMdSections(chunks, docs),
    relevantMindmapExcerpt: await findMindmapExcerpt(chunks, docs),
    tokenEstimate: Math.ceil(chunks.reduce((sum, c) => sum + text(c), 0) / 4),
    truncated: false,
  };
}
