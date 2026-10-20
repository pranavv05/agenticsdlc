import type { IndexStrategy } from "@sdd/contracts";
import type { Pool, PoolClient } from "pg";
import type { ChunkRecord, CrossRepoLink, DependencyEdge, ProgressCounts } from "../types";
import type { ContextStore, IndexRun, ReplaceIndexInput, RunPatch, ScoredChunk, StoredChunk, StoredRepo } from "./types";

const INSERT_BATCH = 200;
const toVector = (v: number[]) => `[${v.join(",")}]`;
const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());

type Row = Record<string, unknown>;

function repoFromRow(r: Row): StoredRepo {
  return {
    id: r.id as string,
    name: r.name as string,
    source: { type: r.source_type, value: r.source_value } as StoredRepo["source"],
    localPath: (r.local_path as string | null) ?? null,
    status: r.status as StoredRepo["status"],
    profile: (r.profile as StoredRepo["profile"]) ?? null,
    indexStrategy: (r.index_strategy as StoredRepo["indexStrategy"]) ?? null,
    indexedCommitSha: (r.indexed_commit_sha as string | null) ?? null,
    indexedAt: iso(r.indexed_at as Date | null),
    ...(r.error ? { error: r.error as string } : {}),
    createdAt: iso(r.created_at as Date)!,
    updatedAt: iso(r.updated_at as Date)!,
  };
}

function chunkFromRow(r: Row): StoredChunk {
  return {
    id: Number(r.id),
    repoId: r.repo_id as string,
    filePath: r.file_path as string,
    symbolName: (r.symbol_name as string | null) ?? null,
    chunkType: r.chunk_type as StoredChunk["chunkType"],
    code: r.code as string,
    startLine: r.start_line as number,
    endLine: r.end_line as number,
    commitSha: (r.commit_sha as string | null) ?? null,
  };
}

function runFromRow(r: Row): IndexRun {
  return {
    id: Number(r.id),
    repoId: r.repo_id as string,
    status: r.status as IndexRun["status"],
    strategy: r.strategy as IndexStrategy,
    mode: (r.mode as IndexRun["mode"]) ?? null,
    commitSha: (r.commit_sha as string | null) ?? null,
    fromCommitSha: (r.from_commit_sha as string | null) ?? null,
    progress: (r.progress as Record<string, ProgressCounts>) ?? {},
    error: (r.error as string | null) ?? null,
    startedAt: iso(r.started_at as Date)!,
    finishedAt: iso(r.finished_at as Date | null),
  };
}

const CHUNK_COLUMNS = "id, repo_id, file_path, symbol_name, chunk_type, code, start_line, end_line, commit_sha";

export class PgContextStore implements ContextStore {
  constructor(private readonly pool: Pool) {}

  // ---- repos ----

  async getRepo(id: string) {
    const { rows } = await this.pool.query("SELECT * FROM repos WHERE id = $1", [id]);
    return rows[0] ? repoFromRow(rows[0]) : null;
  }

  async listRepos() {
    const { rows } = await this.pool.query("SELECT * FROM repos ORDER BY created_at DESC, id");
    return rows.map(repoFromRow);
  }

  async saveRepo(repo: StoredRepo) {
    await this.pool.query(
      `INSERT INTO repos (id, name, source_type, source_value, local_path, status, profile, index_strategy, indexed_commit_sha, indexed_at, error, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, source_type = EXCLUDED.source_type, source_value = EXCLUDED.source_value, local_path = EXCLUDED.local_path,
         status = EXCLUDED.status, profile = EXCLUDED.profile, index_strategy = EXCLUDED.index_strategy,
         indexed_commit_sha = EXCLUDED.indexed_commit_sha, indexed_at = EXCLUDED.indexed_at, error = EXCLUDED.error,
         updated_at = EXCLUDED.updated_at`,
      [
        repo.id,
        repo.name,
        repo.source.type,
        repo.source.value,
        repo.localPath,
        repo.status,
        repo.profile ? JSON.stringify(repo.profile) : null,
        repo.indexStrategy,
        repo.indexedCommitSha,
        repo.indexedAt,
        repo.error ?? null,
        repo.createdAt,
        repo.updatedAt,
      ],
    );
  }

