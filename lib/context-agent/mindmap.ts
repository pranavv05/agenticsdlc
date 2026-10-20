import fs from "node:fs/promises";
import path from "node:path";
import type { CrossRepoLink, DependencyEdge, ModuleDoc, RepoConfig } from "./types";
import { complete } from "./llm";
import { safeName } from "./config";

const SYSTEM_PROMPT =
  "You produce Mermaid diagrams for software architecture documentation. " +
  "Rules: use `flowchart LR`; node ids must be simple alphanumerics (A, B, mod1...); put every label in double quotes, e.g. A[\"billing\"]; " +
  "no parentheses, brackets or colons inside labels; output exactly one ```mermaid fenced block followed by a short prose explanation (3-6 sentences). " +
  "Only draw relationships supported by the input.";

function splitResponse(text: string): { mermaid: string | null; prose: string } {
  const m = /```mermaid\s*\n([\s\S]*?)```/.exec(text);
  if (!m) return { mermaid: null, prose: text.trim() };
  return { mermaid: m[1].trim(), prose: text.replace(m[0], "").trim() };
}

function moduleOf(file: string, modules: ModuleDoc[]): string | null {
  // deepest matching module wins
  let best: string | null = null;
  for (const m of modules) {
    if (file.startsWith(m.dir + "/") && (!best || m.dir.length > best.length)) best = m.dir;
  }
  return best;
}

/** Aggregate file-level import edges into module -> module edges with counts. */
function moduleEdges(modules: ModuleDoc[], edges: DependencyEdge[]): { from: string; to: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const e of edges) {
    const a = moduleOf(e.filePath, modules);
    const b = moduleOf(e.importsFilePath, modules);
    if (a && b && a !== b) counts.set(`${a}\u0000${b}`, (counts.get(`${a}\u0000${b}`) ?? 0) + 1);
  }
  return [...counts].map(([k, count]) => {
    const [from, to] = k.split("\u0000");
    return { from, to, count };
  });
}

function fallbackRepoDiagram(repo: RepoConfig, modules: ModuleDoc[], edges: ReturnType<typeof moduleEdges>): string {
  const id = (d: string) => "m_" + d.replace(/[^A-Za-z0-9]/g, "_");
  const lines = ["flowchart LR", `  root["${repo.name}"]`];
  for (const m of modules) lines.push(`  ${id(m.dir)}["${m.dir}"]`, `  root --> ${id(m.dir)}`);
  for (const e of edges) lines.push(`  ${id(e.from)} -->|imports| ${id(e.to)}`);
  return lines.join("\n");
}

async function write(outDir: string, base: string, mermaid: string, prose: string, title: string): Promise<void> {
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, `${base}.mmd`), mermaid + "\n", "utf8");
  await fs.writeFile(path.join(outDir, `${base}.md`), `# ${title}\n\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n\n${prose}\n`, "utf8");
}

/**
 * Per-repo mindmap: one Mermaid diagram + short prose showing the repo's internal module structure.
 * Writes output/<repo>.mmd and output/<repo>.md.
 */
export async function generateMindmaps(
  repo: RepoConfig,
  modules: ModuleDoc[],
  crossRepoLinks: CrossRepoLink[],
  opts: { outputDir: string; edges?: DependencyEdge[] },
): Promise<{ mermaid: string; prose: string }> {
  const edges = moduleEdges(modules, opts.edges ?? []);
  const cross = crossRepoLinks.filter((l) => l.fromRepo === repo.name || l.toRepo === repo.name);
  const prompt = `Draw the internal module structure of repo "${repo.name}" (${repo.description}).

Modules:
${modules.map((m) => `- ${m.dir}: ${m.summary}`).join("\n") || "(none detected)"}

Module-to-module import edges (from -> to, number of file imports):
${edges.map((e) => `- ${e.from} -> ${e.to} (${e.count})`).join("\n") || "(none)"}

Cross-repo links touching this repo (mention in prose only, do not draw other repos):
${cross.map((l) => `- ${l.fromRepo} -> ${l.toRepo}`).join("\n") || "(none)"}`;

  const { mermaid, prose } = splitResponse(await complete(SYSTEM_PROMPT, prompt, 2000));
  const finalMermaid = mermaid ?? fallbackRepoDiagram(repo, modules, edges);
  await write(opts.outputDir, safeName(repo.name), finalMermaid, prose, `${repo.name} — module structure`);
  return { mermaid: finalMermaid, prose };
}

/** System-level mindmap: every configured repo as a node, connected via crossRepoLinks. */
export async function generateSystemMindmap(
  repos: RepoConfig[],
  crossRepoLinks: CrossRepoLink[],
  outputDir: string,
): Promise<{ mermaid: string; prose: string }> {
  const prompt = `Draw the system-level architecture: every repo below is a node; connect repos using the links (arrow from -> to).

Repos:
${repos.map((r) => `- ${r.name}: ${r.description}`).join("\n")}

Links with evidence:
${crossRepoLinks.map((l) => `- ${l.fromRepo} -> ${l.toRepo}: ${l.evidence.slice(0, 2).join(" | ")}`).join("\n") || "(none detected; show repos as unconnected nodes)"}`;

  const { mermaid, prose } = splitResponse(await complete(SYSTEM_PROMPT, prompt, 2000));
  const id = (n: string) => "r_" + n.replace(/[^A-Za-z0-9]/g, "_");
  const fallback = ["flowchart LR", ...repos.map((r) => `  ${id(r.name)}["${r.name}"]`), ...crossRepoLinks.map((l) => `  ${id(l.fromRepo)} --> ${id(l.toRepo)}`)].join("\n");
  const finalMermaid = mermaid ?? fallback;
  await write(outputDir, "system", finalMermaid, prose, "System overview");
  return { mermaid: finalMermaid, prose };
}
