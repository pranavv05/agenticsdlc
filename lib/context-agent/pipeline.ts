import fs from "node:fs/promises";
import { chunkRepo } from "./chunk";
import { embedChunks } from "./embed";
import { extractDependencies } from "./dependencies";
import { detectCrossRepoLinks } from "./crossRepoLinks";
import { detectModules, extractSummary, generateModuleClaudeMd, generateRootClaudeMd, writeGeneratedClaudeMd } from "./claudeMd";
import { generateMindmaps, generateSystemMindmap } from "./mindmap";
import { clearRepo, insertChunks, insertDependencies, replaceCrossRepoLinks } from "./store";
import { loadRepoConfig, defaultOutputDir } from "./config";
import { isSourceFile } from "./parse";
import { walkRepo, type WalkedFile } from "./walk";
import { pMap } from "./llm";
import { log, logHeader } from "./log";
import type { ChunkRecord, CrossRepoLink, DependencyEdge, ModuleDoc, ProgressCallback, ProgressCounts, ProgressStage, RepoConfig } from "./types";

export const SYSTEM_KEY = "(system)";
const MODULE_CONCURRENCY = 3;

export interface IndexOptions {
  repos?: RepoConfig[];
  outputDir?: string;
}

export interface IndexResult {
  failedRepos: string[];
}

interface RepoState {
  repo: RepoConfig;
  chunks: ChunkRecord[];
  edges: DependencyEdge[];
  walked: WalkedFile[];
}

function fmt(counts: ProgressCounts): string {
  return Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ");
}

/**
 * Index every configured repo in sequence:
 *  phase 1 (per repo): files -> chunks -> embeddings (stored) -> dependencies
 *  phase 2 (all repos): cross-repo links
 *  phase 3 (per repo): CLAUDE.md files -> mindmap; then the system-level mindmap
 * `onProgress(repoName, stage, counts)` fires after every stage (counts.complete === 1 when the stage finished).
 */
export async function indexAllRepos(onProgress: ProgressCallback, opts: IndexOptions = {}): Promise<IndexResult> {
  const repos = opts.repos ?? loadRepoConfig();
  const outputDir = opts.outputDir ?? defaultOutputDir();
  const failed = new Set<string>();

  const emit = async (repo: string, stage: ProgressStage, counts: ProgressCounts) => {
    log(repo, stage, fmt(counts));
    await onProgress(repo, stage, counts);
  };

  // Fail fast (and readably) on bad config such as the placeholder repos.
  for (const r of repos) {
    try {
      if (!(await fs.stat(r.path)).isDirectory()) throw new Error("not a directory");
    } catch (err) {
      const msg = `Repo "${r.name}": path "${r.path}" is not usable (${(err as Error).message}). Edit repos.config.json.`;
      await emit(r.name, "error", { message: msg });
      throw new Error(msg);
    }
  }

  logHeader(`Indexing ${repos.length} repo(s): ${repos.map((r) => r.name).join(", ")}`);
  const states: RepoState[] = [];

  // ---- Phase 1: ingest ----
  for (const repo of repos) {
    logHeader(`Repo ${repo.name} — ingest`);
    try {
      const walked = await walkRepo(repo.path);
      const sourceFiles = walked.filter((f) => isSourceFile(f.rel));
      await emit(repo.name, "files", { total: walked.length, source: sourceFiles.length, complete: 1 });

      const chunks = await chunkRepo(repo.path, repo.name, walked);
      await emit(repo.name, "chunks", { chunks: chunks.length, files: new Set(chunks.map((c) => c.filePath)).size, complete: 1 });

      const embedded = await embedChunks(chunks, (done, total) => {
        log(repo.name, "embeddings", `${done}/${total}`);
        void onProgress(repo.name, "embeddings", { done, total });
      });
      await clearRepo(repo.name);
      await insertChunks(embedded);
      await emit(repo.name, "embeddings", { done: embedded.length, total: chunks.length, complete: 1 });

      const edges = await extractDependencies(repo.path, repo.name, walked);
      await insertDependencies(repo.name, edges);
      await emit(repo.name, "dependencies", { edges: edges.length, complete: 1 });

      states.push({ repo, chunks, edges, walked });
    } catch (err) {
      failed.add(repo.name);
      await emit(repo.name, "error", { message: (err as Error).message });
    }
  }

  const ok = states;
  if (ok.length === 0) return { failedRepos: [...failed] };

  // ---- Phase 2: cross-repo links ----
  logHeader("Cross-repo links");
  let links: CrossRepoLink[] = [];
  try {
    links = await detectCrossRepoLinks(ok.map((s) => s.repo));
    await replaceCrossRepoLinks(ok.map((s) => s.repo.name), links);
    await emit(SYSTEM_KEY, "cross_repo_links", { links: links.length, complete: 1 });
  } catch (err) {
    await emit(SYSTEM_KEY, "error", { message: `cross-repo links: ${(err as Error).message}` });
    failed.add(SYSTEM_KEY);
  }

  // ---- Phase 3: CLAUDE.md + mindmaps ----
  const modulesByRepo = new Map<string, ModuleDoc[]>();
  for (const s of ok) {
    const { repo } = s;
    logHeader(`Repo ${repo.name} — CLAUDE.md + mindmap`);
    try {
      const modules = await detectModules(repo.path, s.walked);
      log(repo.name, "claude_md", `detected ${modules.length} module(s): ${modules.map((m) => m.dir).join(", ") || "(none)"}`);
      await emit(repo.name, "claude_md", { modules: modules.length, written: 0 });

      let written = 0;
      const docs = await pMap(modules, MODULE_CONCURRENCY, async (m): Promise<ModuleDoc> => {
        const moduleChunks = s.chunks.filter((c) => c.filePath.startsWith(m.dir + "/"));
        const md = await generateModuleClaudeMd(m.dir, moduleChunks, s.edges, { repoName: repo.name, crossRepoLinks: links });
        const rel = await writeGeneratedClaudeMd(repo.path, m.dir, md);
        written++;
        await emit(repo.name, "claude_md", { modules: modules.length, written });
        return { dir: m.dir, summary: extractSummary(md), claudeMdPath: rel };
      });
      modulesByRepo.set(repo.name, docs);

      const rootMd = await generateRootClaudeMd(repo, docs, {
        crossRepoLinks: links,
        fileList: s.walked.filter((f) => !f.rel.includes("/")).map((f) => f.rel),
      });
      await writeGeneratedClaudeMd(repo.path, "", rootMd);
      await emit(repo.name, "claude_md", { modules: modules.length, written, root: 1, complete: 1 });

      await generateMindmaps(repo, docs, links, { outputDir, edges: s.edges });
      await emit(repo.name, "mindmap", { diagrams: 1, complete: 1 });
      await emit(repo.name, "done", { complete: 1 });
    } catch (err) {
      failed.add(repo.name);
      await emit(repo.name, "error", { message: (err as Error).message });
    }
  }

  try {
    await generateSystemMindmap(ok.map((s) => s.repo), links, outputDir);
    await emit(SYSTEM_KEY, "mindmap", { diagrams: 1, complete: 1 });
  } catch (err) {
    failed.add(SYSTEM_KEY);
    await emit(SYSTEM_KEY, "error", { message: `system mindmap: ${(err as Error).message}` });
  }

  logHeader(failed.size ? `Finished with errors in: ${[...failed].join(", ")}` : "Indexing complete");
  return { failedRepos: [...failed] };
}
