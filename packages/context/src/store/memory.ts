import type { IndexStrategy } from "@sdd/contracts";
import type { CrossRepoLink, DependencyEdge } from "../types";
import type { ContextStore, IndexRun, ReplaceIndexInput, RunPatch, ScoredChunk, StoredChunk, StoredRepo } from "./types";

export const EMBEDDING_DIMENSIONS = 1024;
const CHUNK_TYPES = new Set(["function", "class", "route", "other"]);

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const byFileAndLine = (a: StoredChunk, b: StoredChunk) => a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine || a.id - b.id;

/** Keeps everything in memory. Enforces the same constraints as schema.sql so tests catch the same mistakes. */
export class MemoryContextStore implements ContextStore {
  private repos = new Map<string, StoredRepo>();
  private chunks: StoredChunk[] = [];
  private edges = new Map<string, DependencyEdge[]>();
  private links: CrossRepoLink[] = [];
  private runs: IndexRun[] = [];
  private nextChunkId = 1;
  private nextRunId = 1;

  constructor(private readonly now: () => Date = () => new Date()) {}

  // ---- repos ----

  async getRepo(id: string) {
    const repo = this.repos.get(id);
    return repo ? structuredClone(repo) : null;
  }

  async listRepos() {
    return [...this.repos.values()]
      .map((r) => structuredClone(r))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }

  async saveRepo(repo: StoredRepo) {
    this.repos.set(repo.id, structuredClone(repo));
  }

  // ---- the index ----

  async replaceIndex(input: ReplaceIndexInput) {
    // Validate everything first, then apply: a rejected call changes nothing (the Postgres store gets this from its transaction).
    if (!this.repos.has(input.repoId)) throw new Error(`Unknown repo "${input.repoId}"`);
    for (const c of input.chunks) {
      if (c.repoId !== input.repoId) throw new Error(`Chunk for repo "${c.repoId}" in an index update for "${input.repoId}"`);
      if (!CHUNK_TYPES.has(c.chunkType)) throw new Error(`Invalid chunk type "${c.chunkType}"`);
      if (c.embedding && c.embedding.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(`Embedding has ${c.embedding.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`);
      }
      if (!Number.isInteger(c.startLine) || !Number.isInteger(c.endLine)) throw new Error("Chunk lines must be integers");
    }

    const drop = new Set(input.files);
    const kept = this.chunks.filter((c) => (c.repoId !== input.repoId ? true : input.mode === "incremental" && !drop.has(c.filePath)));
    const added: StoredChunk[] = input.chunks.map((c) => ({
      ...structuredClone(c),
      commitSha: c.commitSha ?? null,
      id: this.nextChunkId++,
    }));
    this.chunks = [...kept, ...added];
    if (input.edges) this.edges.set(input.repoId, structuredClone(input.edges));
  }

  async getChunks(repoId: string, options: { files?: string[] } = {}) {
    const only = options.files ? new Set(options.files) : null;
    return this.chunks
      .filter((c) => c.repoId === repoId && (!only || only.has(c.filePath)))
      .map((c) => {
        const { embedding: _embedding, ...rest } = structuredClone(c);
        return rest as StoredChunk;
      })
      .sort(byFileAndLine);
  }

  async countChunks(repoId: string) {
    return this.chunks.filter((c) => c.repoId === repoId).length;
  }

  async searchSimilar({ repoIds, vector, limit }: { repoIds: string[]; vector: number[]; limit: number }) {
    const ids = new Set(repoIds);
    const scored: ScoredChunk[] = [];
    for (const c of this.chunks) {
      if (!ids.has(c.repoId) || !c.embedding) continue;
      const { embedding: _embedding, ...rest } = structuredClone(c);
      scored.push({ ...(rest as StoredChunk), score: cosine(vector, c.embedding) });
    }
    return scored.sort((a, b) => b.score - a.score || a.id - b.id).slice(0, limit);
  }

  async getEdges(repoId: string) {
    return structuredClone(this.edges.get(repoId) ?? []);
  }

  async getNeighbourFiles(repoId: string, files: string[]) {
    const from = new Set(files);
    const edges = this.edges.get(repoId) ?? [];
    const imports = new Set<string>();
    const importedBy = new Set<string>();
    for (const e of edges) {
      if (from.has(e.filePath) && !from.has(e.importsFilePath)) imports.add(e.importsFilePath);
      if (from.has(e.importsFilePath) && !from.has(e.filePath)) importedBy.add(e.filePath);
    }
    return { imports: [...imports].sort(), importedBy: [...importedBy].sort() };
  }

  // ---- cross-repo links ----

  async replaceCrossRepoLinks(fromRepos: string[], links: CrossRepoLink[]) {
    const from = new Set(fromRepos);
    this.links = [...this.links.filter((l) => !from.has(l.fromRepo)), ...structuredClone(links)];
  }

  async getCrossRepoLinks() {
    return structuredClone(this.links).sort((a, b) => a.fromRepo.localeCompare(b.fromRepo) || a.toRepo.localeCompare(b.toRepo));
  }

  // ---- indexing runs ----

  async createRun({ repoId, strategy }: { repoId: string; strategy: IndexStrategy }) {
    if (!this.repos.has(repoId)) throw new Error(`Unknown repo "${repoId}"`);
    const run: IndexRun = {
      id: this.nextRunId++,
      repoId,
      status: "running",
      strategy,
      mode: null,
      commitSha: null,
      fromCommitSha: null,
      progress: {},
      error: null,
      startedAt: this.now().toISOString(),
      finishedAt: null,
    };
    this.runs.push(run);
    return structuredClone(run);
  }

  async updateRun(id: number, patch: RunPatch) {
    const run = this.runs.find((r) => r.id === id);
    if (!run) throw new Error(`Unknown run ${id}`);
    const { finished, ...fields } = patch;
    Object.assign(run, structuredClone(fields));
    if (finished) run.finishedAt = this.now().toISOString();
    return structuredClone(run);
  }

  async getRun(id: number) {
    const run = this.runs.find((r) => r.id === id);
    return run ? structuredClone(run) : null;
  }

  async listLatestRuns() {
    const latest = new Map<string, IndexRun>();
    for (const run of this.runs) latest.set(run.repoId, run);
    return [...latest.values()].map((r) => structuredClone(r)).sort((a, b) => a.repoId.localeCompare(b.repoId));
  }
}
