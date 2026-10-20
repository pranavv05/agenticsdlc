import fs from "node:fs/promises";
import path from "node:path";
import type { ChunkRecord, CrossRepoLink, DependencyEdge, ModuleDoc, ModuleInfo, RepoConfig } from "./types";
import { isSourceFile } from "./parse";
import { walkRepo, GENERATED_CLAUDE_MD, type WalkedFile } from "./walk";
import { complete } from "./llm";

const MODULE_NAME_RE = /^(services?|controllers?|routes?|modules?|apps?|packages?)$/;
const MANIFESTS = new Set(["package.json", "pyproject.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts"]);
const MIN_SOURCE_FILES = 8;
const MAX_MODULES = Number(process.env.MAX_MODULES_PER_REPO) || 25;
const CODE_BUDGET_CHARS = 40_000;

const SYSTEM_PROMPT =
  "You are a senior engineer writing CLAUDE.md context files that help AI coding agents work in an unfamiliar codebase. " +
  "Be concrete and terse. Only state what the provided code supports; write 'none detected' rather than guessing. " +
  "Output Markdown only, with no preamble and no code fences around the whole document.";

export function claudeMdRelPath(dir: string): string {
  return dir ? `${dir}/${GENERATED_CLAUDE_MD}` : GENERATED_CLAUDE_MD;
}

const inDir = (file: string, dir: string) => (dir ? file.startsWith(dir + "/") : true);

/**
 * Candidate module directories: own manifest (package.json / pyproject.toml / go.mod), OR 8+ direct
 * source files, OR a conventional name (services, routes, ...) or a direct child of one.
 * Pure container dirs (matched only by name, no files of their own, with qualifying children) are dropped
 * so we don't document both `modules/` and every `modules/<x>/`.
 */
export async function detectModules(repoPath: string, walked?: WalkedFile[]): Promise<ModuleInfo[]> {
  const files = walked ?? (await walkRepo(repoPath));
  const directSource = new Map<string, number>();
  const subtreeSource = new Map<string, number>();
  const manifestDirs = new Set<string>();
  const dirs = new Set<string>();

  for (const f of files) {
    const parts = f.rel.split("/");
    const dir = parts.slice(0, -1).join("/");
    for (let i = 1; i <= parts.length - 1; i++) dirs.add(parts.slice(0, i).join("/"));
    if (MANIFESTS.has(parts[parts.length - 1]) && dir) manifestDirs.add(dir);
    if (isSourceFile(f.rel)) {
      directSource.set(dir, (directSource.get(dir) ?? 0) + 1);
      for (let i = 1; i <= parts.length - 1; i++) {
        const d = parts.slice(0, i).join("/");
        subtreeSource.set(d, (subtreeSource.get(d) ?? 0) + 1);
      }
    }
  }

  const candidates = [...dirs].filter((d) => {
    if (!subtreeSource.get(d)) return false;
    const parts = d.split("/");
    const base = parts[parts.length - 1];
    const parent = parts.length > 1 ? parts[parts.length - 2] : "";
    return (
      manifestDirs.has(d) ||
      (directSource.get(d) ?? 0) >= MIN_SOURCE_FILES ||
      MODULE_NAME_RE.test(base) ||
      MODULE_NAME_RE.test(parent)
    );
  });

  const pruned = candidates.filter((d) => {
    const hasChildCandidate = candidates.some((c) => c.startsWith(d + "/") && c.split("/").length === d.split("/").length + 1);
    const ownFiles = (directSource.get(d) ?? 0) > 0 || manifestDirs.has(d);
    return !(hasChildCandidate && !ownFiles);
  });

  return pruned
    .sort((a, b) => (subtreeSource.get(b) ?? 0) - (subtreeSource.get(a) ?? 0) || a.localeCompare(b))
    .slice(0, MAX_MODULES)
    .sort()
    .map((d) => ({ dir: d, name: d.split("/").pop()! }));
}

function summariseChunks(chunks: ChunkRecord[]): string {
  const symbols = chunks.map((c) => `- ${c.filePath}:${c.startLine}-${c.endLine} [${c.chunkType}] ${c.symbolName ?? "(anonymous)"}`);
  let budget = CODE_BUDGET_CHARS;
  const code: string[] = [];
  for (const c of chunks) {
    if (budget <= 0) break;
    const body = c.code.slice(0, Math.min(1800, budget));
    budget -= body.length;
    code.push(`### ${c.filePath} :: ${c.symbolName ?? ""}\n\`\`\`\n${body}\n\`\`\``);
  }
  return `## Symbols (${chunks.length})\n${symbols.join("\n")}\n\n## Code\n${code.join("\n\n")}`;
}

