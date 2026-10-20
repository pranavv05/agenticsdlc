import { RepoSchema } from "@sdd/contracts";
import fs from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepoContextProvider } from "../src/provider";
import { RegistryError, RepoRegistry, isRegistryError, type RepoRegistryOptions } from "../src/registry";
import { MemoryContextStore } from "../src/store/memory";
import { installMockLlm, type MockLlm } from "./helpers/llm";
import { FIXTURES, makeRemote, rmrf, tmpDir, write } from "./helpers/repos";

let llm: MockLlm;
let store: MemoryContextStore;
let cacheDir: string;
let outputRoot: string;
const cleanup: string[] = [];

beforeEach(() => {
  llm = installMockLlm();
  store = new MemoryContextStore();
  cacheDir = tmpDir("sdd-cache-");
  outputRoot = tmpDir("sdd-reg-out-");
  cleanup.push(cacheDir, outputRoot);
});
afterEach(() => {
  llm.restore();
  cleanup.splice(0).forEach(rmrf);
});

const registry = (extra: Partial<RepoRegistryOptions> = {}) =>
  new RepoRegistry({ store, cacheDir, clone: { allowedProtocols: ["file"] }, index: { outputRoot }, ...extra });

/** A local-path repo in its own folder (not a git repo), copied from a fixture. */
function localFixture(name = "sample-repo"): string {
  const dir = path.join(tmpDir("sdd-local-"), name);
  fs.cpSync(path.join(FIXTURES, name), dir, { recursive: true });
  cleanup.push(path.dirname(dir));
  return dir;
}
const remoteOf = (fixture = "sample-repo") => {
  const remote = makeRemote({ fixture });
  cleanup.push(path.dirname(remote.work));
  return remote;
};

