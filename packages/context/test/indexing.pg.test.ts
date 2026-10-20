import { setEmbedder, createEmbedder, type Embedder } from "@sdd/llm";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { indexRepo, type IndexOptions } from "../src/pipeline";
import { RepoContextProvider } from "../src/provider";
import { RETRIEVAL_MODES } from "@sdd/contracts";
import { installMockLlm, type MockLlm } from "./helpers/llm";
import { createIsolatedPg, hasDatabase, type IsolatedPg } from "./helpers/pg";
import { commitAll, copyFixture, head, rmrf, tmpDir, write } from "./helpers/repos";

// End to end against real Postgres + pgvector, in a private schema, with the model and embeddings in mock mode.
// Needs the Docker database (`pnpm db:up`); skipped when DATABASE_URL is not set.
describe.skipIf(!hasDatabase)("indexing a repo into Postgres", () => {
  let pg: IsolatedPg;
  let llm: MockLlm;
  let repoDir: string;
  let outputRoot: string;
  const target = () => ({ id: "sample-repo", name: "sample-repo", path: repoDir });
  const run = (extra: Partial<IndexOptions> = {}) => indexRepo(target(), { store: pg.store, outputRoot, ...extra });

  beforeAll(async () => {
    pg = await createIsolatedPg();
  });
  afterAll(async () => {
    await pg.cleanup();
  });
  beforeEach(() => {
    llm = installMockLlm();
    repoDir = copyFixture("sample-repo");
    outputRoot = tmpDir("sdd-pg-out-");
  });
  afterEach(async () => {
    llm.restore();
    await pg.pool.query("DELETE FROM repos");
    rmrf(path.dirname(repoDir));
    rmrf(outputRoot);
  });

  it("stores chunks with embeddings and commit SHAs, dependencies and the repo state", async () => {
    const result = await run();
    expect(result.failedRepos).toEqual([]);

    const { rows } = await pg.pool.query(
      "SELECT file_path, commit_sha, embedding IS NOT NULL AS embedded FROM chunks WHERE repo_id = 'sample-repo'",
    );
    expect(rows.some((r) => r.file_path.startsWith("modules/auth/"))).toBe(true);
    expect(rows.some((r) => r.file_path.startsWith("modules/billing/"))).toBe(true);
    expect(rows.every((r) => r.embedded && r.commit_sha === head(repoDir))).toBe(true);

    const { rows: deps } = await pg.pool.query("SELECT count(*)::int AS n FROM dependencies WHERE repo_id = 'sample-repo'");
    expect(deps[0].n).toBeGreaterThan(0);
    const { rows: repo } = await pg.pool.query(
      "SELECT status, index_strategy, indexed_commit_sha, local_path FROM repos WHERE id = 'sample-repo'",
    );
    expect(repo[0]).toMatchObject({ status: "indexed", index_strategy: "full", indexed_commit_sha: head(repoDir), local_path: repoDir });
    const { rows: runs } = await pg.pool.query("SELECT status, mode, commit_sha FROM indexing_runs WHERE repo_id = 'sample-repo'");
    expect(runs).toEqual([{ status: "done", mode: "full", commit_sha: head(repoDir) }]);
  });

  it.each(RETRIEVAL_MODES)(
    "retrieves billing code, not auth code, for a billing task in %s mode (pgvector + dependency hop + docs)",
    async (mode) => {
      await run();
      const provider = new RepoContextProvider({ store: pg.store, outputRoot, topK: 6 });
      const bundle = await provider.getContext({
        repoId: "sample-repo",
        task: "charge a customer's card and refund part of an invoice payment",
        mode,
      });
      const primary = bundle.chunks.filter((c) => c.via !== "dependency");
      expect(bundle.mode).toBe(mode);
      expect(primary.length).toBeGreaterThan(0);
      expect(primary[0].filePath).toContain("billing/");
      expect(primary.slice(0, 3).every((c) => c.filePath.includes("billing/"))).toBe(true);
      expect(bundle.relevantClaudeMdSections.some((s) => s.path.startsWith("modules/billing/"))).toBe(true);
      expect(bundle.relevantMindmapExcerpt).toContain("mermaid");
      if (mode !== "claude-md") expect(primary.some((c) => c.via === "similarity" && typeof c.score === "number")).toBe(true);
    },
  );

  it("patches the index in Postgres: only the changed file's chunks are replaced", async () => {
    await run();
    const { rows: before } = await pg.pool.query("SELECT id, file_path FROM chunks WHERE repo_id = 'sample-repo' ORDER BY id");
    write(
      repoDir,
      "modules/billing/payments.ts",
      fs.readFileSync(path.join(repoDir, "modules/billing/payments.ts"), "utf8") + "\nexport function voidPayment(): void {}\n",
    );
    commitAll(repoDir, "add voidPayment");
    const embedsBefore = llm.embedCalls.length;
    const second = await run();

    expect(second.plans["sample-repo"].kind).toBe("incremental");
    const { rows: after } = await pg.pool.query("SELECT id, file_path, symbol_name FROM chunks WHERE repo_id = 'sample-repo' ORDER BY id");
    const untouchedBefore = before.filter((r) => r.file_path !== "modules/billing/payments.ts").map((r) => r.id);
    const untouchedAfter = after.filter((r) => r.file_path !== "modules/billing/payments.ts").map((r) => r.id);
    expect(untouchedAfter).toEqual(untouchedBefore);
    expect(after.some((r) => r.symbol_name === "voidPayment")).toBe(true);
    expect(llm.embedCalls.slice(embedsBefore)).toHaveLength(1);
  });

  it("a failure in the middle of the transaction rolls everything back", async () => {
    await run();
    const snapshot = async () => ({
      chunks: (await pg.pool.query("SELECT id, file_path, symbol_name, commit_sha FROM chunks WHERE repo_id = 'sample-repo' ORDER BY id"))
        .rows,
      deps: (await pg.pool.query("SELECT file_path, imports_file_path FROM dependencies WHERE repo_id = 'sample-repo' ORDER BY 1, 2")).rows,
    });
    const before = await snapshot();

    // The embeddings API "succeeds" but returns a wrong-sized vector for the last chunk: Postgres rejects that INSERT after
    // the old chunks were already deleted inside the transaction. The rollback must bring them all back.
    const inner = createEmbedder({ mode: "mock", env: {} });
    const corrupting: Embedder = {
      mode: "mock",
      async embed(texts, inputType) {
        const result = await inner.embed(texts, inputType);
        result.vectors[result.vectors.length - 1] = [1, 2, 3];
        return result;
      },
    };
    setEmbedder(corrupting);

    const result = await run({ mode: "full" });
    expect(result.failedRepos).toEqual(["sample-repo"]);
    expect(result.runs[0]).toMatchObject({ status: "error" });
    expect(result.runs[0].error).toMatch(/dimension|expected 1024/i);
    expect(await snapshot()).toEqual(before);

    const { rows } = await pg.pool.query("SELECT status, error FROM repos WHERE id = 'sample-repo'");
    expect(rows[0].status).toBe("failed");
  });

  it("cascades: removing a repo removes its chunks, dependencies, links and runs", async () => {
    await run();
    await pg.pool.query("DELETE FROM repos WHERE id = 'sample-repo'");
    for (const table of ["chunks", "dependencies", "indexing_runs"]) {
      const { rows } = await pg.pool.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(rows[0].n, table).toBe(0);
    }
  });
});
