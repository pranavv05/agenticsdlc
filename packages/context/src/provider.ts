import { EMPTY_CONTEXT_BUNDLE, type ClaudeMdSection, type ContextBundle, type ContextChunk, type RetrievalMode } from "@sdd/contracts";
import { DocsOutput, defaultOutputRoot } from "./docsOutput";
import { embedTexts } from "./embed";
import { DEFAULT_BUDGET_TOKENS, assembleBundle } from "./retrieval/budget";
import { reciprocalRankFusion } from "./retrieval/fusion";
import { excerptMindmap } from "./retrieval/mindmapExcerpt";
import { buildSnapshot, type RepoSnapshot, type SnapshotDeps } from "./retrieval/snapshot";
import type { ContextStore, StoredRepo } from "./store/types";
import type { ChunkRecord, ContextProvider, ContextRequest } from "./types";
import { GENERATED_CLAUDE_MD } from "./walk";

export type ContextErrorCode = "empty_task" | "invalid_budget" | "repo_not_found" | "repo_not_indexed";

export class ContextError extends Error {
  constructor(
    readonly code: ContextErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ContextError";
  }
}

/** Case A: there is no repo to ground in, so the bundle is empty. A fresh object each call, so callers may mutate it. */
export class NullContextProvider implements ContextProvider {
  async getContext(_request?: ContextRequest): Promise<ContextBundle> {
    return { ...EMPTY_CONTEXT_BUNDLE, chunks: [], relevantClaudeMdSections: [] };
  }
}

export interface RepoContextProviderOptions {
  store: ContextStore;
  /** Where the generated docs were written. Default: CONTEXT_OUTPUT_DIR or ./output. */
  outputRoot?: string;
  /** Mode when the request names none. Default "hybrid". */
  defaultMode?: RetrievalMode;
  defaultBudgetTokens?: number;
  /** Number of primary chunk hits to gather before the budget is applied. Default 15. */
  topK?: number;
  /** Neighbour files pulled in per direction (imports, importers). Default 6. */
  neighbourFiles?: number;
  /** Chunks taken from each neighbour file. Default 3. */
  chunksPerNeighbour?: number;
  /** Replaceable in tests. */
  snapshotDeps?: Pick<SnapshotDeps, "chunkFromDisk" | "edgesFromDisk">;
}

interface Ranked {
  chunk: ChunkRecord;
  /** Cosine similarity for embedding hits, otherwise null. */
  score: number | null;
  via: "similarity" | "lexical";
}

const MAX_SECTION_READ_CHARS = 12_000;
const SYSTEM_MAP_CHARS = 1_200;
const RELEVANT_MODULE_THRESHOLD = 0.6;
const EXTRA_MODULE_DOCS = 2;

const chunkKey = (c: ChunkRecord) => `${c.filePath}:${c.startLine}:${c.endLine}`;

const toContextChunk = (repoId: string, c: ChunkRecord, score: number | null, via: ContextChunk["via"]): ContextChunk => ({
  repoId,
  filePath: c.filePath,
  symbolName: c.symbolName,
  chunkType: c.chunkType,
  code: c.code,
  startLine: c.startLine,
  endLine: c.endLine,
  score,
  via,
});

/**
 * Case B: context from an indexed repo, in one of three modes that return the same bundle shape.
 *  - "claude-md": no embeddings. The generated module docs steer a BM25 search over the code, plus import neighbours.
 *  - "embeddings": nearest chunks by vector similarity (pgvector), plus import neighbours.
 *  - "hybrid": both rankings merged by reciprocal rank fusion, de-duplicated.
 * In every mode the matching CLAUDE.md sections and a mind-map excerpt are attached, and the whole bundle is cut to the
 * token budget, best-ranked content first, with a marker where text was cut.
 */
export class RepoContextProvider implements ContextProvider {
  private readonly store: ContextStore;
  private readonly docs: DocsOutput;
  private readonly defaultMode: RetrievalMode;
  private readonly defaultBudget: number;
  private readonly topK: number;
  private readonly neighbourLimit: number;
  private readonly perNeighbour: number;
  private readonly snapshotDeps: RepoContextProviderOptions["snapshotDeps"];
  private readonly snapshots = new Map<string, Promise<RepoSnapshot>>();

