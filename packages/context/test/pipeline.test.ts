import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexRepo, indexRepos } from "../src/pipeline";
import { MemoryContextStore } from "../src/store/memory";
import type { IndexOptions } from "../src/pipeline";
import type { ProgressStage, RepoTarget } from "../src/types";
import { GENERATED_CLAUDE_MD } from "../src/walk";
import { installMockLlm, type MockLlm } from "./helpers/llm";
import { FIXTURES, commitAll, copyFixture, git, head, rmrf, tmpDir, write } from "./helpers/repos";

let llm: MockLlm;
let store: MemoryContextStore;
let outputRoot: string;
const cleanup: string[] = [];

beforeEach(() => {
  llm = installMockLlm();
  store = new MemoryContextStore();
  outputRoot = tmpDir("sdd-out-");
  cleanup.push(outputRoot);
});
afterEach(() => {
  llm.restore();
  cleanup.splice(0).forEach(rmrf);
});

/** A throwaway git copy of the sample repo, padded with a few extra files so that changing one or two stays under the 30% limit. */
function sampleRepo(options: { git?: boolean } = {}): { dir: string; target: RepoTarget } {
  const dir = copyFixture("sample-repo", { git: false });
  for (let i = 1; i <= 4; i++) write(dir, `extras/e${i}.ts`, `export function extra${i}(): number {\n  return ${i};\n}\n`);
  if (options.git !== false) {
    git(dir, "init", "-q", "-b", "main");
    commitAll(dir, "initial");
  }
  cleanup.push(path.dirname(dir));
  return { dir, target: { id: "sample", name: "Sample", path: dir } };
}

const run = (target: RepoTarget, extra: Partial<IndexOptions> = {}) => indexRepo(target, { store, outputRoot, ...extra });
const docFile = (repoId: string, rel: string) => path.join(outputRoot, repoId, "docs", ...rel.split("/"));
const promptCount = (name: string) => llm.prompts.filter((p) => p.name === name).length;
const filesOf = async (id: string) => [...new Set((await store.getChunks(id)).map((c) => c.filePath))].sort();