describe("register", () => {
  it("returns at once with status profiling, then profiles the repo in the background", async () => {
    const reg = registry();
    const { repo, completion } = await reg.register({ name: "Sample Repo", source: { type: "path", value: localFixture() } });

    expect(repo).toMatchObject({
      id: "sample-repo",
      name: "Sample Repo",
      status: "profiling",
      profile: null,
      indexStrategy: null,
      indexedCommitSha: null,
    });
    expect(RepoSchema.safeParse(repo).success).toBe(true);

    const done = await completion;
    expect(done.status).toBe("profiled");
    expect(done.profile).toMatchObject({
      totalFiles: 8,
      totalLoc: 63,
      languages: [{ language: "TypeScript", files: 6, loc: 63 }],
      recommendation: "claude-md-only",
    });
    expect(await reg.get("sample-repo")).toEqual(done);
  });

  it("does not expose where the server keeps its working tree", async () => {
    const reg = registry();
    const dir = localFixture();
    const repo = await (await reg.register({ name: "x", source: { type: "path", value: dir } })).completion;
    expect(repo).not.toHaveProperty("localPath");
    expect((await store.getRepo("x"))?.localPath).toBe(path.resolve(dir)); // known internally, not part of the API shape

    // a URL repo lives in the server's cache folder; that location is never in the API output
    const remote = remoteOf();
    await (
      await reg.register({ name: "cloned", source: { type: "url", value: remote.url } })
    ).completion;
    const listed = JSON.stringify(await reg.list());
    expect(listed).not.toContain(path.basename(cacheDir));
    expect(listed).not.toContain("localPath");
  });

  it("registers a repo by URL: clones it into the cache folder and profiles the clone", async () => {
    const remote = remoteOf();
    const reg = registry();
    const { completion } = await reg.register({ name: "From Url", source: { type: "url", value: remote.url } });
    const repo = await completion;
    expect(repo.status).toBe("profiled");
    expect(repo.profile?.languages).toEqual([{ language: "TypeScript", files: 6, loc: 63 }]);
    expect(fs.existsSync(path.join(cacheDir, "from-url", ".git"))).toBe(true);
    expect((await store.getRepo("from-url"))?.localPath).toBe(path.join(cacheDir, "from-url"));
  });

  it("derives the id from the name", async () => {
    const reg = registry();
    const dir = localFixture();
    expect((await reg.register({ name: "Billing Service (v2)!", source: { type: "path", value: dir } })).repo.id).toBe(
      "billing-service-v2",
    );
    expect((await reg.register({ name: "###", source: { type: "path", value: dir } })).repo.id).toBe("repo");
  });

  it("rejects a name that is already registered", async () => {
    const reg = registry();
    const dir = localFixture();
    await (
      await reg.register({ name: "dup", source: { type: "path", value: dir } })
    ).completion;
    await expect(reg.register({ name: "Dup", source: { type: "path", value: dir } })).rejects.toMatchObject({ code: "conflict" });
  });

  it("lets only one of two simultaneous registrations of the same name through", async () => {
    const reg = registry();
    const dir = localFixture();
    const results = await Promise.allSettled([1, 2, 3].map(() => reg.register({ name: "race", source: { type: "path", value: dir } })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason.code === "conflict")).toBe(true);
    await reg.idle();
    expect((await reg.list()).filter((r) => r.id === "race")).toHaveLength(1);
  });

  describe("validation happens up front, with the offending field", () => {
    it("a path that is not a directory", async () => {
      const reg = registry();
      const error = await reg
        .register({ name: "a", source: { type: "path", value: path.join(tmpDir(), "nope") } })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RegistryError);
      expect(error).toMatchObject({ code: "invalid", path: ["source", "value"] });
      const file = path.join(tmpDir("sdd-f-"), "f.txt");
      write(path.dirname(file), "f.txt", "x");
      cleanup.push(path.dirname(file));
      await expect(reg.register({ name: "b", source: { type: "path", value: file } })).rejects.toMatchObject({ code: "invalid" });
      expect(await store.listRepos()).toEqual([]); // nothing was saved
    });

    it("local paths when the server has them turned off", async () => {
      const reg = registry({ allowLocalPaths: false });
      await expect(reg.register({ name: "a", source: { type: "path", value: localFixture() } })).rejects.toMatchObject({
        code: "invalid",
        path: ["source", "type"],
      });
    });

    it.each([
      ["a file URL", "file:///etc/passwd"],
      ["credentials", "https://token@github.com/org/repo.git"],
      ["http", "http://github.com/org/repo.git"],
    ])("an unsafe URL: %s", async (_label, url) => {
      const reg = registry({ clone: {} });
      await expect(reg.register({ name: "u", source: { type: "url", value: url } })).rejects.toMatchObject({
        code: "invalid",
        path: ["source", "value"],
      });
      expect(await store.listRepos()).toEqual([]);
    });

    it("a host outside the allow-list", async () => {
      const reg = registry({ clone: { allowedHosts: ["github.com"] } });
      await expect(reg.register({ name: "u", source: { type: "url", value: "https://evil.example.com/o/r.git" } })).rejects.toMatchObject({
        code: "invalid",
      });
    });

    it("a request that does not match the schema", async () => {
      const reg = registry();
      await expect(reg.register({ name: "", source: { type: "path", value: "/x" } })).rejects.toBeInstanceOf(ZodError);
      await expect(reg.register({ name: "x", source: { type: "ftp", value: "y" } } as never)).rejects.toBeInstanceOf(ZodError);
    });
  });

  it("records a failure in the background as status failed with the reason, and never rejects", async () => {
    const reg = registry();
    const { repo, completion } = await reg.register({ name: "ghost", source: { type: "url", value: "file:///definitely/not/here.git" } });
    expect(repo.status).toBe("profiling");
    const done = await completion;
    expect(done.status).toBe("failed");
    expect(done.error).toBeTruthy();
    expect(done.profile).toBeNull();
    expect((await reg.get("ghost")).status).toBe("failed");
  });
});

describe("reads", () => {
  it("get throws not_found for an unknown repo; list is newest first", async () => {
    const reg = registry();
    await expect(reg.get("nope")).rejects.toMatchObject({ code: "not_found" });
    expect(await reg.list()).toEqual([]);
    const dir = localFixture();
    let tick = 0;
    const timed = registry({ now: () => new Date(Date.UTC(2026, 9, 21, 9, tick++)) });
    await (
      await timed.register({ name: "first", source: { type: "path", value: dir } })
    ).completion;
    await (
      await timed.register({ name: "second", source: { type: "path", value: dir } })
    ).completion;
    expect((await timed.list()).map((r) => r.id)).toEqual(["second", "first"]);
    expect((await timed.list()).every((r) => RepoSchema.safeParse(r).success)).toBe(true);
  });
});

