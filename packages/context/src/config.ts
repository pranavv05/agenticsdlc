import fs from "node:fs";
import path from "node:path";
import type { RepoConfig } from "./types";

export function loadRepoConfig(file = path.join(process.cwd(), "repos.config.json")): RepoConfig[] {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${file} must contain a JSON array`);
  for (const r of parsed) {
    if (!r?.name || !r?.path) throw new Error(`Each repo in ${file} needs { name, path, description }`);
  }
  return parsed as RepoConfig[];
}

export function defaultOutputDir(): string {
  return path.join(process.cwd(), "output");
}

export function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}
