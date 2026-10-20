import { getPool } from "../db";
import type { ChunkRecord, CrossRepoLink, DependencyEdge } from "./types";

const INSERT_BATCH = 200;

const toVector = (v: number[]) => `[${v.join(",")}]`;

export async function clearRepo(repoName: string): Promise<void> {
  const pool = getPool();
  await pool.query("DELETE FROM chunks WHERE repo_name = $1", [repoName]);
  await pool.query("DELETE FROM dependencies WHERE repo_name = $1", [repoName]);
}

export async function insertChunks(chunks: ChunkRecord[]): Promise<void> {
  const pool = getPool();
  for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
    const batch = chunks.slice(i, i + INSERT_BATCH);
    const values: unknown[] = [];
    const rows = batch.map((c, j) => {
      const o = j * 8;
      values.push(c.repoName, c.filePath, c.symbolName, c.chunkType, c.code, c.embedding ? toVector(c.embedding) : null, c.startLine, c.endLine);
      return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6}::vector,$${o + 7},$${o + 8})`;
    });
    await pool.query(
      `INSERT INTO chunks (repo_name, file_path, symbol_name, chunk_type, code, embedding, start_line, end_line) VALUES ${rows.join(",")}`,
      values,
    );
  }
}

export async function insertDependencies(repoName: string, edges: DependencyEdge[]): Promise<void> {
  const pool = getPool();
  for (let i = 0; i < edges.length; i += INSERT_BATCH) {
    const batch = edges.slice(i, i + INSERT_BATCH);
    const values: unknown[] = [];
    const rows = batch.map((e, j) => {
      values.push(repoName, e.filePath, e.importsFilePath);
      return `($${j * 3 + 1},$${j * 3 + 2},$${j * 3 + 3})`;
    });
    await pool.query(`INSERT INTO dependencies (repo_name, file_path, imports_file_path) VALUES ${rows.join(",")}`, values);
  }
}

/** Replace links originating from the given repos. */
export async function replaceCrossRepoLinks(fromRepos: string[], links: CrossRepoLink[]): Promise<void> {
  const pool = getPool();
  await pool.query("DELETE FROM cross_repo_links WHERE from_repo = ANY($1)", [fromRepos]);
  for (const l of links) {
    await pool.query("INSERT INTO cross_repo_links (from_repo, to_repo, evidence) VALUES ($1,$2,$3)", [l.fromRepo, l.toRepo, l.evidence]);
  }
}
