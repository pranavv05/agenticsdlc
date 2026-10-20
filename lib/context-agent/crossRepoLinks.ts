import fs from "node:fs/promises";
import path from "node:path";
import type { CrossRepoLink, RepoConfig } from "./types";
import { walkRepo, type WalkedFile } from "./walk";
import { log } from "./log";

const SCAN_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".json", ".yml", ".yaml", ".toml",
  ".env", ".properties", ".conf", ".ini", ".sh", ".gradle", ".kts", ".xml", ".java", ".kt",
]);
const SKIP_FILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock)$/;
const MAX_SCAN_BYTES = 300_000;
const MAX_EVIDENCE_PER_PAIR = 6;
// Infrastructure hostnames shared by nearly every compose file; matching them says nothing about coupling.
const GENERIC_HOSTS = new Set([
  "db", "database", "redis", "postgres", "postgresql", "mysql", "mongo", "mongodb", "rabbitmq", "kafka",
  "zookeeper", "nginx", "app", "web", "api", "server", "worker", "cache", "localstack", "elasticsearch",
]);

function isScannable(rel: string): boolean {
  if (SKIP_FILES.test(rel)) return false;
  const base = path.posix.basename(rel);
  if (/^\.env/.test(base) || /^docker-compose/.test(base) || /^compose\.ya?ml$/.test(base) || /^Dockerfile/.test(base)) return true;
  return SCAN_EXTS.has(path.posix.extname(rel).toLowerCase());
}

function isComposeFile(rel: string): boolean {
  const base = path.posix.basename(rel);
  return /^docker-compose.*\.ya?ml$/.test(base) || /^compose\.ya?ml$/.test(base);
}

/** Service names (and container_name values) declared in a repo's docker-compose files. */
async function composeHostnames(files: WalkedFile[]): Promise<Set<string>> {
  const hosts = new Set<string>();
  for (const f of files.filter((x) => isComposeFile(x.rel))) {
    const lines = (await fs.readFile(f.abs, "utf8")).split(/\r?\n/);
    let inServices = false;
    let serviceIndent = -1;
    for (const line of lines) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const indent = line.length - line.trimStart().length;
      if (indent === 0) {
        inServices = /^services\s*:/.test(line);
        serviceIndent = -1;
        continue;
      }
      if (!inServices) continue;
      if (serviceIndent === -1) serviceIndent = indent;
      const key = /^\s*([A-Za-z0-9._-]+)\s*:\s*$/.exec(line);
      if (key && indent === serviceIndent) hosts.add(key[1].toLowerCase());
      const cn = /^\s*container_name\s*:\s*["']?([A-Za-z0-9._-]+)/.exec(line);
      if (cn) hosts.add(cn[1].toLowerCase());
    }
  }
  return hosts;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches "my-repo", "my_repo", "my repo" interchangeably, not embedded in a longer identifier. */
function nameRegex(name: string): RegExp {
  const body = name.split(/[-_ ]+/).map(escapeRe).join("[-_ ]?");
  return new RegExp(`(?<![A-Za-z0-9_-])${body}(?![A-Za-z0-9_-])`, "i");
}

/**
 * For each repo, look in its code/config/compose/.env files for mentions of the other
 * configured repos' names or of service hostnames declared in their docker-compose files.
 */
export async function detectCrossRepoLinks(repos: RepoConfig[]): Promise<CrossRepoLink[]> {
  const walks = new Map<string, WalkedFile[]>();
  for (const r of repos) walks.set(r.name, await walkRepo(r.path));

  const hostsByRepo = new Map<string, Set<string>>();
  for (const r of repos) {
    const hosts = await composeHostnames(walks.get(r.name)!);
    const usable = new Set([...hosts].filter((h) => h.length >= 4 && !GENERIC_HOSTS.has(h)));
    hostsByRepo.set(r.name, usable);
    log(r.name, "cross_repo_links", `compose hostnames: ${usable.size ? [...usable].join(", ") : "(none)"}`);
  }

  const links: CrossRepoLink[] = [];
  for (const from of repos) {
    const files = walks.get(from.name)!.filter((f) => isScannable(f.rel) && f.size <= MAX_SCAN_BYTES);
    const contents = new Map<string, string[]>();
    for (const f of files) contents.set(f.rel, (await fs.readFile(f.abs, "utf8")).split(/\r?\n/));

    for (const to of repos) {
      if (to.name === from.name) continue;
      const matchers: { label: string; re: RegExp }[] = [{ label: `repo name "${to.name}"`, re: nameRegex(to.name) }];
      for (const h of hostsByRepo.get(to.name) ?? []) matchers.push({ label: `service host "${h}"`, re: nameRegex(h) });

      const evidence: string[] = [];
      outer: for (const [rel, lines] of contents) {
        for (let i = 0; i < lines.length; i++) {
          const hit = matchers.find((m) => m.re.test(lines[i]));
          if (!hit) continue;
          evidence.push(`${rel}:${i + 1} mentions ${hit.label}: ${lines[i].trim().slice(0, 140)}`);
          if (evidence.length >= MAX_EVIDENCE_PER_PAIR) break outer;
        }
      }
      if (evidence.length) {
        links.push({ fromRepo: from.name, toRepo: to.name, evidence });
        log(from.name, "cross_repo_links", `-> ${to.name}: ${evidence.length} evidence line(s)`);
      }
    }
  }
  return links;
}
