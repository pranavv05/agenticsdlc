import type { IndexStrategy } from "@sdd/contracts";
import fs from "node:fs/promises";
import { chunkRepo } from "./chunk";
import { pMap } from "./concurrency";
import { detectModules, extractSummary, generateModuleClaudeMd, generateRootClaudeMd, claudeMdRelPath } from "./claudeMd";
import { detectCrossRepoLinks } from "./crossRepoLinks";
import { extractDependencies } from "./dependencies";
import { DocsOutput, SYSTEM_MINDMAP_BASE, defaultOutputRoot } from "./docsOutput";
import { embedChunks } from "./embed";
import { diffFiles, workingTreeState } from "./git";
import { log, logHeader } from "./log";
import { generateMindmap, generateSystemMindmap } from "./mindmap";
import { isSourceFile } from "./parse";
import { planIndex, type Plan } from "./plan";
import type { ContextStore, IndexRun, StoredRepo } from "./store/types";
import type {
  ChunkRecord,
  CrossRepoLink,
  DependencyEdge,
  ModuleDoc,
  ModuleInfo,
  ProgressCallback,
  ProgressCounts,
  ProgressStage,
  RepoTarget,
} from "./types";
import { GENERATED_CLAUDE_MD, walkRepo, type WalkedFile } from "./walk";

export const SYSTEM_KEY = "(system)";
const MODULE_CONCURRENCY = 3;

export interface IndexOptions {
  store: ContextStore;
  /** Where generated docs and mind maps are written. Default: CONTEXT_OUTPUT_DIR or ./output. They are never written into the repo. */
  outputRoot?: string;
  /** "auto" patches the index when it safely can; "full" always rebuilds. Default "auto". */
  mode?: "auto" | "full";
  /** Overrides the strategy for every repo. Default per repo: its profile's recommendation, else "full". */
  strategy?: IndexStrategy;
  onProgress?: ProgressCallback;
  /** Repos that take part in cross-repo links and the system mind map. Default: the repos being indexed. */
  allTargets?: RepoTarget[];
}

export interface IndexResult {
  failedRepos: string[];
  /** The run of every repo that was attempted. */
  runs: IndexRun[];
  /** What was done for each repo: skipped, rebuilt, or patched. */
  plans: Record<string, Plan>;
}

interface Ingested {
  target: RepoTarget;
  repo: StoredRepo;
  run: IndexRun;
  plan: Plan;
  strategy: IndexStrategy;
  /** HEAD at index time, with "+dirty" appended when the working tree had uncommitted changes. Null outside git. */
  sha: string | null;
  walked: WalkedFile[];
  /** Every chunk of the repo as it is on disk now (chunking is parse-only and cheap; only embedding is paid for). */
  chunks: ChunkRecord[];
  edges: DependencyEdge[];
}

const fmt = (counts: ProgressCounts) =>
  Object.entries(counts)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");

const nowIso = () => new Date().toISOString();

