export interface RepoConfig {
  name: string;
  path: string;
  description: string;
}

export type ChunkType = "function" | "class" | "route" | "other";

export interface ChunkRecord {
  repoName: string;
  filePath: string; // repo-relative, forward slashes
  symbolName: string | null;
  chunkType: ChunkType;
  code: string;
  startLine: number; // 1-based
  endLine: number;
  embedding?: number[];
}

export interface DependencyEdge {
  filePath: string;
  importsFilePath: string;
}

export interface CrossRepoLink {
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
  claudeMdPath: string; // repo-relative path of the generated file
}

export type ProgressStage =
  | "files"
  | "chunks"
  | "embeddings"
  | "dependencies"
  | "cross_repo_links"
  | "claude_md"
  | "mindmap"
  | "done"
  | "error";

export type ProgressCounts = Record<string, number | string>;

export type ProgressCallback = (repoName: string, stage: ProgressStage, counts: ProgressCounts) => void | Promise<void>;
