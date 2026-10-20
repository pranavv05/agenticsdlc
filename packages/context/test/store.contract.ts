import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMBEDDING_DIMENSIONS } from "../src/store/memory";
import type { ContextStore, StoredRepo } from "../src/store/types";
import type { ChunkRecord } from "../src/types";

const NOW = "2026-10-21T09:30:00.000Z";

export function repo(id: string, patch: Partial<StoredRepo> = {}): StoredRepo {
  return {
    id,
    name: `Repo ${id}`,
    source: { type: "path", value: `/work/${id}` },
    localPath: `/work/${id}`,
    status: "profiled",
    profile: null,
    indexStrategy: null,
    indexedCommitSha: null,
    indexedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  };
}

/** A unit vector with a 1 at `axis` (so cosine similarity between different axes is 0). */
export function axis(i: number, extra: Record<number, number> = {}): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  v[i] = 1;
  for (const [k, x] of Object.entries(extra)) v[Number(k)] = x;
  return v;
}

export function chunk(repoId: string, filePath: string, patch: Partial<ChunkRecord> = {}): ChunkRecord {
  return {
    repoId,
    filePath,
    symbolName: filePath.split("/").pop()!.replace(/\..*$/, ""),
    chunkType: "function",
    code: `// ${filePath}`,
    startLine: 1,
    endLine: 3,
    commitSha: "aaa111",
    ...patch,
  };
}