describe("first index", () => {
  it("chunks, embeds, records the commit, and writes docs OUTSIDE the repo", async () => {
    const { dir, target } = sampleRepo();
    const sha = head(dir);
    const result = await run(target);

    expect(result.failedRepos).toEqual([]);
    expect(result.plans.sample).toMatchObject({ kind: "full", reason: "first index" });

    const chunks = await store.getChunks("sample");
    expect(chunks.length).toBeGreaterThan(8);
    expect(chunks.every((c) => c.commitSha === sha)).toBe(true);
    expect(await filesOf("sample")).toContain("modules/billing/payments.ts");
    expect((await store.getEdges("sample")).length).toBeGreaterThan(0);

    const repo = await store.getRepo("sample");
    expect(repo).toMatchObject({ status: "indexed", indexStrategy: "full", indexedCommitSha: sha, localPath: dir });
    expect(repo?.indexedAt).toMatch(/^\d{4}/);
    expect(repo).not.toHaveProperty("error", expect.anything());

    // docs and mind maps are under outputRoot, mirroring the repo tree
    for (const rel of [GENERATED_CLAUDE_MD, `modules/auth/${GENERATED_CLAUDE_MD}`, `modules/billing/${GENERATED_CLAUDE_MD}`]) {
      expect(fs.existsSync(docFile("sample", rel)), rel).toBe(true);
    }
    expect(fs.existsSync(path.join(outputRoot, "sample", "mindmap.md"))).toBe(true);
    expect(fs.existsSync(path.join(outputRoot, "system.md"))).toBe(true);

    // ...and the working tree is exactly as it was: nothing generated inside the repo, nothing to commit
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(fs.existsSync(path.join(dir, GENERATED_CLAUDE_MD))).toBe(false);
  });

  it("records the run: mode, commit and per-stage progress", async () => {
    const { dir, target } = sampleRepo();
    const { runs } = await run(target);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      repoId: "sample",
      status: "done",
      mode: "full",
      commitSha: head(dir),
      fromCommitSha: null,
      error: null,
    });
    expect(runs[0].finishedAt).not.toBeNull();
    expect(Object.keys(runs[0].progress)).toEqual(
      expect.arrayContaining(["files", "plan", "chunks", "dependencies", "embeddings", "claude_md", "mindmap", "done"]),
    );
    expect(runs[0].progress.plan).toMatchObject({ kind: "full" });
  });

  it("reports progress stages in order", async () => {
    const { target } = sampleRepo();
    const seen: ProgressStage[] = [];
    await run(target, { onProgress: (repoId, stage) => void (repoId === "sample" && !seen.includes(stage) && seen.push(stage)) });
    expect(seen).toEqual(["files", "plan", "chunks", "dependencies", "embeddings", "claude_md", "mindmap", "done"]);
  });

  it("indexes a plain folder that is not a git repo, with no commit recorded, and rebuilds every time", async () => {
    const dir = copyFixture("sample-repo", { git: false });
    cleanup.push(path.dirname(dir));
    const target = { id: "plain", name: "Plain", path: dir };
    const first = await run(target);
    expect((await store.getChunks("plain")).every((c) => c.commitSha === null)).toBe(true);
    expect((await store.getRepo("plain"))?.indexedCommitSha).toBeNull();
    expect(first.plans.plain.kind).toBe("full");

    const second = await run(target);
    expect(second.plans.plain).toMatchObject({ kind: "full", reason: expect.stringMatching(/not a git repository/) });
  });

  it("does not mistake a folder inside another repository for a repo of its own, and writes nothing into it", async () => {
    // a copy of the fixture placed inside a different git repository, like the fixtures that live in this monorepo
    const outer = tmpDir("sdd-outer-");
    cleanup.push(outer);
    git(outer, "init", "-q", "-b", "main");
    write(outer, "outer.txt", "the outer repository");
    const inner = path.join(outer, "inner");
    fs.cpSync(path.join(FIXTURES, "sample-repo"), inner, { recursive: true });
    commitAll(outer, "outer repo with an inner folder");
    const outerStatus = git(outer, "status", "--porcelain");

    const result = await run({ id: "nested", name: "Nested", path: inner });
    expect(result.failedRepos).toEqual([]);
    expect((await store.getChunks("nested")).every((c) => c.commitSha === null)).toBe(true);
    expect((await store.getRepo("nested"))?.indexedCommitSha).toBeNull();
    expect(git(outer, "status", "--porcelain")).toBe(outerStatus); // nothing was written anywhere inside the outer repo
    expect(fs.existsSync(path.join(inner, GENERATED_CLAUDE_MD))).toBe(false);
  });
});

describe("re-indexing an unchanged repo", () => {
  it("skips: no embeddings, no model calls, nothing rewritten", async () => {
    const { dir, target } = sampleRepo();
    await run(target);
    const embeds = llm.embedCalls.length;
    const prompts = llm.prompts.length;
    const usage = llm.usage.length;
    const mtime = fs.statSync(docFile("sample", GENERATED_CLAUDE_MD)).mtimeMs;

    const result = await run(target);
    expect(result.plans.sample).toMatchObject({ kind: "skip" });
    expect(llm.embedCalls.length).toBe(embeds);
    expect(llm.prompts.length).toBe(prompts);
    expect(llm.usage.length).toBe(usage);
    expect(fs.statSync(docFile("sample", GENERATED_CLAUDE_MD)).mtimeMs).toBe(mtime);
    expect(result.runs[0]).toMatchObject({ status: "done", mode: null });
    expect(await store.getRepo("sample")).toMatchObject({ status: "indexed", indexedCommitSha: head(dir) });
  });

  it("rebuilds everything when asked to", async () => {
    const { target } = sampleRepo();
    await run(target);
    const chunkCount = await store.countChunks("sample");
    const before = llm.embedCalls.reduce((a, b) => a + b, 0);
    const result = await run(target, { mode: "full" });
    expect(result.plans.sample).toMatchObject({ kind: "full", reason: "full rebuild requested" });
    expect(llm.embedCalls.reduce((a, b) => a + b, 0) - before).toBe(chunkCount);
  });

  it("rebuilds when the generated docs have gone missing", async () => {
    const { target } = sampleRepo();
    await run(target);
    rmrf(path.join(outputRoot, "sample"));
    const result = await run(target);
    expect(result.plans.sample).toMatchObject({ kind: "full", reason: "generated docs are missing" });
    expect(fs.existsSync(docFile("sample", GENERATED_CLAUDE_MD))).toBe(true);
  });
});