/** Ask Claude for a module-level CLAUDE.md (purpose, exports, conventions, "Connects to"). */
export async function generateModuleClaudeMd(
  moduleDir: string,
  chunks: ChunkRecord[],
  dependencyEdges: DependencyEdge[],
  opts: { repoName?: string; crossRepoLinks?: CrossRepoLink[] } = {},
): Promise<string> {
  const own = chunks.filter((c) => inDir(c.filePath, moduleDir));
  const outgoing = dependencyEdges.filter((e) => inDir(e.filePath, moduleDir) && !inDir(e.importsFilePath, moduleDir));
  const incoming = dependencyEdges.filter((e) => !inDir(e.filePath, moduleDir) && inDir(e.importsFilePath, moduleDir));
  const internal = dependencyEdges.filter((e) => inDir(e.filePath, moduleDir) && inDir(e.importsFilePath, moduleDir));
  const repo = opts.repoName ?? "the repo";
  const cross = (opts.crossRepoLinks ?? []).filter((l) => l.fromRepo === repo || l.toRepo === repo);

  const fmt = (es: DependencyEdge[]) => (es.length ? es.slice(0, 60).map((e) => `- ${e.filePath} -> ${e.importsFilePath}`).join("\n") : "(none)");
  const prompt = `Write the CLAUDE.md for the module \`${moduleDir}\` of repo \`${repo}\`.

Required structure (Markdown):
# ${moduleDir}
A single-sentence summary on the line directly under the heading (no label, no bold).
## Purpose
## Key exports / entry points
## Conventions   (patterns inferred from the code: naming, error handling, validation, data access, tests)
## Connects to   (subsections "Intra-repo" and "Cross-repo"; cite file paths)

# Dependency edges (file -> file imported)
Within this module (${internal.length}):
${fmt(internal)}
This module imports from other modules (${outgoing.length}):
${fmt(outgoing)}
Other modules import this module (${incoming.length}):
${fmt(incoming)}

# Cross-repo links involving ${repo}
${cross.length ? cross.map((l) => `- ${l.fromRepo} -> ${l.toRepo}: ${l.evidence.slice(0, 3).join(" | ")}`).join("\n") : "(none detected)"}

# Module code
${summariseChunks(own)}`;

  return complete(SYSTEM_PROMPT, prompt, 3000);
}

/** First prose line under the top heading, used for the root index table. */
export function extractSummary(md: string): string {
  for (const line of md.split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith("#")) return t.replace(/\|/g, "\\|").slice(0, 240);
  }
  return "(no summary)";
}

async function readIfExists(file: string, max: number): Promise<string> {
  try {
    return (await fs.readFile(file, "utf8")).slice(0, max);
  } catch {
    return "";
  }
}

async function discoverCommands(repoPath: string): Promise<string> {
  const lines: string[] = [];
  const pkg = await readIfExists(path.join(repoPath, "package.json"), 100_000);
  if (pkg) {
    try {
      const scripts = (JSON.parse(pkg) as { scripts?: Record<string, string> }).scripts ?? {};
      for (const [k, v] of Object.entries(scripts)) lines.push(`- \`npm run ${k}\` — \`${v}\``);
    } catch {
      /* malformed package.json */
    }
  }
  const make = await readIfExists(path.join(repoPath, "Makefile"), 100_000);
  if (make) {
    const targets = [...make.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)/gm)].map((m) => m[1]).filter((t) => !t.startsWith("."));
    for (const t of [...new Set(targets)].slice(0, 15)) lines.push(`- \`make ${t}\``);
  }
  return lines.length ? lines.join("\n") : "No build/test/lint commands discovered (no package.json scripts or Makefile).";
}

/** Root CLAUDE.md: Claude-written overview + deterministic commands and module index table. */
export async function generateRootClaudeMd(
  repo: RepoConfig,
  modules: ModuleDoc[],
  opts: { crossRepoLinks?: CrossRepoLink[]; fileList?: string[] } = {},
): Promise<string> {
  const readme = await readIfExists(path.join(repo.path, "README.md"), 4000);
  const commands = await discoverCommands(repo.path);
  const cross = (opts.crossRepoLinks ?? []).filter((l) => l.fromRepo === repo.name || l.toRepo === repo.name);

  const prompt = `Write the "Overview" section body for the root CLAUDE.md of repo \`${repo.name}\` (${repo.description}).
Two or three short paragraphs: what the system does, main tech stack, and how the code is organised. No heading, no lists of commands.

# README excerpt
${readme || "(no README)"}

# Top-level files
${(opts.fileList ?? []).slice(0, 80).join("\n") || "(unknown)"}

# Module summaries
${modules.map((m) => `- ${m.dir}: ${m.summary}`).join("\n") || "(no modules detected)"}

# Cross-repo links
${cross.length ? cross.map((l) => `- ${l.fromRepo} -> ${l.toRepo}`).join("\n") : "(none detected)"}`;

  const overview = await complete(SYSTEM_PROMPT, prompt, 1200);

  const table = modules.length
    ? ["| Module | Summary | CLAUDE.md |", "| --- | --- | --- |", ...modules.map((m) => `| \`${m.dir}\` | ${m.summary} | \`${m.claudeMdPath}\` |`)].join("\n")
    : "_No modules detected._";

  return `# ${repo.name}\n\n> ${repo.description}\n\n## Overview\n\n${overview}\n\n## Commands\n\n${commands}\n\n## Modules\n\n${table}\n`;
}

/** Write <repo>/<dir>/CLAUDE.md.generated.md. Never touches an actual CLAUDE.md. */
export async function writeGeneratedClaudeMd(repoPath: string, dir: string, content: string): Promise<string> {
  const rel = claudeMdRelPath(dir);
  const abs = path.join(repoPath, ...rel.split("/"));
  await fs.writeFile(abs, content.endsWith("\n") ? content : content + "\n", "utf8");
  return rel;
}
