import fs from "node:fs";
import path from "node:path";
import { slugifyRepoId } from "./repoId";
import type { RepoConfig, RepoTarget } from "./types";

/** Reads the prototype's repos.config.json. Temporary: the repo registry replaces it. */
export function loadRepoConfig(file = path.join(process.cwd(), "repos.config.json")): RepoConfig[] {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${file} must contain a JSON array`);
  for (const r of parsed) {
    if (!r?.name || !r?.path) throw new Error(`Each repo in ${file} needs { name, path, description }`);
  }
  return parsed as RepoConfig[];
}

export function repoConfigToTarget(config: RepoConfig): RepoTarget {
  return { id: slugifyRepoId(config.name), name: config.name, path: path.resolve(config.path) };
}