describe("incremental re-indexing", () => {
  it("re-embeds only the changed file and rewrites only the docs of its module", async () => {
    const { dir, target } = sampleRepo();
    await run(target);
    const firstSha = head(dir);
    const before = await store.getChunks("sample");
    const untouchedIds = before.filter((c) => c.filePath !== "modules/billing/payments.ts").map((c) => [c.id, c.filePath]);
    const authDocTime = fs.statSync(docFile("sample", `modules/auth/${GENERATED_CLAUDE_MD}`)).mtimeMs;
    const embedsBefore = llm.embedCalls.length;
    const moduleDocsBefore = promptCount("module-claude-md");

    write(
      dir,
      "modules/billing/payments.ts",
      fs.readFileSync(path.join(dir, "modules/billing/payments.ts"), "utf8") + "\nexport function voidPayment(): void {}\n",
    );
    const secondSha = commitAll(dir, "add voidPayment");

    const result = await run(target);
    expect(result.plans.sample.kind).toBe("incremental");

    // exactly one embedding call, for the chunks of the changed file only
    const changedChunks = (await store.getChunks("sample", { files: ["modules/billing/payments.ts"] })).length;
    expect(llm.embedCalls.slice(embedsBefore)).toEqual([changedChunks]);
    expect(changedChunks).toBeGreaterThan(before.filter((c) => c.filePath === "modules/billing/payments.ts").length - 1);

    // every other chunk is the very same row, still stamped with the first commit
    const after = await store.getChunks("sample");
    expect(after.filter((c) => c.filePath !== "modules/billing/payments.ts").map((c) => [c.id, c.filePath])).toEqual(untouchedIds);
    expect(after.filter((c) => c.filePath !== "modules/billing/payments.ts").every((c) => c.commitSha === firstSha)).toBe(true);
    expect(after.filter((c) => c.filePath === "modules/billing/payments.ts").every((c) => c.commitSha === secondSha)).toBe(true);
    expect(after.some((c) => c.symbolName === "voidPayment")).toBe(true);

    // only the billing module doc was regenerated (plus the root doc and mind map, which list every module)
    expect(promptCount("module-claude-md") - moduleDocsBefore).toBe(1);
    expect(fs.statSync(docFile("sample", `modules/auth/${GENERATED_CLAUDE_MD}`)).mtimeMs).toBe(authDocTime);

    expect(await store.getRepo("sample")).toMatchObject({ status: "indexed", indexedCommitSha: secondSha });
    expect(result.runs[0]).toMatchObject({ mode: "incremental", commitSha: secondSha, fromCommitSha: firstSha, status: "done" });
  });

  it("removes the chunks and edges of a deleted file", async () => {
    const { dir, target } = sampleRepo();
    await run(target);
    expect((await store.getEdges("sample")).some((e) => e.importsFilePath === "modules/auth/tokens.ts")).toBe(true);

    fs.rmSync(path.join(dir, "modules/auth/tokens.ts"));
    commitAll(dir, "delete tokens");
    const embedsBefore = llm.embedCalls.length;
    const result = await run(target);

    expect(result.plans.sample.kind).toBe("incremental");
    expect(llm.embedCalls.length).toBe(embedsBefore); // nothing to embed
    expect(await filesOf("sample")).not.toContain("modules/auth/tokens.ts");
    expect((await store.getEdges("sample")).some((e) => e.importsFilePath === "modules/auth/tokens.ts")).toBe(false);
  });

  it("treats a rename as removing the old path and embedding the new one", async () => {
    const { dir, target } = sampleRepo();
    await run(target);
    git(dir, "mv", "modules/auth/password.ts", "modules/auth/passwords.ts");
    commitAll(dir, "rename");
    const embedsBefore = llm.embedCalls.length;
    const result = await run(target);

    expect(result.plans.sample.kind).toBe("incremental");
    const files = await filesOf("sample");
    expect(files).toContain("modules/auth/passwords.ts");
    expect(files).not.toContain("modules/auth/password.ts");
    expect(llm.embedCalls.slice(embedsBefore)).toEqual([
      (await store.getChunks("sample", { files: ["modules/auth/passwords.ts"] })).length,
    ]);
  });

  it("ends up identical to a full rebuild of the same commit", async () => {
    const a = sampleRepo();
    await run(a.target);
    write(
      a.dir,
      "modules/billing/invoice.ts",
      fs.readFileSync(path.join(a.dir, "modules/billing/invoice.ts"), "utf8") + "\nexport const TAX = 0.2;\n",
    );
    write(a.dir, "extras/e5.ts", "export const five = 5;\n");
    fs.rmSync(path.join(a.dir, "extras/e1.ts"));
    commitAll(a.dir, "several edits");
    await run(a.target); // incremental
    const incremental = (await store.getChunks("sample")).map(({ id: _id, ...c }) => c);

    const fresh = new MemoryContextStore();
    await indexRepo(a.target, { store: fresh, outputRoot: tmpDir("sdd-out2-"), mode: "full" });
    const rebuilt = (await fresh.getChunks("sample")).map(({ id: _id, ...c }) => c);

    const strip = (cs: typeof incremental) => cs.map((c) => ({ ...c, commitSha: undefined }));
    expect(strip(incremental)).toEqual(strip(rebuilt));
    expect(await store.getEdges("sample")).toEqual(await fresh.getEdges("sample"));
  });

  it("falls back to a full rebuild when too much changed", async () => {
    const { dir, target } = sampleRepo();
    await run(target);
    for (const f of ["extras/e1.ts", "extras/e2.ts", "extras/e3.ts", "modules/auth/tokens.ts"])
      write(dir, f, `export const changed = "${f}";\n`);
    commitAll(dir, "big change");
    const result = await run(target);
    expect(result.plans.sample).toMatchObject({ kind: "full", reason: expect.stringMatching(/over 30%/) });
  });

  it("repairs an empty index instead of trusting the diff", async () => {
    const { dir, target } = sampleRepo();
    await run(target);
    await store.replaceIndex({ repoId: "sample", mode: "full", files: [], chunks: [], edges: [] });
    write(dir, "extras/e1.ts", "export const changed = true;\n");
    commitAll(dir, "tiny change");
    const result = await run(target);
    expect(result.plans.sample).toMatchObject({ kind: "full", reason: "the stored index is empty" });
    expect(await store.countChunks("sample")).toBeGreaterThan(8);
  });

  it("removes docs of modules that no longer exist when it rebuilds", async () => {
    const { dir, target } = sampleRepo();
    await run(target);
    expect(fs.existsSync(docFile("sample", `modules/auth/${GENERATED_CLAUDE_MD}`))).toBe(true);
    fs.rmSync(path.join(dir, "modules/auth"), { recursive: true });
    commitAll(dir, "drop auth");
    await run(target, { mode: "full" });
    expect(fs.existsSync(docFile("sample", `modules/auth/${GENERATED_CLAUDE_MD}`))).toBe(false);
    expect(fs.existsSync(docFile("sample", `modules/billing/${GENERATED_CLAUDE_MD}`))).toBe(true);
  });
});