/** The behaviour every ContextStore must have. Run against the in-memory store and, when a database is available, Postgres. */
export function describeStoreContract(
  label: string,
  setup: () => Promise<{ store: ContextStore; cleanup(): Promise<void> }>,
  options: { skip?: boolean } = {},
) {
  describe.skipIf(options.skip)(`ContextStore contract: ${label}`, () => {
    let store: ContextStore;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      ({ store, cleanup } = await setup());
      await store.saveRepo(repo("alpha"));
      await store.saveRepo(repo("beta", { createdAt: "2026-10-22T00:00:00.000Z" }));
    });
    afterEach(async () => {
      await cleanup();
    });

    describe("repos", () => {
      it("round-trips every field", async () => {
        const full = repo("gamma", {
          source: { type: "url", value: "https://example.com/gamma.git" },
          status: "indexed",
          profile: {
            totalFiles: 10,
            totalLoc: 500,
            languages: [{ language: "TypeScript", files: 10, loc: 500 }],
            recommendation: "claude-md-only",
            reason: "small",
          },
          indexStrategy: "claude-md-only",
          indexedCommitSha: "abc123",
          indexedAt: NOW,
          error: "an earlier failure",
        });
        await store.saveRepo(full);
        expect(await store.getRepo("gamma")).toEqual(full);
      });

      it("returns null for an unknown repo and lists newest first", async () => {
        expect(await store.getRepo("nope")).toBeNull();
        expect((await store.listRepos()).map((r) => r.id)).toEqual(["beta", "alpha"]);
      });

      it("saveRepo updates an existing repo", async () => {
        await store.saveRepo(repo("alpha", { status: "indexed", indexedCommitSha: "def456", updatedAt: "2026-10-23T00:00:00.000Z" }));
        const updated = await store.getRepo("alpha");
        expect(updated).toMatchObject({ status: "indexed", indexedCommitSha: "def456", updatedAt: "2026-10-23T00:00:00.000Z" });
        expect(await store.listRepos()).toHaveLength(2);
      });
    });

    describe("replaceIndex", () => {
      it("stores chunks and edges, keeps commit SHAs, and never returns embeddings from getChunks", async () => {
        await store.replaceIndex({
          repoId: "alpha",
          mode: "full",
          files: [],
          chunks: [
            chunk("alpha", "src/b.ts", { embedding: axis(1), commitSha: "sha-1" }),
            chunk("alpha", "src/a.ts", { startLine: 10, endLine: 20, commitSha: null }),
          ],
          edges: [{ filePath: "src/a.ts", importsFilePath: "src/b.ts" }],
        });
        const chunks = await store.getChunks("alpha");
        expect(chunks.map((c) => [c.filePath, c.startLine, c.commitSha])).toEqual([
          ["src/a.ts", 10, null],
          ["src/b.ts", 1, "sha-1"],
        ]);
        expect(chunks[0]).not.toHaveProperty("embedding");
        expect(await store.countChunks("alpha")).toBe(2);
        expect(await store.getEdges("alpha")).toEqual([{ filePath: "src/a.ts", importsFilePath: "src/b.ts" }]);
        expect(await store.countChunks("beta")).toBe(0);
      });

      it("full mode replaces every chunk of the repo and leaves other repos alone", async () => {
        await store.replaceIndex({ repoId: "alpha", mode: "full", files: [], chunks: [chunk("alpha", "old.ts")], edges: [] });
        await store.replaceIndex({ repoId: "beta", mode: "full", files: [], chunks: [chunk("beta", "keep.ts")], edges: [] });
        await store.replaceIndex({ repoId: "alpha", mode: "full", files: [], chunks: [chunk("alpha", "new.ts")], edges: null });
        expect((await store.getChunks("alpha")).map((c) => c.filePath)).toEqual(["new.ts"]);
        expect((await store.getChunks("beta")).map((c) => c.filePath)).toEqual(["keep.ts"]);
      });

      it("incremental mode removes only the listed files and adds the new chunks", async () => {
        await store.replaceIndex({
          repoId: "alpha",
          mode: "full",
          files: [],
          chunks: [chunk("alpha", "a.ts"), chunk("alpha", "b.ts"), chunk("alpha", "c.ts")],
          edges: [{ filePath: "a.ts", importsFilePath: "b.ts" }],
        });
        const before = await store.getChunks("alpha", { files: ["a.ts"] });
        await store.replaceIndex({
          repoId: "alpha",
          mode: "incremental",
          files: ["b.ts", "c.ts"], // b modified, c deleted
          chunks: [chunk("alpha", "b.ts", { symbolName: "bNew", commitSha: "sha-2" }), chunk("alpha", "d.ts", { commitSha: "sha-2" })],
          edges: null, // untouched
        });
        const after = await store.getChunks("alpha");
        expect(after.map((c) => [c.filePath, c.symbolName])).toEqual([
          ["a.ts", "a"],
          ["b.ts", "bNew"],
          ["d.ts", "d"],
        ]);
        // the unchanged file's chunk is the very same row
        expect((await store.getChunks("alpha", { files: ["a.ts"] }))[0].id).toBe(before[0].id);
        expect(await store.getEdges("alpha")).toEqual([{ filePath: "a.ts", importsFilePath: "b.ts" }]);
      });

      it("replaces the edges only when edges are given", async () => {
        await store.replaceIndex({
          repoId: "alpha",
          mode: "full",
          files: [],
          chunks: [],
          edges: [{ filePath: "a.ts", importsFilePath: "b.ts" }],
        });
        await store.replaceIndex({ repoId: "alpha", mode: "incremental", files: [], chunks: [], edges: null });
        expect(await store.getEdges("alpha")).toHaveLength(1);
        await store.replaceIndex({ repoId: "alpha", mode: "incremental", files: [], chunks: [], edges: [] });
        expect(await store.getEdges("alpha")).toEqual([]);
      });

      it("handles a large batch", async () => {
        const chunks = Array.from({ length: 450 }, (_, i) =>
          chunk("alpha", `f${String(i).padStart(3, "0")}.ts`, { embedding: axis(i % 100) }),
        );
        await store.replaceIndex({ repoId: "alpha", mode: "full", files: [], chunks, edges: [] });
        expect(await store.countChunks("alpha")).toBe(450);
      });
    });

    describe("a failed replaceIndex changes nothing (a failed index must not wipe the previous good one)", () => {
      const seed = async () => {
        await store.replaceIndex({
          repoId: "alpha",
          mode: "full",
          files: [],
          chunks: [chunk("alpha", "good-1.ts", { embedding: axis(1) }), chunk("alpha", "good-2.ts", { embedding: axis(2) })],
          edges: [{ filePath: "good-1.ts", importsFilePath: "good-2.ts" }],
        });
      };
      const snapshot = async () => ({
        chunks: (await store.getChunks("alpha")).map((c) => [c.id, c.filePath]),
        edges: await store.getEdges("alpha"),
      });

      it("rejects a wrong embedding dimension in the middle of a batch, in full mode", async () => {
        await seed();
        const before = await snapshot();
        await expect(
          store.replaceIndex({
            repoId: "alpha",
            mode: "full",
            files: [],
            chunks: [chunk("alpha", "new-1.ts", { embedding: axis(3) }), chunk("alpha", "bad.ts", { embedding: [1, 2, 3] })],
            edges: [{ filePath: "new-1.ts", importsFilePath: "bad.ts" }],
          }),
        ).rejects.toThrow();
        expect(await snapshot()).toEqual(before);
      });

      it("rejects an invalid chunk in incremental mode and keeps the files it was about to remove", async () => {
        await seed();
        const before = await snapshot();
        await expect(
          store.replaceIndex({
            repoId: "alpha",
            mode: "incremental",
            files: ["good-1.ts"],
            chunks: [chunk("alpha", "x.ts", { chunkType: "nonsense" as never })],
            edges: [],
          }),
        ).rejects.toThrow();
        expect(await snapshot()).toEqual(before);
      });

      it("rejects an unknown repo and a chunk that belongs to another repo", async () => {
        await seed();
        const before = await snapshot();
        await expect(
          store.replaceIndex({ repoId: "missing", mode: "full", files: [], chunks: [chunk("missing", "a.ts")], edges: [] }),
        ).rejects.toThrow();
        await expect(
          store.replaceIndex({ repoId: "alpha", mode: "full", files: [], chunks: [chunk("beta", "a.ts")], edges: [] }),
        ).rejects.toThrow();
        expect(await snapshot()).toEqual(before);
      });
    });

    describe("searchSimilar", () => {
      beforeEach(async () => {
        await store.replaceIndex({
          repoId: "alpha",
          mode: "full",
          files: [],
          chunks: [
            chunk("alpha", "close.ts", { embedding: axis(0, { 1: 0.1 }) }),
            chunk("alpha", "far.ts", { embedding: axis(2) }),
            chunk("alpha", "mid.ts", { embedding: axis(0, { 1: 1 }) }),
            chunk("alpha", "none.ts"), // no embedding: never returned
          ],
          edges: [],
        });
        await store.replaceIndex({
          repoId: "beta",
          mode: "full",
          files: [],
          chunks: [chunk("beta", "other.ts", { embedding: axis(0) })],
          edges: [],
        });
      });

      it("orders by cosine similarity and reports the score", async () => {
        const hits = await store.searchSimilar({ repoIds: ["alpha"], vector: axis(0), limit: 10 });
        expect(hits.map((h) => h.filePath)).toEqual(["close.ts", "mid.ts", "far.ts"]);
        expect(hits[0].score).toBeGreaterThan(0.99);
        expect(hits[1].score).toBeCloseTo(Math.SQRT1_2, 3);
        expect(hits[2].score).toBeCloseTo(0, 5);
        expect(hits[0]).not.toHaveProperty("embedding");
      });

      it("applies the limit and the repo filter", async () => {
        expect((await store.searchSimilar({ repoIds: ["alpha"], vector: axis(0), limit: 1 })).map((h) => h.filePath)).toEqual(["close.ts"]);
        expect((await store.searchSimilar({ repoIds: ["beta"], vector: axis(0), limit: 5 })).map((h) => h.filePath)).toEqual(["other.ts"]);
        const both = await store.searchSimilar({ repoIds: ["alpha", "beta"], vector: axis(0), limit: 5 });
        expect(new Set(both.map((h) => h.repoId))).toEqual(new Set(["alpha", "beta"]));
        expect(await store.searchSimilar({ repoIds: [], vector: axis(0), limit: 5 })).toEqual([]);
      });
    });

    describe("getNeighbourFiles", () => {
      it("returns files one hop away in each direction, excluding the starting files", async () => {
        await store.replaceIndex({
          repoId: "alpha",
          mode: "full",
          files: [],
          chunks: [],
          edges: [
            { filePath: "a.ts", importsFilePath: "b.ts" },
            { filePath: "a.ts", importsFilePath: "c.ts" },
            { filePath: "d.ts", importsFilePath: "a.ts" },
            { filePath: "b.ts", importsFilePath: "e.ts" }, // two hops from a: not returned
            { filePath: "a.ts", importsFilePath: "x.ts" },
            { filePath: "x.ts", importsFilePath: "a.ts" }, // x is both an import and an importer of a
          ],
        });
        const neighbours = await store.getNeighbourFiles("alpha", ["a.ts"]);
        expect(neighbours.imports).toEqual(["b.ts", "c.ts", "x.ts"]);
        expect(neighbours.importedBy).toEqual(["d.ts", "x.ts"]);
        expect(await store.getNeighbourFiles("alpha", ["a.ts", "b.ts"])).toMatchObject({
          imports: ["c.ts", "e.ts", "x.ts"],
          importedBy: ["d.ts", "x.ts"],
        });
        expect(await store.getNeighbourFiles("alpha", ["nowhere.ts"])).toEqual({ imports: [], importedBy: [] });
        expect(await store.getNeighbourFiles("beta", ["a.ts"])).toEqual({ imports: [], importedBy: [] });
      });
    });

    describe("cross-repo links", () => {
      it("replaces the links that start at the given repos and keeps the others", async () => {
        await store.replaceCrossRepoLinks(
          ["alpha", "beta"],
          [
            { fromRepo: "alpha", toRepo: "beta", evidence: ["a.ts:1 mentions beta"] },
            { fromRepo: "beta", toRepo: "alpha", evidence: ["b.ts:2 mentions alpha"] },
          ],
        );
        await store.replaceCrossRepoLinks(["alpha"], [{ fromRepo: "alpha", toRepo: "beta", evidence: ["new evidence"] }]);
        expect(await store.getCrossRepoLinks()).toEqual([
          { fromRepo: "alpha", toRepo: "beta", evidence: ["new evidence"] },
          { fromRepo: "beta", toRepo: "alpha", evidence: ["b.ts:2 mentions alpha"] },
        ]);
        await store.replaceCrossRepoLinks(["alpha", "beta"], []);
        expect(await store.getCrossRepoLinks()).toEqual([]);
      });
    });

    describe("indexing runs", () => {
      it("creates, updates and reads runs", async () => {
        const run = await store.createRun({ repoId: "alpha", strategy: "full" });
        expect(run).toMatchObject({
          repoId: "alpha",
          status: "running",
          strategy: "full",
          mode: null,
          commitSha: null,
          fromCommitSha: null,
          progress: {},
          error: null,
          finishedAt: null,
        });
        expect(run.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

        const updated = await store.updateRun(run.id, {
          mode: "incremental",
          commitSha: "new",
          fromCommitSha: "old",
          progress: { chunks: { chunks: 12, complete: 1 } },
        });
        expect(updated).toMatchObject({
          mode: "incremental",
          commitSha: "new",
          fromCommitSha: "old",
          progress: { chunks: { chunks: 12, complete: 1 } },
          status: "running",
        });

        const done = await store.updateRun(run.id, { status: "done", finished: true });
        expect(done.status).toBe("done");
        expect(done.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(await store.getRun(run.id)).toEqual(done);
        expect(await store.getRun(999999)).toBeNull();
      });

      it("stores an error message and lists the latest run of each repo", async () => {
        const first = await store.createRun({ repoId: "alpha", strategy: "full" });
        await store.updateRun(first.id, { status: "error", error: "boom", finished: true });
        const second = await store.createRun({ repoId: "alpha", strategy: "claude-md-only" });
        const other = await store.createRun({ repoId: "beta", strategy: "full" });
        const latest = await store.listLatestRuns();
        expect(latest.map((r) => [r.repoId, r.id])).toEqual([
          ["alpha", second.id],
          ["beta", other.id],
        ]);
        expect((await store.getRun(first.id))?.error).toBe("boom");
      });

      it("rejects runs for unknown repos and updates to unknown runs", async () => {
        await expect(store.createRun({ repoId: "missing", strategy: "full" })).rejects.toThrow();
        await expect(store.updateRun(424242, { status: "done" })).rejects.toThrow();
      });
    });
  });
}
