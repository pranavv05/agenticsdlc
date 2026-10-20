import fs from "node:fs/promises";
import { chunkRepo } from "../chunk";
import { extractDependencies } from "../dependencies";
import type { DocsOutput } from "../docsOutput";
import type { ContextStore, StoredRepo } from "../store/types";
import type { ChunkRecord, DependencyEdge } from "../types";
import { GENERATED_CLAUDE_MD, walkRepo } from "../walk";
import { LexicalIndex } from "./lexical";

const MAX_MODULE_DOC_CHARS = 20_000;

/** Everything the lexical (grep-style) retrieval needs about one repo at one indexed version. Built once, then reused. */
export interface RepoSnapshot {
  /** Where the chunks came from: the index (full strategy) or the working tree (claude-md-only, or a lost index). */
  source: "store" | "disk";
  chunks: ChunkRecord[];
  byFile: Map<string, ChunkRecord[]>;
  imports: Map<string, string[]>;
  importedBy: Map<string, string[]>;
  lexical: LexicalIndex;
}

export interface SnapshotDeps {
  store: ContextStore;
  docs: DocsOutput;
  /** Replaceable in tests. */
  chunkFromDisk?: (repoPath: string, repoId: string) => Promise<ChunkRecord[]>;
  edgesFromDisk?: (repoPath: string) => Promise<DependencyEdge[]>;
}

const exists = (dir: string) =>
  fs.stat(dir).then(
    (s) => s.isDirectory(),
    () => false,
  );

function adjacency(edges: DependencyEdge[]) {
  const imports = new Map<string, string[]>();
  const importedBy = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, k: string, v: string) => m.set(k, [...(m.get(k) ?? []), v]);
  for (const e of edges) {
    push(imports, e.filePath, e.importsFilePath);
    push(importedBy, e.importsFilePath, e.filePath);
  }
  return { imports, importedBy };
}

/**
 * Loads the repo's chunks and import graph. A repo indexed with the full strategy is read from the index, so what is
 * searched is exactly what was indexed at that commit. A claude-md-only repo has no stored chunks, so its working tree is
 * parsed instead (parse-only, no model calls).
 */
export async function buildSnapshot(repo: StoredRepo, deps: SnapshotDeps): Promise<RepoSnapshot> {
  let chunks: ChunkRecord[] = [];
  let edges: DependencyEdge[] = [];
  let source: RepoSnapshot["source"] = "store";

  if (repo.indexStrategy === "full") {
    chunks = (await deps.store.getChunks(repo.id)).map(({ id: _id, ...c }) => c);
    edges = await deps.store.getEdges(repo.id);
  }
  if (chunks.length === 0 && repo.localPath && (await exists(repo.localPath))) {
    source = "disk";
    const walked = await walkRepo(repo.localPath);
    chunks = await (deps.chunkFromDisk ?? ((p, id) => chunkRepo(p, id, walked)))(repo.localPath, repo.id);
    edges = await (deps.edgesFromDisk ?? ((p) => extractDependencies(p, walked)))(repo.localPath);
  }

  const moduleDocs = new Map<string, string>();
  for (const rel of await deps.docs.listDocs(repo.id)) {
    if (rel === GENERATED_CLAUDE_MD) continue; // the root doc describes the whole repo, so it says nothing about which module to look in
    const text = await deps.docs.read(repo.id, rel, MAX_MODULE_DOC_CHARS);
    if (text) moduleDocs.set(rel.slice(0, -(GENERATED_CLAUDE_MD.length + 1)), text);
  }

  const byFile = new Map<string, ChunkRecord[]>();
  for (const c of chunks) byFile.set(c.filePath, [...(byFile.get(c.filePath) ?? []), c]);
  for (const list of byFile.values()) list.sort((a, b) => a.startLine - b.startLine);

  return { source, chunks, byFile, ...adjacency(edges), lexical: new LexicalIndex(chunks, moduleDocs) };
}