describe("uncommitted changes", () => {
  it("indexes a dirty working tree as a full rebuild stamped +dirty, and rebuilds again once committed", async () => {
    const { dir, target } = sampleRepo();
    await run(target);
    const clean = head(dir);

    write(dir, "extras/e1.ts", "export const wip = true;\n");
    const dirty = await run(target);
    expect(dirty.plans.sample).toMatchObject({ kind: "full", reason: expect.stringMatching(/uncommitted/) });
    expect((await store.getRepo("sample"))?.indexedCommitSha).toBe(`${clean}+dirty`);
    expect((await store.getChunks("sample")).every((c) => c.commitSha === `${clean}+dirty`)).toBe(true);

    const committed = commitAll(dir, "commit the wip");
    const after = await run(target);
    expect(after.plans.sample).toMatchObject({ kind: "full", reason: expect.stringMatching(/previous run indexed uncommitted/) });
    expect((await store.getRepo("sample"))?.indexedCommitSha).toBe(committed);

    expect((await run(target)).plans.sample.kind).toBe("skip");
  });
});

describe("a failed index never wipes the previous good one", () => {
  async function indexedThenChanged() {
    const s = sampleRepo();
    await run(s.target);
    const firstSha = head(s.dir);
    const snapshot = {
      chunks: (await store.getChunks("sample")).map((c) => [c.id, c.filePath, c.symbolName, c.commitSha]),
      edges: await store.getEdges("sample"),
      rootDoc: fs.readFileSync(docFile("sample", GENERATED_CLAUDE_MD), "utf8"),
    };
    write(
      s.dir,
      "modules/billing/payments.ts",
      fs.readFileSync(path.join(s.dir, "modules/billing/payments.ts"), "utf8") + "\nexport function extraPayment(): void {}\n",
    );
    const secondSha = commitAll(s.dir, "change");
    return { ...s, firstSha, secondSha, snapshot };
  }

  it("when embedding fails: chunks, edges and docs stay as they were, the run and repo say what happened", async () => {
    const { target, firstSha, snapshot } = await indexedThenChanged();
    llm.failEmbeddings(new Error("Voyage is down"));
    const result = await run(target);

    expect(result.failedRepos).toEqual(["sample"]);
    expect((await store.getChunks("sample")).map((c) => [c.id, c.filePath, c.symbolName, c.commitSha])).toEqual(snapshot.chunks);
    expect(await store.getEdges("sample")).toEqual(snapshot.edges);
    expect(fs.readFileSync(docFile("sample", GENERATED_CLAUDE_MD), "utf8")).toBe(snapshot.rootDoc);

    expect(await store.getRepo("sample")).toMatchObject({ status: "failed", error: "Voyage is down", indexedCommitSha: firstSha });
    expect(result.runs[0]).toMatchObject({ status: "error", error: "Voyage is down" });
    expect(result.runs[0].finishedAt).not.toBeNull();
  });

  it("recovers on the next run, patching from the last good commit", async () => {
    const { target, firstSha, secondSha } = await indexedThenChanged();
    llm.failEmbeddings();
    await run(target);
    llm.heal();

    const retry = await run(target);
    expect(retry.failedRepos).toEqual([]);
    expect(retry.runs[0]).toMatchObject({ mode: "incremental", fromCommitSha: firstSha, commitSha: secondSha });
    expect(await store.getRepo("sample")).toMatchObject({ status: "indexed", indexedCommitSha: secondSha });
    expect((await store.getRepo("sample"))?.error).toBeUndefined();
    expect((await store.getChunks("sample")).some((c) => c.symbolName === "extraPayment")).toBe(true);
  });

  it("when the documentation step fails after the index was written: old docs are kept and the repo is marked failed", async () => {
    const { target, firstSha, snapshot } = await indexedThenChanged();
    llm.failDocs(new Error("model overloaded"));
    const result = await run(target);

    expect(result.failedRepos).toEqual(["sample"]);
    expect(fs.readFileSync(docFile("sample", GENERATED_CLAUDE_MD), "utf8")).toBe(snapshot.rootDoc);
    // the new chunks are committed (they are valid), but the repo's recorded commit stays at the last fully successful run
    expect((await store.getChunks("sample")).some((c) => c.symbolName === "extraPayment")).toBe(true);
    expect(await store.getRepo("sample")).toMatchObject({ status: "failed", error: "model overloaded", indexedCommitSha: firstSha });
  });

  it("one failing repo does not stop the others", async () => {
    const good = sampleRepo();
    const missing = { id: "ghost", name: "Ghost", path: path.join(tmpDir(), "does-not-exist") };
    cleanup.push(path.dirname(missing.path));
    const result = await indexRepos([missing, good.target], { store, outputRoot });
    expect(result.failedRepos).toEqual(["ghost"]);
    expect(await store.getRepo("ghost")).toMatchObject({ status: "failed", error: expect.stringMatching(/not usable/) });
    expect(await store.getRepo("sample")).toMatchObject({ status: "indexed" });
    expect(result.runs.map((r) => [r.repoId, r.status])).toEqual([
      ["ghost", "error"],
      ["sample", "done"],
    ]);
  });
});