  constructor(options: RepoContextProviderOptions) {
    this.store = options.store;
    this.docs = new DocsOutput(options.outputRoot ?? defaultOutputRoot());
    this.defaultMode = options.defaultMode ?? "hybrid";
    this.defaultBudget = options.defaultBudgetTokens ?? DEFAULT_BUDGET_TOKENS;
    this.topK = options.topK ?? 15;
    this.neighbourLimit = options.neighbourFiles ?? 6;
    this.perNeighbour = options.chunksPerNeighbour ?? 3;
    this.snapshotDeps = options.snapshotDeps;
  }

  async getContext(request: ContextRequest): Promise<ContextBundle> {
    const task = request.task?.trim();
    if (!task) throw new ContextError("empty_task", "task is empty");
    const budget = request.budgetTokens ?? this.defaultBudget;
    if (!Number.isInteger(budget) || budget < 1)
      throw new ContextError("invalid_budget", `budgetTokens must be a positive integer, got ${budget}`);

    const repo = await this.store.getRepo(request.repoId);
    if (!repo) throw new ContextError("repo_not_found", `Repo "${request.repoId}" is not registered`);
    // A repo whose latest run failed can still be served from its previous good index; one that never finished cannot.
    if (!repo.indexedAt)
      throw new ContextError("repo_not_indexed", `Repo "${request.repoId}" has not been indexed yet (status: ${repo.status})`);

    const requested = request.mode ?? this.defaultMode;
    // A repo indexed with the claude-md-only strategy has no embeddings, so the other modes degrade to claude-md.
    const mode: RetrievalMode = repo.indexStrategy === "claude-md-only" ? "claude-md" : requested;

    const snapshot = mode === "embeddings" ? null : await this.snapshotFor(repo);
    const ranked = await this.rank(repo, task, mode, snapshot);
    const neighbours = await this.neighbourChunks(repo, snapshot, ranked);
    const sections = await this.sections(repo, ranked, task, snapshot);
    const mindmap = await this.mindmap(repo, sections);

    const chunks = [
      ...ranked.map((r) => toContextChunk(repo.id, r.chunk, r.score, r.via)),
      ...neighbours.map((c) => toContextChunk(repo.id, c, null, "dependency")),
    ];
    return assembleBundle({ mode, chunks, sections, mindmap }, budget);
  }

  // ---- ranking ----

  private async rank(repo: StoredRepo, task: string, mode: RetrievalMode, snapshot: RepoSnapshot | null): Promise<Ranked[]> {
    const lexical = (): Ranked[] =>
      snapshot ? snapshot.lexical.search(task, this.topK).map((h) => ({ chunk: h.chunk, score: null, via: "lexical" as const })) : [];
    const embedding = async (): Promise<Ranked[]> => {
      const [vector] = await embedTexts([task], "query");
      const hits = await this.store.searchSimilar({ repoIds: [repo.id], vector, limit: this.topK });
      return hits.map(({ id: _id, score, ...chunk }) => ({ chunk, score, via: "similarity" as const }));
    };

    if (mode === "claude-md") return lexical();
    if (mode === "embeddings") return embedding();

    const [byVector, byWords] = [await embedding(), lexical()];
    return reciprocalRankFusion([byVector, byWords], (r) => chunkKey(r.chunk))
      .slice(0, this.topK)
      .map(({ item, key, ranks }) => {
        // keep the similarity score when the chunk was also found by vector search
        const fromVector = ranks[0] !== null ? byVector.find((r) => chunkKey(r.chunk) === key) : undefined;
        return fromVector ?? item;
      });
  }

  // ---- dependency neighbours (one hop, both directions) ----