  // ---- the index ----

  async replaceIndex(input: ReplaceIndexInput) {
    // The foreign key only proves that the chunk's repo exists, not that it is THIS repo: check before opening the transaction.
    const stray = input.chunks.find((c) => c.repoId !== input.repoId);
    if (stray) throw new Error(`Chunk for repo "${stray.repoId}" in an index update for "${input.repoId}"`);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (input.mode === "full") await client.query("DELETE FROM chunks WHERE repo_id = $1", [input.repoId]);
      else if (input.files.length)
        await client.query("DELETE FROM chunks WHERE repo_id = $1 AND file_path = ANY($2::text[])", [input.repoId, input.files]);
      await this.insertChunks(client, input.chunks);
      if (input.edges) {
        await client.query("DELETE FROM dependencies WHERE repo_id = $1", [input.repoId]);
        await this.insertEdges(client, input.repoId, input.edges);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async insertChunks(client: PoolClient, chunks: ChunkRecord[]) {
    for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
      const batch = chunks.slice(i, i + INSERT_BATCH);
      const values: unknown[] = [];
      const rows = batch.map((c, j) => {
        const o = j * 9;
        values.push(
          c.repoId,
          c.filePath,
          c.symbolName,
          c.chunkType,
          c.code,
          c.embedding ? toVector(c.embedding) : null,
          c.startLine,
          c.endLine,
          c.commitSha ?? null,
        );
        return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6}::vector,$${o + 7},$${o + 8},$${o + 9})`;
      });
      await client.query(
        `INSERT INTO chunks (repo_id, file_path, symbol_name, chunk_type, code, embedding, start_line, end_line, commit_sha) VALUES ${rows.join(",")}`,
        values,
      );
    }
  }

  private async insertEdges(client: PoolClient, repoId: string, edges: DependencyEdge[]) {
    for (let i = 0; i < edges.length; i += INSERT_BATCH) {
      const batch = edges.slice(i, i + INSERT_BATCH);
      const values: unknown[] = [];
      const rows = batch.map((e, j) => {
        values.push(repoId, e.filePath, e.importsFilePath);
        return `($${j * 3 + 1},$${j * 3 + 2},$${j * 3 + 3})`;
      });
      await client.query(`INSERT INTO dependencies (repo_id, file_path, imports_file_path) VALUES ${rows.join(",")}`, values);
    }
  }

  async getChunks(repoId: string, options: { files?: string[] } = {}) {
    const { rows } = options.files
      ? await this.pool.query(
          `SELECT ${CHUNK_COLUMNS} FROM chunks WHERE repo_id = $1 AND file_path = ANY($2::text[]) ORDER BY file_path, start_line, id`,
          [repoId, options.files],
        )
      : await this.pool.query(`SELECT ${CHUNK_COLUMNS} FROM chunks WHERE repo_id = $1 ORDER BY file_path, start_line, id`, [repoId]);
    return rows.map(chunkFromRow);
  }

  async countChunks(repoId: string) {
    const { rows } = await this.pool.query("SELECT count(*)::int AS n FROM chunks WHERE repo_id = $1", [repoId]);
    return rows[0].n as number;
  }

  async searchSimilar({ repoIds, vector, limit }: { repoIds: string[]; vector: number[]; limit: number }) {
    const { rows } = await this.pool.query(
      `SELECT ${CHUNK_COLUMNS}, 1 - (embedding <=> $1::vector) AS score
         FROM chunks
        WHERE embedding IS NOT NULL AND repo_id = ANY($3::text[])
        ORDER BY embedding <=> $1::vector, id
        LIMIT $2`,
      [toVector(vector), limit, repoIds],
    );
    return rows.map((r): ScoredChunk => ({ ...chunkFromRow(r), score: Number(r.score) }));
  }

  async getEdges(repoId: string) {
    const { rows } = await this.pool.query(
      "SELECT file_path, imports_file_path FROM dependencies WHERE repo_id = $1 ORDER BY file_path, imports_file_path",
      [repoId],
    );
    return rows.map((r): DependencyEdge => ({ filePath: r.file_path, importsFilePath: r.imports_file_path }));
  }

  async getNeighbourFiles(repoId: string, files: string[]) {
    const [out, inc] = await Promise.all([
      this.pool.query(
        "SELECT DISTINCT imports_file_path AS f FROM dependencies WHERE repo_id = $1 AND file_path = ANY($2::text[]) AND NOT (imports_file_path = ANY($2::text[])) ORDER BY 1",
        [repoId, files],
      ),
      this.pool.query(
        "SELECT DISTINCT file_path AS f FROM dependencies WHERE repo_id = $1 AND imports_file_path = ANY($2::text[]) AND NOT (file_path = ANY($2::text[])) ORDER BY 1",
        [repoId, files],
      ),
    ]);
    return { imports: out.rows.map((r) => r.f as string), importedBy: inc.rows.map((r) => r.f as string) };
  }

  // ---- cross-repo links ----

  async replaceCrossRepoLinks(fromRepos: string[], links: CrossRepoLink[]) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM cross_repo_links WHERE from_repo = ANY($1::text[])", [fromRepos]);
      for (const l of links) {
        await client.query("INSERT INTO cross_repo_links (from_repo, to_repo, evidence) VALUES ($1,$2,$3)", [
          l.fromRepo,
          l.toRepo,
          l.evidence,
        ]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getCrossRepoLinks() {
    const { rows } = await this.pool.query("SELECT from_repo, to_repo, evidence FROM cross_repo_links ORDER BY from_repo, to_repo");
    return rows.map((r): CrossRepoLink => ({ fromRepo: r.from_repo, toRepo: r.to_repo, evidence: r.evidence }));
  }

  // ---- indexing runs ----

  async createRun({ repoId, strategy }: { repoId: string; strategy: IndexStrategy }) {
    const { rows } = await this.pool.query("INSERT INTO indexing_runs (repo_id, strategy) VALUES ($1, $2) RETURNING *", [repoId, strategy]);
    return runFromRow(rows[0]);
  }

  async updateRun(id: number, patch: RunPatch) {
    const sets: string[] = [];
    const values: unknown[] = [id];
    const set = (column: string, value: unknown, cast = "") => {
      values.push(value);
      sets.push(`${column} = $${values.length}${cast}`);
    };
    if (patch.status !== undefined) set("status", patch.status);
    if (patch.mode !== undefined) set("mode", patch.mode);
    if (patch.commitSha !== undefined) set("commit_sha", patch.commitSha);
    if (patch.fromCommitSha !== undefined) set("from_commit_sha", patch.fromCommitSha);
    if (patch.progress !== undefined) set("progress", JSON.stringify(patch.progress), "::jsonb");
    if (patch.error !== undefined) set("error", patch.error);
    if (patch.finished) sets.push("finished_at = now()");
    if (!sets.length) {
      const run = await this.getRun(id);
      if (!run) throw new Error(`Unknown run ${id}`);
      return run;
    }
    const { rows } = await this.pool.query(`UPDATE indexing_runs SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, values);
    if (!rows[0]) throw new Error(`Unknown run ${id}`);
    return runFromRow(rows[0]);
  }

  async getRun(id: number) {
    const { rows } = await this.pool.query("SELECT * FROM indexing_runs WHERE id = $1", [id]);
    return rows[0] ? runFromRow(rows[0]) : null;
  }

  async listLatestRuns() {
    const { rows } = await this.pool.query("SELECT DISTINCT ON (repo_id) * FROM indexing_runs ORDER BY repo_id, id DESC");
    return rows.map(runFromRow);
  }
}
