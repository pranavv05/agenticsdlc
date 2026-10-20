import fs from "node:fs/promises";
import path from "node:path";
import { getPool } from "../db";
import { embedTexts } from "./embed";
import { defaultOutputDir, loadRepoConfig, safeName } from "./config";
import { GENERATED_CLAUDE_MD } from "./walk";
import type { RepoConfig } from "./types";

export interface QueryChunk {
  id: number;
  repoName: string;
  filePath: string;
  symbolName: string | null;
  chunkType: string;
  code: string;
  startLine: number;
  endLine: number;
  score: number | null; // cosine similarity; null for dependency-expanded chunks
  via: "similarity" | "dependency";
}

export interface ClaudeMdSection {
  repoName: string;
  path: string;
  content: string;
}

export interface ContextBundle {
  chunks: QueryChunk[];
  relevantClaudeMdSections: ClaudeMdSection[];
  relevantMindmapExcerpt: string;
}

const MAX_SECTION_CHARS = 3_500;
const MAX_MINDMAP_CHARS = 4_000;
const HOP_CHUNKS_PER_FILE = 3;

async function readTrunc(file: string, max: number): Promise<string | null> {
  try {
    const t = await fs.readFile(file, "utf8");
    return t.length > max ? t.slice(0, max) + "\n…(truncated)" : t;
  } catch {
    return null;
  }
}

async function findClaudeMdSections(chunks: QueryChunk[], repos: RepoConfig[]): Promise<ClaudeMdSection[]> {
  const byName = new Map(repos.map((r) => [r.name, r]));
  const seen = new Set<string>();
  const sections: ClaudeMdSection[] = [];

  for (const c of chunks) {
    const repo = byName.get(c.repoName);
    if (!repo) continue;
    // deepest module doc first, then ancestors, up to the repo root doc
    const parts = c.filePath.split("/").slice(0, -1);
    for (let i = parts.length; i >= 0; i--) {
      const dir = parts.slice(0, i).join("/");
      const rel = dir ? `${dir}/${GENERATED_CLAUDE_MD}` : GENERATED_CLAUDE_MD;
      const key = `${repo.name}:${rel}`;
      if (seen.has(key)) continue;
      const content = await readTrunc(path.join(repo.path, ...rel.split("/")), MAX_SECTION_CHARS);
      if (content) {
        seen.add(key);
        sections.push({ repoName: repo.name, path: rel, content });
      }
    }
  }
  return sections;
}

async function findMindmapExcerpt(chunks: QueryChunk[], outputDir: string): Promise<string> {
  const repoNames = [...new Set(chunks.map((c) => c.repoName))];
  const parts: string[] = [];
  const system = await readTrunc(path.join(outputDir, "system.md"), MAX_MINDMAP_CHARS);
  if (system) parts.push(system);
  for (const name of repoNames) {
    const t = await readTrunc(path.join(outputDir, `${safeName(name)}.md`), MAX_MINDMAP_CHARS);
    if (t) parts.push(t);
  }
  return parts.join("\n\n---\n\n");
}

/**
 * Embed the feature description, cosine-search pgvector across all repos' chunks, expand one hop
 * through the dependencies table (files imported by the hits), and attach CLAUDE.md + mindmap context.
 */
export async function queryContext(
  featureDescription: string,
  topK = 15,
  opts: { repos?: RepoConfig[]; outputDir?: string; repoNames?: string[] } = {},
): Promise<ContextBundle> {
  const pool = getPool();
  const [vec] = await embedTexts([featureDescription], "query");
  const vector = `[${vec.join(",")}]`;

  const hits = await pool.query(
    `SELECT id, repo_name, file_path, symbol_name, chunk_type, code, start_line, end_line,
            1 - (embedding <=> $1::vector) AS score
       FROM chunks
      WHERE embedding IS NOT NULL AND ($3::text[] IS NULL OR repo_name = ANY($3))
      ORDER BY embedding <=> $1::vector
      LIMIT $2`,
    [vector, topK, opts.repoNames ?? null],
  );

  const toChunk = (r: Record<string, unknown>, via: QueryChunk["via"]): QueryChunk => ({
    id: Number(r.id),
    repoName: r.repo_name as string,
    filePath: r.file_path as string,
    symbolName: (r.symbol_name as string) ?? null,
    chunkType: r.chunk_type as string,
    code: r.code as string,
    startLine: r.start_line as number,
    endLine: r.end_line as number,
    score: via === "similarity" ? Number(r.score) : null,
    via,
  });

  const chunks = hits.rows.map((r) => toChunk(r, "similarity"));
  const have = new Set(chunks.map((c) => c.id));

  if (chunks.length) {
    const repoNames = chunks.map((c) => c.repoName);
    const files = chunks.map((c) => c.filePath);
    const hop = await pool.query(
      `WITH targets AS (
         SELECT DISTINCT d.repo_name, d.imports_file_path AS file_path
           FROM dependencies d
           JOIN unnest($1::text[], $2::text[]) AS t(repo_name, file_path)
             ON d.repo_name = t.repo_name AND d.file_path = t.file_path
       ), ranked AS (
         SELECT c.*, row_number() OVER (PARTITION BY c.repo_name, c.file_path ORDER BY c.start_line) AS rn
           FROM chunks c JOIN targets USING (repo_name, file_path)
       )
       SELECT id, repo_name, file_path, symbol_name, chunk_type, code, start_line, end_line
         FROM ranked WHERE rn <= $3`,
      [repoNames, files, HOP_CHUNKS_PER_FILE],
    );
    for (const r of hop.rows) {
      const c = toChunk(r, "dependency");
      if (!have.has(c.id)) {
        have.add(c.id);
        chunks.push(c);
      }
    }
  }

  const repos = opts.repos ?? safeLoadRepos();
  return {
    chunks,
    relevantClaudeMdSections: await findClaudeMdSections(chunks, repos),
    relevantMindmapExcerpt: await findMindmapExcerpt(chunks, opts.outputDir ?? defaultOutputDir()),
  };
}

function safeLoadRepos(): RepoConfig[] {
  try {
    return loadRepoConfig();
  } catch {
    return [];
  }
}