  private async neighbourChunks(repo: StoredRepo, snapshot: RepoSnapshot | null, ranked: Ranked[]): Promise<ChunkRecord[]> {
    if (!ranked.length) return [];
    const files = [...new Set(ranked.map((r) => r.chunk.filePath))];
    const hit = new Set(files);

    let imports: string[];
    let importedBy: string[];
    if (snapshot) {
      const collect = (m: Map<string, string[]>) => [...new Set(files.flatMap((f) => m.get(f) ?? []))].filter((f) => !hit.has(f)).sort();
      imports = collect(snapshot.imports);
      importedBy = collect(snapshot.importedBy);
    } else {
      ({ imports, importedBy } = await this.store.getNeighbourFiles(repo.id, files));
    }
    const wanted = [...new Set([...imports.slice(0, this.neighbourLimit), ...importedBy.slice(0, this.neighbourLimit)])];
    if (!wanted.length) return [];

    const seen = new Set(ranked.map((r) => chunkKey(r.chunk)));
    const out: ChunkRecord[] = [];
    const chunksOf = async (file: string): Promise<ChunkRecord[]> =>
      snapshot ? (snapshot.byFile.get(file) ?? []) : (await this.store.getChunks(repo.id, { files: [file] })).map(({ id: _id, ...c }) => c);
    for (const file of wanted) {
      let taken = 0;
      for (const c of await chunksOf(file)) {
        if (taken >= this.perNeighbour) break;
        if (seen.has(chunkKey(c))) continue;
        seen.add(chunkKey(c));
        out.push(c);
        taken++;
      }
    }
    return out;
  }

  // ---- generated docs ----

  private async sections(repo: StoredRepo, ranked: Ranked[], task: string, snapshot: RepoSnapshot | null): Promise<ClaudeMdSection[]> {
    const sections: ClaudeMdSection[] = [];
    const seen = new Set<string>();
    const add = async (rel: string) => {
      if (seen.has(rel)) return;
      const content = await this.docs.read(repo.id, rel, MAX_SECTION_READ_CHARS);
      seen.add(rel);
      if (content) sections.push({ repoId: repo.id, path: rel, content });
    };
    const docPath = (dir: string) => (dir ? `${dir}/${GENERATED_CLAUDE_MD}` : GENERATED_CLAUDE_MD);

    // modules the hits live in, in rank order: the deepest module doc first, then its ancestors (the root overview comes last)
    for (const r of ranked) {
      const parts = r.chunk.filePath.split("/").slice(0, -1);
      for (let i = parts.length; i >= 1; i--) await add(docPath(parts.slice(0, i).join("/")));
    }
    // modules whose docs match the task even though no chunk of theirs ranked
    if (snapshot) {
      for (const m of snapshot.lexical.relevantModules(task, EXTRA_MODULE_DOCS)) {
        if (m.relevance >= RELEVANT_MODULE_THRESHOLD) await add(docPath(m.dir));
      }
    }
    await add(docPath("")); // the repo overview closes the list: general, so the least specific
    return sections;
  }

  private async mindmap(repo: StoredRepo, sections: ClaudeMdSection[]): Promise<string> {
    const parts: string[] = [];
    const system = await this.docs.readMindmap(this.docs.systemBase(), SYSTEM_MAP_CHARS);
    if (system) parts.push(system);
    const repoMap = await this.docs.readMindmap(this.docs.mindmapBase(repo.id));
    if (repoMap) {
      const dirs = sections.map((s) => s.path.slice(0, -(GENERATED_CLAUDE_MD.length + 1))).filter(Boolean);
      parts.push(excerptMindmap(repoMap, dirs));
    }
    return parts.join("\n\n---\n\n");
  }

  // ---- snapshots (cached per indexed version) ----

  private snapshotFor(repo: StoredRepo): Promise<RepoSnapshot> {
    const key = [repo.id, repo.indexedCommitSha, repo.indexedAt, repo.indexStrategy].join("|");
    let snapshot = this.snapshots.get(key);
    if (!snapshot) {
      for (const stale of [...this.snapshots.keys()]) if (stale.startsWith(repo.id + "|")) this.snapshots.delete(stale);
      snapshot = buildSnapshot(repo, { store: this.store, docs: this.docs, ...this.snapshotDeps });
      snapshot.catch(() => this.snapshots.delete(key)); // do not cache a failure
      this.snapshots.set(key, snapshot);
    }
    return snapshot;
  }
}
