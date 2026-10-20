import { ContextBundleSchema, EMPTY_CONTEXT_BUNDLE, RETRIEVAL_MODES, type ContextBundle, type RetrievalMode } from "@sdd/contracts";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocsOutput } from "../src/docsOutput";
import { indexRepo } from "../src/pipeline";
import { ContextError, NullContextProvider, RepoContextProvider, type RepoContextProviderOptions } from "../src/provider";
import { MemoryContextStore } from "../src/store/memory";
import type { ContextStore } from "../src/store/types";
import type { RepoTarget } from "../src/types";
import { GENERATED_CLAUDE_MD } from "../src/walk";
import { installMockLlm, type MockLlm } from "./helpers/llm";
import { commitAll, copyFixture, rmrf, tmpDir, write } from "./helpers/repos";

const BILLING_TASK = "charge a customer's card and refund part of an invoice payment";
const AUTH_TASK = "issue and verify session tokens when a user logs in";

let llm: MockLlm;
let store: MemoryContextStore;
let outputRoot: string;
let repoDir: string;
let target: RepoTarget;
const cleanup: string[] = [];

beforeEach(async () => {
  llm = installMockLlm();
  store = new MemoryContextStore();
  outputRoot = tmpDir("sdd-prov-out-");
  repoDir = copyFixture("sample-repo");
  target = { id: "sample", name: "Sample", path: repoDir };
  cleanup.push(outputRoot, path.dirname(repoDir));
});
afterEach(() => {
  llm.restore();
  cleanup.splice(0).forEach(rmrf);
});

const index = (extra: Parameters<typeof indexRepo>[1] extends infer O ? Partial<O> : never = {}) =>
  indexRepo(target, { store, outputRoot, ...extra });
const provider = (extra: Partial<RepoContextProviderOptions> = {}, s: ContextStore = store) =>
  new RepoContextProvider({ store: s, outputRoot, topK: 4, ...extra });
const get = (p: RepoContextProvider, task: string, mode: RetrievalMode, extra: { budgetTokens?: number } = {}) =>
  p.getContext({ repoId: "sample", task, mode, ...extra });

/** Counts calls to the store, so a test can show which parts of it a mode touches. */
function spyStore(inner: ContextStore): { store: ContextStore; calls: string[] } {
  const calls: string[] = [];
  const proxy = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(`${String(prop)}${prop === "getChunks" && !(args[1] as { files?: string[] } | undefined)?.files ? ":all" : ""}`);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { store: proxy, calls };
}

describe("NullContextProvider (Case A)", () => {
  it("returns an empty, schema-valid bundle that ignores the request", async () => {
    const bundle = await new NullContextProvider().getContext({ repoId: "anything", task: "build a todo app" });
    expect(ContextBundleSchema.parse(bundle)).toEqual(EMPTY_CONTEXT_BUNDLE);
    expect(bundle).toMatchObject({
      mode: null,
      chunks: [],
      relevantClaudeMdSections: [],
      relevantMindmapExcerpt: "",
      tokenEstimate: 0,
      truncated: false,
    });
  });

  it("returns a fresh object each time, so one caller cannot change what another sees", async () => {
    const provider = new NullContextProvider();
    const first = await provider.getContext();
    first.chunks.push({
      repoId: "x",
      filePath: "a",
      symbolName: null,
      chunkType: "other",
      code: "",
      startLine: 1,
      endLine: 1,
      score: null,
      via: "lexical",
    });
    first.relevantClaudeMdSections.push({ repoId: "x", path: "p", content: "c" });
    const second = await provider.getContext();
    expect(second.chunks).toEqual([]);
    expect(second.relevantClaudeMdSections).toEqual([]);
    expect(EMPTY_CONTEXT_BUNDLE.chunks).toEqual([]);
  });
});