describe("startIndexing", () => {
  async function registered(reg: RepoRegistry, name = "sample") {
    await (
      await reg.register({ name, source: { type: "path", value: localFixture() } })
    ).completion;
    return name;
  }

  it("indexes with the profile's recommended strategy (small repo: claude-md-only) and ends indexed", async () => {
    const reg = registry();
    const id = await registered(reg);
    const { repo, completion } = await reg.startIndexing(id);
    expect(repo.status).toBe("indexing");
    const done = await completion;
    expect(done).toMatchObject({ status: "indexed", indexStrategy: "claude-md-only" });
    expect(done.indexedAt).toBeTruthy();
    expect(await store.countChunks(id)).toBe(0);
    expect(fs.existsSync(path.join(outputRoot, id, "docs", "CLAUDE.md.generated.md"))).toBe(true);
  });

  it("honours an explicit strategy over the recommendation", async () => {
    const reg = registry();
    const id = await registered(reg);
    const done = await (await reg.startIndexing(id, { strategy: "full" })).completion;
    expect(done).toMatchObject({ status: "indexed", indexStrategy: "full" });
    expect(await store.countChunks(id)).toBeGreaterThan(8);
  });

  it("rejects a bad strategy and an unknown repo", async () => {
    const reg = registry();
    const id = await registered(reg);
    await expect(reg.startIndexing(id, { strategy: "everything" } as never)).rejects.toBeInstanceOf(ZodError);
    await expect(reg.startIndexing("nope")).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses to start a second run while one is in progress, even when started at the same moment", async () => {
    const reg = registry();
    const id = await registered(reg);
    const results = await Promise.allSettled([reg.startIndexing(id), reg.startIndexing(id), reg.startIndexing(id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason.code === "conflict")).toBe(true);
    await reg.idle();
    expect((await reg.get(id)).status).toBe("indexed");
    expect((await store.listLatestRuns()).length).toBe(1);
  });

  it("refuses to index a repo that is still being profiled", async () => {
    const reg = registry();
    const { completion } = await reg.register({ name: "slow", source: { type: "path", value: localFixture() } });
    await expect(reg.startIndexing("slow")).rejects.toMatchObject({ code: "conflict" });
    await completion;
    await expect(reg.startIndexing("slow")).resolves.toBeDefined();
    await reg.idle();
  });

  it("can index again after success, and after a failure", async () => {
    const reg = registry();
    const id = await registered(reg);
    await (
      await reg.startIndexing(id, { strategy: "full" })
    ).completion;
    llm.failEmbeddings(new Error("Voyage is down"));
    // a new commit would be needed for work to happen on a non-git folder, but a non-git folder always rebuilds, so this run fails
    const failed = await (await reg.startIndexing(id, { strategy: "full" })).completion;
    expect(failed).toMatchObject({ status: "failed", error: "Voyage is down" });
    llm.heal();
    const retried = await (await reg.startIndexing(id, { strategy: "full" })).completion;
    expect(retried.status).toBe("indexed");
    expect(retried.error).toBeUndefined();
  });

  it("indexes a repo whose profiling failed: it is profiled first", async () => {
    const reg = registry();
    const remote = remoteOf();
    // first the URL is wrong, so registering ends in `failed` with no profile
    const bad = remote.url.replace("remote.git", "missing.git");
    const registered = await (await reg.register({ name: "late", source: { type: "url", value: bad } })).completion;
    expect(registered).toMatchObject({ status: "failed", profile: null });
    // the remote appears at that URL; indexing is the retry
    fs.cpSync(path.join(path.dirname(remote.work), "remote.git"), path.join(path.dirname(remote.work), "missing.git"), { recursive: true });
    const done = await (await reg.startIndexing("late", { strategy: "full" })).completion;
    expect(done.status).toBe("indexed");
    expect(done.profile?.totalFiles).toBe(8);
  });

  it("pulls a URL repo before indexing, then updates the index incrementally", async () => {
    const remote = remoteOf();
    const reg = registry();
    await (
      await reg.register({ name: "remote", source: { type: "url", value: remote.url } })
    ).completion;
    const first = await (await reg.startIndexing("remote", { strategy: "full" })).completion;
    const firstSha = first.indexedCommitSha;
    expect(firstSha).toMatch(/^[0-9a-f]{40}$/);
    const before = await store.getChunks("remote");

    const secondSha = remote.publish(
      {
        "modules/billing/payments.ts":
          fs.readFileSync(path.join(remote.work, "modules/billing/payments.ts"), "utf8") + "\nexport function voidPayment(): void {}\n",
      },
      "add voidPayment",
    );
    const second = await (await reg.startIndexing("remote", { strategy: "full" })).completion;

    expect(second.indexedCommitSha).toBe(secondSha);
    expect((await store.listLatestRuns())[0]).toMatchObject({ mode: "incremental", fromCommitSha: firstSha, commitSha: secondSha });
    const after = await store.getChunks("remote");
    expect(after.some((c) => c.symbolName === "voidPayment")).toBe(true);
    const untouched = (cs: typeof before) => cs.filter((c) => c.filePath !== "modules/billing/payments.ts").map((c) => c.id);
    expect(untouched(after)).toEqual(untouched(before));
  });

  it("detects a cache folder that belongs to a different remote", async () => {
    const reg = registry();
    const a = remoteOf();
    const b = remoteOf("java-sample");
    await (
      await reg.register({ name: "clash", source: { type: "url", value: a.url } })
    ).completion;
    // someone points the same cache folder at another remote
    fs.rmSync(path.join(cacheDir, "clash"), { recursive: true, force: true });
    fs.cpSync(path.join(path.dirname(b.work), "work"), path.join(cacheDir, "clash"), { recursive: true });
    const other = await store.getRepo("clash");
    await store.saveRepo({ ...other!, status: "profiled" });
    const result = await (await reg.startIndexing("clash")).completion;
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/different remote|none/);
  });

  it("finds links between registered repos", async () => {
    const reg = registry();
    const api = localFixture();
    const web = path.join(tmpDir("sdd-web-"), "web");
    cleanup.push(path.dirname(web));
    write(web, "src/index.ts", 'export const API = "http://billing-api:8080";\n');
    await (
      await reg.register({ name: "billing-api", source: { type: "path", value: api } })
    ).completion;
    await (
      await reg.register({ name: "web-app", source: { type: "path", value: web } })
    ).completion;
    await (
      await reg.startIndexing("web-app")
    ).completion;
    expect(await store.getCrossRepoLinks()).toEqual([expect.objectContaining({ fromRepo: "web-app", toRepo: "billing-api" })]);
  });
});

