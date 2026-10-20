import type { IndexStrategy, Repo } from "@sdd/contracts";
import type { ChunkRecord, CrossRepoLink, DependencyEdge, ProgressCounts } from "../types";

/** A repo as the Context Agent stores it: the public Repo plus where its working tree lives. */
export interface StoredRepo extends Repo {
  /** Absolute path of the checkout (the source path, or the clone in the cache directory). Null until known. */
  localPath: string | null;
}

export type IndexMode = "full" | "incremental";

export interface StoredChunk extends ChunkRecord {
  id: number;
}

export interface ScoredChunk extends StoredChunk {
  /** Cosine similarity, higher is closer. */
  score: number;
}

export interface ReplaceIndexInput {
  repoId: string;
  /**
   * "full": every existing chunk of the repo is replaced by `chunks`.
   * "incremental": only the chunks of `files` are removed first; chunks of other files stay.
   */
  mode: IndexMode;
  /** Files whose chunks are removed (incremental mode): changed, renamed (old path) and deleted files. */
  files: string[];
  /** New chunks, with embeddings where the strategy has them. */
  chunks: ChunkRecord[];
  /** When non-null, replaces every dependency edge of the repo. */
  edges: DependencyEdge[] | null;
}

export type RunStatus = "running" | "done" | "error";

export interface IndexRun {
  id: number;
  repoId: string;
  status: RunStatus;
  strategy: IndexStrategy;
  /** Null until the plan is made. */
  mode: IndexMode | null;
  /** Commit being indexed, and the commit the previous successful run indexed. */
  commitSha: string | null;
  fromCommitSha: string | null;
  /** Latest counts per stage, for progress displays. */
  progress: Record<string, ProgressCounts>;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export type RunPatch = Partial<Pick<IndexRun, "status" | "mode" | "commitSha" | "fromCommitSha" | "progress" | "error">> & {
  finished?: boolean;
};

/**
 * Everything the Context Agent persists. Two implementations: PgContextStore (Postgres + pgvector, used by the app)
 * and MemoryContextStore (no database, used by tests and the offline evaluation). The same contract tests run against both.
 */
export interface ContextStore {
  // ---- repos ----
  getRepo(id: string): Promise<StoredRepo | null>;
  listRepos(): Promise<StoredRepo[]>;
  /** Insert or update. */
  saveRepo(repo: StoredRepo): Promise<void>;

  // ---- the index ----
  /**
   * Replaces part or all of a repo's index in ONE transaction. If anything fails nothing changes, so a failed
   * re-index never wipes the previous good index.
   */
  replaceIndex(input: ReplaceIndexInput): Promise<void>;
  /** Chunks of a repo without embeddings, optionally limited to some files. Ordered by file and line. */
  getChunks(repoId: string, options?: { files?: string[] }): Promise<StoredChunk[]>;
  countChunks(repoId: string): Promise<number>;
  /** Nearest chunks by cosine similarity across the given repos. */
  searchSimilar(input: { repoIds: string[]; vector: number[]; limit: number }): Promise<ScoredChunk[]>;
  getEdges(repoId: string): Promise<DependencyEdge[]>;
  /**
   * Files one hop away in the import graph: `imports` are files the given files import, `importedBy` are files that import them.
   * The given files themselves are never returned.
   */
  getNeighbourFiles(repoId: string, files: string[]): Promise<{ imports: string[]; importedBy: string[] }>;

  // ---- cross-repo links ----
  /** Replaces the links that start at any of `fromRepos`. */
  replaceCrossRepoLinks(fromRepos: string[], links: CrossRepoLink[]): Promise<void>;
  getCrossRepoLinks(): Promise<CrossRepoLink[]>;

  // ---- indexing runs ----
  createRun(input: { repoId: string; strategy: IndexStrategy }): Promise<IndexRun>;
  updateRun(id: number, patch: RunPatch): Promise<IndexRun>;
  getRun(id: number): Promise<IndexRun | null>;
  /** Most recent run of each repo. */
  listLatestRuns(): Promise<IndexRun[]>;
}
