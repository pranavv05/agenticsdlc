import { generateText, wrapUntrusted } from "@sdd/llm";
import type { CrossRepoLink, DependencyEdge, ModuleDoc, RepoTarget } from "./types";

const SYSTEM_PROMPT =
  "You produce Mermaid diagrams for software architecture documentation. " +
  'Rules: use `flowchart LR`; node ids must be simple alphanumerics (A, B, mod1...); put every label in double quotes, e.g. A["billing"]; ' +
  "no parentheses, brackets or colons inside labels; output exactly one ```mermaid fenced block followed by a short prose explanation (3-6 sentences). " +
  "Only draw relationships supported by the input.";

export interface Mindmap {
  mermaid: string;
  prose: string;
}

/** One mindmap call through the gateway. `name` becomes the usage record name and the mock fixture key. */
async function generateDiagram(name: string, prompt: string): Promise<string> {
  const { text } = await generateText({ agent: "context", name, system: SYSTEM_PROMPT, input: prompt, maxTokens: 2000 });
  return text;
}

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

function fallbackRepoDiagram(repo: RepoTarget, modules: ModuleDoc[], edges: ReturnType<typeof moduleEdges>): string {
  const id = (d: string) => "m_" + d.replace(/[^A-Za-z0-9]/g, "_");
  const lines = ["flowchart LR", `  root["${repo.name}"]`];
  for (const m of modules) lines.push(`  ${id(m.dir)}["${m.dir}"]`, `  root --> ${id(m.dir)}`);
  for (const e of edges) lines.push(`  ${id(e.from)} -->|imports| ${id(e.to)}`);
  return lines.join("\n");
}

/** Per-repo mindmap: one Mermaid diagram plus a short explanation of the repo's internal module structure. */
export async function generateMindmap(
  repo: RepoTarget,
  modules: ModuleDoc[],
  crossRepoLinks: CrossRepoLink[],
  opts: { edges?: DependencyEdge[] } = {},
): Promise<Mindmap> {
  const edges = moduleEdges(modules, opts.edges ?? []);
  const cross = crossRepoLinks.filter((l) => l.fromRepo === repo.id || l.toRepo === repo.id);
  const prompt = `Draw the internal module structure of repo "${repo.name}".

Modules:
${wrapUntrusted("module-summaries", modules.map((m) => `- ${m.dir}: ${m.summary}`).join("\n") || "(none detected)")}

Module-to-module import edges (from -> to, number of file imports):
${wrapUntrusted("module-edges", edges.map((e) => `- ${e.from} -> ${e.to} (${e.count})`).join("\n") || "(none)")}

Cross-repo links touching this repo (mention in prose only, do not draw other repos):
${cross.map((l) => `- ${l.fromRepo} -> ${l.toRepo}`).join("\n") || "(none)"}`;

  const { mermaid, prose } = splitResponse(await generateDiagram("repo-mindmap", prompt));
  return { mermaid: mermaid ?? fallbackRepoDiagram(repo, modules, edges), prose };
}

/** System-level mindmap: every repo as a node, connected via cross-repo links. */
export async function generateSystemMindmap(repos: RepoTarget[], crossRepoLinks: CrossRepoLink[]): Promise<Mindmap> {
  const prompt = `Draw the system-level architecture: every repo below is a node; connect repos using the links (arrow from -> to).

Repos:
${wrapUntrusted("repos", repos.map((r) => `- ${r.name}`).join("\n"))}

Links with evidence:
${wrapUntrusted("links", crossRepoLinks.map((l) => `- ${l.fromRepo} -> ${l.toRepo}: ${l.evidence.slice(0, 2).join(" | ")}`).join("\n") || "(none detected; show repos as unconnected nodes)")}`;

  const { mermaid, prose } = splitResponse(await generateDiagram("system-mindmap", prompt));
  const id = (repoId: string) => "r_" + repoId.replace(/[^A-Za-z0-9]/g, "_");
  const fallback = [
    "flowchart LR",
    ...repos.map((r) => `  ${id(r.id)}["${r.name}"]`),
    ...crossRepoLinks
      .filter((l) => repos.some((r) => r.id === l.fromRepo) && repos.some((r) => r.id === l.toRepo))
      .map((l) => `  ${id(l.fromRepo)} --> ${id(l.toRepo)}`),
  ].join("\n");
  return { mermaid: mermaid ?? fallback, prose };
}