describe("recoverInterrupted", () => {
  it("marks repos and runs left over by a restart as failed, and leaves live work alone", async () => {
    const reg = registry();
    const dir = localFixture();
    const stamp = "2026-10-21T09:30:00.000Z";
    const base = {
      source: { type: "path" as const, value: dir },
      localPath: dir,
      profile: null,
      indexStrategy: null,
      indexedCommitSha: null,
      indexedAt: null,
      createdAt: stamp,
      updatedAt: stamp,
    };
    await store.saveRepo({ ...base, id: "was-profiling", name: "a", status: "profiling" });
    await store.saveRepo({ ...base, id: "was-indexing", name: "b", status: "indexing" });
    await store.saveRepo({ ...base, id: "fine", name: "c", status: "indexed" });
    const run = await store.createRun({ repoId: "was-indexing", strategy: "full" });

    expect(await reg.recoverInterrupted()).toBe(2);
    expect(await reg.get("was-profiling")).toMatchObject({ status: "failed", error: "Interrupted by a restart" });
    expect(await reg.get("was-indexing")).toMatchObject({ status: "failed" });
    expect((await reg.get("fine")).status).toBe("indexed");
    expect(await store.getRun(run.id)).toMatchObject({ status: "error", error: "Interrupted by a restart" });
    expect(await reg.recoverInterrupted()).toBe(0);

    // and the repo can be indexed again
    await expect((await reg.startIndexing("was-indexing")).completion).resolves.toMatchObject({ status: "indexed" });
  });
});

describe("end to end: register, index, ask for context", () => {
  it("serves context for a task from a repo registered by URL", async () => {
    const remote = remoteOf();
    const reg = registry();
    await (
      await reg.register({ name: "billing", source: { type: "url", value: remote.url } })
    ).completion;
    const indexed = await (await reg.startIndexing("billing", { strategy: "full" })).completion;
    expect(indexed.status).toBe("indexed");

    const provider = new RepoContextProvider({ store, outputRoot, topK: 4 });
    for (const mode of ["claude-md", "embeddings", "hybrid"] as const) {
      const bundle = await provider.getContext({ repoId: "billing", task: "refund part of an invoice payment", mode });
      expect(bundle.mode).toBe(mode);
      expect(bundle.chunks[0].filePath).toMatch(/modules\/billing\//);
    }
  });
});

describe("isRegistryError", () => {
  it("recognises a RegistryError, including one from another copy of the class (as a bundler can produce)", () => {
    expect(isRegistryError(new RegistryError("conflict", "x"))).toBe(true);
    const lookalike = Object.assign(new Error("from another bundle"), { name: "RegistryError", code: "not_found" });
    expect(lookalike instanceof RegistryError).toBe(false);
    expect(isRegistryError(lookalike)).toBe(true);
  });

  it("does not mistake other values for one", () => {
    for (const value of [
      new Error("plain"),
      new TypeError("x"),
      "RegistryError",
      null,
      undefined,
      { name: "RegistryError", code: "conflict" },
      Object.assign(new Error("x"), { name: "RegistryError" }),
    ]) {
      expect(isRegistryError(value)).toBe(false);
    }
  });
});
