import type { ContextBundle, RetrievalMode } from "@sdd/contracts";

/** A repo checked out on disk, as the indexing pipeline sees it. `id` is the registry slug (Repo.id) and the key in every table. */
export interface RepoTarget {
  id: string;
  name: string;
  /** Absolute path to the working tree. */
  path: string;
}

export type ChunkType = "function" | "class" | "route" | "other";

export interface ChunkRecord {
  repoId: string;
  filePath: string; // repo-relative, forward slashes
  symbolName: string | null;
  chunkType: ChunkType;
  code: string;
  startLine: number; // 1-based
  endLine: number;
  /** Commit the chunk's file was indexed at. Null for repos without git. */
  commitSha?: string | null;
  embedding?: number[];
}

export interface DependencyEdge {
  filePath: string;
  importsFilePath: string;
}

export interface CrossRepoLink {
  /** Repo ids. */
  fromRepo: string;
  toRepo: string;
  evidence: string[];
}

export interface ModuleInfo {
  dir: string; // repo-relative, forward slashes
  name: string;
}

export interface ModuleDoc {
  dir: string;
  summary: string;
  /** Path of the generated file relative to the repo's docs root, mirroring the repo tree. */
  claudeMdPath: string;
}

export type ProgressStage =
  "files" | "plan" | "chunks" | "embeddings" | "dependencies" | "cross_repo_links" | "claude_md" | "mindmap" | "done" | "error";

export type ProgressCounts = Record<string, number | string>;

export type ProgressCallback = (repoId: string, stage: ProgressStage, counts: ProgressCounts) => void | Promise<void>;

export interface ContextRequest {
  /** The registered repo to ground the task in (Initiative.repoId). */
  repoId: string;
  /** The requirement or design question the context is for. */
  task: string;
  /** Retrieval strategy. Default: the provider's default ("hybrid"). */
  mode?: RetrievalMode;
  /** Upper bound on the bundle's size in estimated tokens. Default 12,000. */
  budgetTokens?: number;
}

/**
 * The seam between the workflow and the Context Agent. The orchestrator depends only on this interface:
 * Case A gets a NullContextProvider (an empty bundle), Case B a RepoContextProvider.
 */
export interface ContextProvider {
  getContext(request: ContextRequest): Promise<ContextBundle>;
}