async function ensureRepo(store: ContextStore, target: RepoTarget): Promise<StoredRepo> {
  const existing = await store.getRepo(target.id);
  if (existing) return existing.localPath === target.path ? existing : { ...existing, localPath: target.path };
  const created: StoredRepo = {
    id: target.id,
    name: target.name,
    source: { type: "path", value: target.path },
    localPath: target.path,
    status: "profiled",
    profile: null,
    indexStrategy: null,
    indexedCommitSha: null,
    indexedAt: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await store.saveRepo(created);
  return created;
}

/**
 * Index repos:
 *  phase 1 (per repo): plan -> chunk -> embed -> write the index in one transaction
 *  phase 2 (all repos): cross-repo links
 *  phase 3 (per repo): module docs, root doc and mind map, written under outputRoot
 *  phase 4: system mind map
 *
 * A repo that fails stops at its own phase and is reported in `failedRepos`; the other repos carry on, and the repo's
 * previous index is untouched (the index is replaced transactionally, after the embeddings succeeded).
 */
export async function indexRepos(targets: RepoTarget[], opts: IndexOptions): Promise<IndexResult> {
  const { store } = opts;
  const docs = new DocsOutput(opts.outputRoot ?? defaultOutputRoot());
  const failed = new Set<string>();
  const runs: IndexRun[] = [];
  const plans: Record<string, Plan> = {};

  const progressByRun = new Map<number, Record<string, ProgressCounts>>();
  const emitFor = (repoId: string, runId: number | null) => async (stage: ProgressStage, counts: ProgressCounts) => {
    log(repoId, stage, fmt(counts));
    await opts.onProgress?.(repoId, stage, counts);
    if (runId !== null) {
      const progress = progressByRun.get(runId) ?? {};
      progress[stage] = counts;
      progressByRun.set(runId, progress);
      await store.updateRun(runId, { progress });
    }
  };

  logHeader(`Indexing ${targets.length} repo(s): ${targets.map((t) => t.id).join(", ")}`);

  // ---- phase 1: ingest ----
  const ingested: Ingested[] = [];
  const skipped: Ingested[] = [];
  for (const target of targets) {
    logHeader(`Repo ${target.id} — ingest`);
    let run: IndexRun | null = null;
    let repo: StoredRepo | null = null;
    try {
      repo = await ensureRepo(store, target);
      const strategy: IndexStrategy = opts.strategy ?? repo.profile?.recommendation ?? "full";
      run = await store.createRun({ repoId: target.id, strategy });
      runs.push(run);
      await store.saveRepo({ ...repo, status: "indexing", error: undefined, updatedAt: nowIso() });
      const emit = emitFor(target.id, run.id);

      const state = await ingestRepo({ target, repo, run, strategy, store, docs, opts, emit });
      plans[target.id] = state.plan;
      if (state.plan.kind === "skip") {
        skipped.push(state);
        await store.saveRepo({ ...repo, status: "indexed", error: undefined, updatedAt: nowIso() });
        await store.updateRun(state.run.id, { status: "done", finished: true });
        await emit("done", { skipped: 1, reason: state.plan.reason, complete: 1 });
      } else {
        ingested.push(state);
      }
    } catch (err) {
      failed.add(target.id);
      await fail(store, repo, run, err, emitFor(target.id, run?.id ?? null));
    }
  }

  const processed = [...ingested];
  if (processed.length === 0) {
    return { failedRepos: [...failed], runs: await refresh(store, runs), plans };
  }

  // ---- phase 2: cross-repo links ----
  logHeader("Cross-repo links");
  const all = opts.allTargets ?? targets;
  let links: CrossRepoLink[] = [];
  try {
    for (const t of all) await ensureRepo(store, t); // links reference repos by foreign key
    links = await detectCrossRepoLinks(all);
    await store.replaceCrossRepoLinks(
      all.map((t) => t.id),
      links,
    );
    log(SYSTEM_KEY, "cross_repo_links", `links=${links.length}`);
    await opts.onProgress?.(SYSTEM_KEY, "cross_repo_links", { links: links.length, complete: 1 });
  } catch (err) {
    failed.add(SYSTEM_KEY);
    await opts.onProgress?.(SYSTEM_KEY, "error", { message: `cross-repo links: ${(err as Error).message}` });
    log(SYSTEM_KEY, "error", `cross-repo links: ${(err as Error).message}`);
  }

  // ---- phase 3: docs + mind maps ----
  for (const s of processed) {
    logHeader(`Repo ${s.target.id} — docs + mind map`);
    const emit = emitFor(s.target.id, s.run.id);
    try {
      await documentRepo(s, { docs, links, emit });
      await store.saveRepo({
        ...s.repo,
        status: "indexed",
        indexStrategy: s.strategy,
        indexedCommitSha: s.sha,
        indexedAt: nowIso(),
        error: undefined,
        updatedAt: nowIso(),
      });
      await store.updateRun(s.run.id, { status: "done", finished: true });
      await emit("done", { complete: 1 });
    } catch (err) {
      failed.add(s.target.id);
      await fail(store, s.repo, s.run, err, emit);
    }
  }

  // ---- phase 4: system mind map ----
  try {
    const needed = processed.some((s) => !failed.has(s.target.id)) || !(await docs.readMindmap(docs.systemBase()));
    if (needed) {
      const map = await generateSystemMindmap(all, links);
      await docs.writeMindmap(docs.systemBase(), "System overview", map.mermaid, map.prose);
      log(SYSTEM_KEY, "mindmap", `written as ${SYSTEM_MINDMAP_BASE}.md`);
      await opts.onProgress?.(SYSTEM_KEY, "mindmap", { diagrams: 1, complete: 1 });
    }
  } catch (err) {
    failed.add(SYSTEM_KEY);
    await opts.onProgress?.(SYSTEM_KEY, "error", { message: `system mindmap: ${(err as Error).message}` });
    log(SYSTEM_KEY, "error", `system mindmap: ${(err as Error).message}`);
  }

  logHeader(failed.size ? `Finished with errors in: ${[...failed].join(", ")}` : "Indexing complete");
  return { failedRepos: [...failed], runs: await refresh(store, runs), plans };
}

/** Index one repo. Cross-repo links use `opts.allTargets` when given. */
export function indexRepo(target: RepoTarget, opts: IndexOptions): Promise<IndexResult> {
  return indexRepos([target], opts);
}

async function refresh(store: ContextStore, runs: IndexRun[]): Promise<IndexRun[]> {
  return (await Promise.all(runs.map((r) => store.getRun(r.id)))).filter((r): r is IndexRun => r !== null);
}

async function fail(
  store: ContextStore,
  repo: StoredRepo | null,
  run: IndexRun | null,
  err: unknown,
  emit: (stage: ProgressStage, counts: ProgressCounts) => Promise<void>,
) {
  const message = err instanceof Error ? err.message : String(err);
  // The previous index (chunks, edges) is untouched: only the status says that the last attempt failed.
  if (repo) await store.saveRepo({ ...repo, status: "failed", error: message, updatedAt: nowIso() }).catch(() => undefined);
  if (run) await store.updateRun(run.id, { status: "error", error: message, finished: true }).catch(() => undefined);
  await emit("error", { message }).catch(() => undefined);
}

// ---------------------------------------------------------------------------------------------------------------------

async function ingestRepo(ctx: {
  target: RepoTarget;
  repo: StoredRepo;
  run: IndexRun;
  strategy: IndexStrategy;
  store: ContextStore;
  docs: DocsOutput;
  opts: IndexOptions;
  emit: (stage: ProgressStage, counts: ProgressCounts) => Promise<void>;
}): Promise<Ingested> {
  const { target, repo, strategy, store, docs, opts, emit } = ctx;

  // Fail clearly on a bad path: walking a missing folder would quietly "index" nothing.
  try {
    if (!(await fs.stat(target.path)).isDirectory()) throw new Error("not a directory");
  } catch (err) {
    throw new Error(`Repo "${target.id}": path "${target.path}" is not usable (${(err as Error).message})`, { cause: err });
  }

  const walked = await walkRepo(target.path);
  const sourceFiles = walked.filter((f) => isSourceFile(f.rel));
  await emit("files", { total: walked.length, source: sourceFiles.length, complete: 1 });

  const tree = await workingTreeState(target.path);
  const sha = tree ? (tree.dirty ? `${tree.sha}+dirty` : tree.sha) : null;
  const last = { sha: repo.indexedCommitSha, strategy: repo.indexStrategy };
  const canDiff = tree && !tree.dirty && last.sha && !last.sha.endsWith("+dirty") && last.sha !== tree.sha;
  const diff = canDiff ? await diffFiles(target.path, last.sha!, tree.sha) : null;

  let plan = planIndex({
    mode: opts.mode ?? "auto",
    strategy,
    last,
    current: tree,
    diff,
    totalSourceFiles: sourceFiles.length,
    docsExist: await docs.hasDocs(target.id),
  });
  if (plan.kind === "incremental" && strategy === "full" && sourceFiles.length > 0 && (await store.countChunks(target.id)) === 0) {
    plan = { kind: "full", reason: "the stored index is empty" };
  }
  await store.updateRun(ctx.run.id, {
    mode: plan.kind === "skip" ? null : plan.kind,
    commitSha: sha,
    fromCommitSha: repo.indexedCommitSha,
  });
  await emit("plan", { kind: plan.kind, reason: plan.reason });

  const base = { target, repo, run: ctx.run, plan, strategy, sha, walked };
  if (plan.kind === "skip") return { ...base, chunks: [], edges: [] };

  const chunks = (await chunkRepo(target.path, target.id, walked)).map((c): ChunkRecord => ({ ...c, commitSha: sha }));
  await emit("chunks", { chunks: chunks.length, files: new Set(chunks.map((c) => c.filePath)).size, complete: 1 });

  const edges = await extractDependencies(target.path, walked);
  await emit("dependencies", { edges: edges.length, complete: 1 });

  if (strategy === "claude-md-only") {
    // Docs and a mind map only: nothing is embedded or stored, and any earlier full index of this repo is dropped.
    await store.replaceIndex({ repoId: target.id, mode: "full", files: [], chunks: [], edges: [] });
    return { ...base, chunks, edges };
  }

  const changed = plan.kind === "incremental" ? new Set(plan.changed) : null;
  const toEmbed = changed ? chunks.filter((c) => changed.has(c.filePath)) : chunks;
  // Embeddings are computed BEFORE the transaction opens: if the API fails here the stored index has not been touched.
  const embedded = await embedChunks(toEmbed, (done, total) => {
    log(target.id, "embeddings", `${done}/${total}`);
    void opts.onProgress?.(target.id, "embeddings", { done, total });
  });
  await store.replaceIndex({
    repoId: target.id,
    mode: plan.kind === "incremental" ? "incremental" : "full",
    files: plan.kind === "incremental" ? plan.removed : [],
    chunks: embedded,
    edges,
  });
  await emit("embeddings", { done: embedded.length, total: toEmbed.length, reused: chunks.length - toEmbed.length, complete: 1 });
  return { ...base, chunks, edges };
}

async function documentRepo(
  s: Ingested,
  ctx: { docs: DocsOutput; links: CrossRepoLink[]; emit: (stage: ProgressStage, counts: ProgressCounts) => Promise<void> },
): Promise<void> {
  const { docs, links, emit } = ctx;
  const { target, plan } = s;

  const modules: ModuleInfo[] = await detectModules(target.path, s.walked);
  log(target.id, "claude_md", `detected ${modules.length} module(s): ${modules.map((m) => m.dir).join(", ") || "(none)"}`);

  // Which module docs need (re)writing: all of them on a full run; on an incremental run the modules with a touched
  // file, plus any whose doc file is missing.
  const touched = plan.kind === "incremental" ? plan.touched : null;
  const redo: ModuleInfo[] = [];
  const keep: ModuleInfo[] = [];
  for (const m of modules) {
    const missing = !(await docs.read(target.id, claudeMdRelPath(m.dir)));
    const hit = touched ? touched.some((f) => f.startsWith(m.dir + "/")) : true;
    (hit || missing ? redo : keep).push(m);
  }
  await emit("claude_md", { modules: modules.length, rewriting: redo.length, written: 0 });

  // Generate everything in memory first; nothing is written until all of it succeeded.
  const files = new Map<string, string>();
  let written = 0;
  const fresh = await pMap(redo, MODULE_CONCURRENCY, async (m): Promise<ModuleDoc> => {
    const moduleChunks = s.chunks.filter((c) => c.filePath.startsWith(m.dir + "/"));
    const md = await generateModuleClaudeMd(m.dir, moduleChunks, s.edges, {
      repoId: target.id,
      repoName: target.name,
      crossRepoLinks: links,
    });
    const rel = claudeMdRelPath(m.dir);
    files.set(rel, md);
    written++;
    await emit("claude_md", { modules: modules.length, rewriting: redo.length, written });
    return { dir: m.dir, summary: extractSummary(md), claudeMdPath: rel };
  });
  const kept: ModuleDoc[] = [];
  for (const m of keep) {
    const rel = claudeMdRelPath(m.dir);
    kept.push({ dir: m.dir, summary: extractSummary((await docs.read(target.id, rel)) ?? ""), claudeMdPath: rel });
  }
  const moduleDocs = [...fresh, ...kept].sort((a, b) => a.dir.localeCompare(b.dir));

  const rootMissing = !(await docs.read(target.id, GENERATED_CLAUDE_MD));
  const rewriteRoot = redo.length > 0 || rootMissing || plan.kind === "full";
  if (rewriteRoot) {
    const rootMd = await generateRootClaudeMd(target, moduleDocs, {
      crossRepoLinks: links,
      fileList: s.walked.filter((f) => !f.rel.includes("/")).map((f) => f.rel),
    });
    files.set(GENERATED_CLAUDE_MD, rootMd);
  }

  const mindmap =
    rewriteRoot || !(await docs.readMindmap(docs.mindmapBase(target.id)))
      ? await generateMindmap(target, moduleDocs, links, { edges: s.edges })
      : null;

  // Everything generated: now write. A full run replaces the whole docs folder so docs of deleted modules disappear.
  if (plan.kind === "full") await docs.replaceDocs(target.id, files);
  else await docs.writeDocs(target.id, files);
  await emit("claude_md", { modules: modules.length, rewriting: redo.length, written, root: rewriteRoot ? 1 : 0, complete: 1 });

  if (mindmap) await docs.writeMindmap(docs.mindmapBase(target.id), `${target.name} — module structure`, mindmap.mermaid, mindmap.prose);
  await emit("mindmap", { diagrams: mindmap ? 1 : 0, complete: 1 });
}