describe("RepoContextProvider: the three modes return the same shape", () => {
  beforeEach(async () => {
    await index();
  });

  it.each(RETRIEVAL_MODES)("%s: a schema-valid bundle that reports its mode, with docs and a mind map", async (mode) => {
    const bundle = await get(provider(), BILLING_TASK, mode);
    expect(ContextBundleSchema.parse(bundle)).toEqual(bundle);
    expect(bundle.mode).toBe(mode);
    expect(bundle.chunks.length).toBeGreaterThan(0);
    expect(bundle.chunks.every((c) => c.repoId === "sample")).toBe(true);
    expect(bundle.relevantClaudeMdSections.length).toBeGreaterThan(0);
    expect(bundle.relevantMindmapExcerpt).toContain("mermaid");
    expect(bundle.tokenEstimate).toBeGreaterThan(0);
  });

  it.each(RETRIEVAL_MODES)("%s: ranks billing code first for a billing task and auth code first for an auth task", async (mode) => {
    const p = provider();
    expect((await get(p, BILLING_TASK, mode)).chunks[0].filePath).toMatch(/modules\/billing\//);
    expect((await get(p, AUTH_TASK, mode)).chunks[0].filePath).toMatch(/modules\/auth\//);
  });

  it("claude-md mode never calls the embeddings API", async () => {
    const before = llm.embedCalls.length;
    await get(provider(), BILLING_TASK, "claude-md");
    expect(llm.embedCalls.length).toBe(before);
  });

  it("embeddings mode and hybrid mode embed the task once", async () => {
    const before = llm.embedCalls.length;
    await get(provider(), BILLING_TASK, "embeddings");
    await get(provider(), BILLING_TASK, "hybrid");
    expect(llm.embedCalls.slice(before)).toEqual([1, 1]);
  });

  it("embeddings mode uses the index only: it does not load every chunk or touch the working tree", async () => {
    const spied = spyStore(store);
    let diskLoads = 0;
    const p = provider({ snapshotDeps: { chunkFromDisk: async () => (diskLoads++, []) } }, spied.store);
    await get(p, BILLING_TASK, "embeddings");
    expect(spied.calls).toContain("searchSimilar");
    expect(spied.calls).not.toContain("getChunks:all");
    expect(diskLoads).toBe(0);
  });

  it("claude-md mode builds its search from the stored chunks, not from the working tree", async () => {
    let diskLoads = 0;
    const p = provider({ snapshotDeps: { chunkFromDisk: async () => (diskLoads++, []) } });
    const bundle = await get(p, BILLING_TASK, "claude-md");
    expect(bundle.chunks.length).toBeGreaterThan(0);
    expect(diskLoads).toBe(0);
  });

  it("marks where each chunk came from: similarity, lexical or dependency", async () => {
    const p = provider({ topK: 3 });
    const embeddings = await get(p, BILLING_TASK, "embeddings");
    expect(embeddings.chunks.filter((c) => c.via === "similarity").every((c) => typeof c.score === "number")).toBe(true);
    expect(embeddings.chunks.some((c) => c.via === "lexical")).toBe(false);

    const lexical = await get(p, BILLING_TASK, "claude-md");
    expect(lexical.chunks.some((c) => c.via === "lexical" && c.score === null)).toBe(true);
    expect(lexical.chunks.some((c) => c.via === "similarity")).toBe(false);

    const hybrid = await get(p, BILLING_TASK, "hybrid");
    expect(hybrid.chunks.some((c) => c.via === "similarity")).toBe(true);
  });

  it("hybrid keeps what both rankings agree on near the top, without duplicates", async () => {
    const p = provider({ topK: 6 });
    const [lexical, embeddings, hybrid] = await Promise.all(
      ["claude-md", "embeddings", "hybrid"].map((m) => get(p, BILLING_TASK, m as RetrievalMode)),
    );
    const key = (c: ContextBundle["chunks"][number]) => `${c.filePath}:${c.startLine}`;
    const hybridKeys = hybrid.chunks.filter((c) => c.via !== "dependency").map(key);
    expect(new Set(hybridKeys).size).toBe(hybridKeys.length);
    const lexicalTop = key(lexical.chunks[0]);
    const embeddingTop = key(embeddings.chunks[0]);
    expect(hybridKeys.slice(0, 3)).toEqual(expect.arrayContaining([lexicalTop === embeddingTop ? lexicalTop : lexicalTop]));
    expect(hybridKeys).toContain(embeddingTop);
  });

  it("adds dependency neighbours in both directions (imports and importers)", async () => {
    // top hit for the auth task is in modules/auth; modules/billing/guard.ts imports session.ts, so it is an importer
    const bundle = await get(provider({ topK: 2 }), "create a session for a user token", "claude-md");
    const deps = bundle.chunks.filter((c) => c.via === "dependency");
    expect(deps.length).toBeGreaterThan(0);
    expect(deps.every((c) => c.score === null)).toBe(true);
    expect(deps.some((c) => c.filePath === "modules/billing/guard.ts")).toBe(true);
    // a neighbour is a file that was not already a primary hit
    const primary = new Set(bundle.chunks.filter((c) => c.via !== "dependency").map((c) => c.filePath));
    expect(deps.every((c) => !primary.has(c.filePath))).toBe(true);
  });

  it("caps the chunks taken from each neighbour file", async () => {
    const bundle = await get(provider({ topK: 1, chunksPerNeighbour: 1 }), "calculate invoice total", "claude-md");
    const perFile = new Map<string, number>();
    for (const c of bundle.chunks.filter((x) => x.via === "dependency")) perFile.set(c.filePath, (perFile.get(c.filePath) ?? 0) + 1);
    expect([...perFile.values()].every((n) => n <= 1)).toBe(true);
  });

  it("returns the module docs of the hits first and the repo overview last", async () => {
    const bundle = await get(provider({ topK: 2 }), BILLING_TASK, "claude-md");
    const paths = bundle.relevantClaudeMdSections.map((s) => s.path);
    expect(paths[0]).toBe(`modules/billing/${GENERATED_CLAUDE_MD}`);
    expect(paths.at(-1)).toBe(GENERATED_CLAUDE_MD);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("lists the docs of every module the hits touch before the repo overview, which always comes last", async () => {
    // a task that lands in both modules: the billing guard checks the auth session
    const bundle = await get(provider({ topK: 8 }), "billing guard requires a valid session token", "claude-md");
    const hitModules = new Set(bundle.chunks.filter((c) => c.via !== "dependency").map((c) => c.filePath.split("/").slice(0, 2).join("/")));
    expect(hitModules).toEqual(new Set(["modules/auth", "modules/billing"]));
    const paths = bundle.relevantClaudeMdSections.map((s) => s.path);
    expect(paths.at(-1)).toBe(GENERATED_CLAUDE_MD);
    expect(paths.slice(0, -1).sort()).toEqual([`modules/auth/${GENERATED_CLAUDE_MD}`, `modules/billing/${GENERATED_CLAUDE_MD}`]);
  });

  it("is deterministic", async () => {
    const p = provider();
    for (const mode of RETRIEVAL_MODES) expect(await get(p, BILLING_TASK, mode)).toEqual(await get(p, BILLING_TASK, mode));
  });

  it("uses the provider's default mode and budget when the request names none", async () => {
    const bundle = await provider({ defaultMode: "claude-md", defaultBudgetTokens: 3000 }).getContext({
      repoId: "sample",
      task: BILLING_TASK,
    });
    expect(bundle.mode).toBe("claude-md");
    expect(bundle.tokenEstimate).toBeLessThanOrEqual(3000);
    expect((await provider().getContext({ repoId: "sample", task: BILLING_TASK })).mode).toBe("hybrid");
  });
});

describe("RepoContextProvider: the token budget", () => {
  beforeEach(async () => {
    await index();
  });

  it.each(RETRIEVAL_MODES)("%s: never exceeds budgetTokens, whatever the budget", async (mode) => {
    const p = provider({ topK: 15 });
    for (const budget of [1, 40, 120, 300, 800, 2000, 12_000, 200_000]) {
      const bundle = await get(p, BILLING_TASK, mode, { budgetTokens: budget });
      expect(bundle.tokenEstimate, `${mode} @ ${budget}`).toBeLessThanOrEqual(budget);
      expect(ContextBundleSchema.safeParse(bundle).success).toBe(true);
    }
  });

  it("a smaller budget returns a prefix of the ranked chunks and sets truncated; a generous one truncates nothing", async () => {
    const p = provider({ topK: 15 });
    const full = await get(p, BILLING_TASK, "hybrid", { budgetTokens: 1_000_000 });
    expect(full.truncated).toBe(false);
    const fullKeys = full.chunks.map((c) => `${c.filePath}:${c.startLine}`);
    const small = await get(p, BILLING_TASK, "hybrid", { budgetTokens: 700 });
    const smallKeys = small.chunks.map((c) => `${c.filePath}:${c.startLine}`);
    expect(small.truncated).toBe(true);
    expect(smallKeys.length).toBeLessThan(fullKeys.length);
    expect(smallKeys).toEqual(fullKeys.slice(0, smallKeys.length));
  });

  it("marks cut text with a truncation marker", async () => {
    const bundle = await get(provider({ topK: 15 }), BILLING_TASK, "hybrid", { budgetTokens: 250 });
    const texts = [
      ...bundle.chunks.map((c) => c.code),
      ...bundle.relevantClaudeMdSections.map((s) => s.content),
      bundle.relevantMindmapExcerpt,
    ];
    expect(bundle.truncated).toBe(true);
    expect(texts.some((t) => t.includes("…(truncated)"))).toBe(true);
  });

  it("rejects a budget that is not a positive integer", async () => {
    for (const bad of [0, -1, 2.5, Number.NaN]) {
      await expect(get(provider(), BILLING_TASK, "hybrid", { budgetTokens: bad })).rejects.toMatchObject({ code: "invalid_budget" });
    }
  });
});

describe("RepoContextProvider: module docs steer the claude-md mode", () => {
  it("finds the right module from its CLAUDE.md even when the task shares few words with the code", async () => {
    await index();
    const docs = new DocsOutput(outputRoot);
    await docs.writeDocs(
      "sample",
      new Map([
        [
          `modules/auth/${GENERATED_CLAUDE_MD}`,
          "# modules/auth\nHandles credential verification and bearer credentials for people signing in.",
        ],
        [`modules/billing/${GENERATED_CLAUDE_MD}`, "# modules/billing\nMoney handling: ledgers, settlements and reimbursements."],
      ]),
    );
    const p = provider({ topK: 3 });
    // "reimbursement" appears in no code, only in the billing doc
    const bundle = await get(p, "handle a reimbursement settlement", "claude-md");
    expect(bundle.relevantClaudeMdSections[0].path).toBe(`modules/billing/${GENERATED_CLAUDE_MD}`);
  });

  it("offers the doc of a clearly relevant module even if none of its chunks ranked", async () => {
    await index();
    const docs = new DocsOutput(outputRoot);
    await docs.writeDocs(
      "sample",
      new Map([[`modules/auth/${GENERATED_CLAUDE_MD}`, "# modules/auth\nCredential verification, bearer credentials and passkeys."]]),
    );
    const bundle = await get(provider({ topK: 1 }), "passkeys", "claude-md");
    expect(bundle.relevantClaudeMdSections.map((s) => s.path)).toContain(`modules/auth/${GENERATED_CLAUDE_MD}`);
  });

  it("cuts the mind map down to the modules that were touched", async () => {
    await index();
    const docs = new DocsOutput(outputRoot);
    await docs.writeMindmap(
      docs.mindmapBase("sample"),
      "Sample — module structure",
      [
        "flowchart LR",
        '  A["modules/auth"]',
        '  B["modules/billing"]',
        '  R["modules/reports"]',
        '  S["modules/search"]',
        "  B -->|imports| A",
        "  R --> S",
      ].join("\n"),
      "Billing depends on auth.",
    );
    const bundle = await get(provider({ topK: 2 }), BILLING_TASK, "claude-md");
    expect(bundle.relevantMindmapExcerpt).toContain('B["modules/billing"]');
    expect(bundle.relevantMindmapExcerpt).toContain("B -->|imports| A");
    expect(bundle.relevantMindmapExcerpt).not.toContain("modules/reports");
  });
});

describe("RepoContextProvider: repos and errors", () => {
  it("rejects an empty task, an unknown repo and a repo that was never indexed", async () => {
    await index();
    const p = provider();
    await expect(p.getContext({ repoId: "sample", task: "   " })).rejects.toMatchObject({ code: "empty_task" });
    await expect(p.getContext({ repoId: "nope", task: "x" })).rejects.toMatchObject({ code: "repo_not_found" });
    await store.saveRepo({
      id: "fresh",
      name: "fresh",
      source: { type: "path", value: "/x" },
      localPath: "/x",
      status: "profiled",
      profile: null,
      indexStrategy: null,
      indexedCommitSha: null,
      indexedAt: null,
      createdAt: "2026-10-21T09:30:00.000Z",
      updatedAt: "2026-10-21T09:30:00.000Z",
    });
    await expect(p.getContext({ repoId: "fresh", task: "x" })).rejects.toBeInstanceOf(ContextError);
    await expect(p.getContext({ repoId: "fresh", task: "x" })).rejects.toMatchObject({ code: "repo_not_indexed" });
  });

  it("keeps serving the previous good index after a later run failed", async () => {
    await index();
    write(
      repoDir,
      "modules/billing/payments.ts",
      fs.readFileSync(path.join(repoDir, "modules/billing/payments.ts"), "utf8") + "\nexport const X = 1;\n",
    );
    commitAll(repoDir, "change");
    llm.failEmbeddings();
    await index();
    expect((await store.getRepo("sample"))?.status).toBe("failed");
    llm.heal(); // the embeddings outage is over for queries; the repo's last run is still marked failed
    const bundle = await get(provider(), BILLING_TASK, "hybrid");
    expect(bundle.chunks.length).toBeGreaterThan(0);
  });

  it("serves a repo indexed with the claude-md-only strategy from its working tree, whatever mode is asked for", async () => {
    await index({ strategy: "claude-md-only" });
    expect(await store.countChunks("sample")).toBe(0);
    const before = llm.embedCalls.length;
    for (const mode of RETRIEVAL_MODES) {
      const bundle = await get(provider({ topK: 1 }), BILLING_TASK, mode);
      expect(bundle.mode, mode).toBe("claude-md"); // embeddings are not available, so it says which mode it really used
      expect(bundle.chunks[0].filePath).toMatch(/modules\/billing\//);
      expect(bundle.chunks.some((c) => c.via === "dependency")).toBe(true);
    }
    expect(llm.embedCalls.length).toBe(before);
  });

  it("reuses the loaded snapshot until the repo is indexed again", async () => {
    await index({ strategy: "claude-md-only" });
    let loads = 0;
    const p = provider({
      snapshotDeps: { chunkFromDisk: async (...args) => (loads++, (await import("../src/chunk")).chunkRepo(args[0], args[1])) },
    });
    await get(p, BILLING_TASK, "claude-md");
    await get(p, AUTH_TASK, "claude-md");
    expect(loads).toBe(1);

    write(repoDir, "extras/new.ts", "export const added = true;\n");
    commitAll(repoDir, "add a file");
    await index({ strategy: "claude-md-only" });
    await get(p, BILLING_TASK, "claude-md");
    expect(loads).toBe(2);
  });

  it("does not cache a failed snapshot build", async () => {
    await index({ strategy: "claude-md-only" });
    let attempts = 0;
    const p = provider({
      snapshotDeps: {
        chunkFromDisk: async () => {
          if (attempts++ === 0) throw new Error("disk hiccup");
          return [];
        },
      },
    });
    await expect(get(p, BILLING_TASK, "claude-md")).rejects.toThrow("disk hiccup");
    await expect(get(p, BILLING_TASK, "claude-md")).resolves.toMatchObject({ mode: "claude-md" });
  });

  it("keeps repos apart", async () => {
    await index();
    const other = copyFixture("java-sample");
    cleanup.push(path.dirname(other));
    await indexRepo({ id: "javas", name: "Java Sample", path: other }, { store, outputRoot });
    const p = provider();
    for (const mode of RETRIEVAL_MODES) {
      const sample = await p.getContext({ repoId: "sample", task: "invoice total", mode });
      const java = await p.getContext({ repoId: "javas", task: "invoice total", mode });
      expect(
        sample.chunks.every((c) => c.repoId === "sample" && !c.filePath.endsWith(".java")),
        mode,
      ).toBe(true);
      expect(
        java.chunks.every((c) => c.repoId === "javas" && c.filePath.endsWith(".java")),
        mode,
      ).toBe(true);
    }
  });
});