describe("strategy: claude-md-only", () => {
  it("writes docs and a mind map but stores and embeds nothing", async () => {
    const { dir, target } = sampleRepo();
    const result = await run(target, { strategy: "claude-md-only" });
    expect(result.failedRepos).toEqual([]);
    expect(await store.countChunks("sample")).toBe(0);
    expect(await store.getEdges("sample")).toEqual([]);
    expect(llm.embedCalls).toEqual([]);
    expect(fs.existsSync(docFile("sample", `modules/billing/${GENERATED_CLAUDE_MD}`))).toBe(true);
    expect(await store.getRepo("sample")).toMatchObject({
      status: "indexed",
      indexStrategy: "claude-md-only",
      indexedCommitSha: head(dir),
    });
  });

  it("uses the profile's recommendation when no strategy is given", async () => {
    const { target } = sampleRepo();
    await store.saveRepo({
      id: "sample",
      name: "Sample",
      source: { type: "path", value: target.path },
      localPath: target.path,
      status: "profiled",
      profile: { totalFiles: 10, totalLoc: 100, languages: [], recommendation: "claude-md-only", reason: "small" },
      indexStrategy: null,
      indexedCommitSha: null,
      indexedAt: null,
      createdAt: "2026-10-21T09:30:00.000Z",
      updatedAt: "2026-10-21T09:30:00.000Z",
    });
    await run(target);
    expect(await store.countChunks("sample")).toBe(0);
    expect((await store.getRepo("sample"))?.indexStrategy).toBe("claude-md-only");
  });

  it("switching to the full strategy rebuilds, and switching back drops the stored chunks", async () => {
    const { target } = sampleRepo();
    await run(target, { strategy: "claude-md-only" });
    const toFull = await run(target, { strategy: "full" });
    expect(toFull.plans.sample).toMatchObject({
      kind: "full",
      reason: expect.stringMatching(/strategy changed from claude-md-only to full/),
    });
    expect(await store.countChunks("sample")).toBeGreaterThan(8);

    await run(target, { strategy: "claude-md-only" });
    expect(await store.countChunks("sample")).toBe(0);
    expect(await store.getEdges("sample")).toEqual([]);
  });
});

