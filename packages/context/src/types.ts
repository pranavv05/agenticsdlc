/** A repo checked out on disk, as the indexing pipeline sees it. `id` is the registry slug (Repo.id) and the key in every table. */
export interface RepoTarget {
  id: string;
  name: string;
  /** Absolute path to the working tree. */
  path: string;
}

/** The prototype's hand-edited repos.config.json entry. Kept only until the repo registry replaces it. */
export interface RepoConfig {
  name: string;
  path: string;
  description: string;
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