describe("several repos", () => {
  it("finds cross-repo links, writes the system mind map and keeps repos separate", async () => {
    const api = sampleRepo();
    const web = copyFixture("sample-repo");
    cleanup.push(path.dirname(web));
    write(web, "config/services.json", JSON.stringify({ billingApi: "http://billing-api:8080" }));
    commitAll(web, "reference the api");

    const targets: RepoTarget[] = [
      { id: "billing-api", name: "billing-api", path: api.dir },
      { id: "web-app", name: "web-app", path: web },
    ];
    const result = await indexRepos(targets, { store, outputRoot });

    expect(result.failedRepos).toEqual([]);
    const links = await store.getCrossRepoLinks();
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ fromRepo: "web-app", toRepo: "billing-api" });
    expect(links[0].evidence[0]).toContain("config/services.json");

    expect(fs.readFileSync(path.join(outputRoot, "system.md"), "utf8")).toContain("mermaid");
    expect((await store.getChunks("billing-api")).every((c) => c.repoId === "billing-api")).toBe(true);
    expect((await store.getChunks("web-app")).every((c) => c.repoId === "web-app")).toBe(true);
    for (const id of ["billing-api", "web-app"]) expect(fs.existsSync(path.join(outputRoot, id, "docs", GENERATED_CLAUDE_MD))).toBe(true);
  });
});
