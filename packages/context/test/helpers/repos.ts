import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const FIXTURES = path.resolve(import.meta.dirname, "../fixtures");

// An empty config file (os.devNull is not accepted by git on Windows) keeps the developer's own git settings,
// such as signing or hooks, out of the tests.
const EMPTY_CONFIG = path.join(os.tmpdir(), "sdd-test-empty-gitconfig");
fs.writeFileSync(EMPTY_CONFIG, "");

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: EMPTY_CONFIG,
  GIT_CONFIG_NOSYSTEM: "1",
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
}

export function tmpDir(prefix = "sdd-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function write(root: string, rel: string, content: string): void {
  const file = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** Copies a fixture repo into a temp dir (not inside this repository) and optionally makes it a git repo with one commit. */
export function copyFixture(name: string, options: { git?: boolean } = {}): string {
  const dest = path.join(tmpDir(), name);
  fs.cpSync(path.join(FIXTURES, name), dest, { recursive: true });
  if (options.git !== false) {
    git(dest, "init", "-q", "-b", "main");
    git(dest, "add", "-A");
    git(dest, "commit", "-q", "-m", "initial");
  }
  return dest;
}

export function commitAll(repo: string, message: string): string {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

export function head(repo: string): string {
  return git(repo, "rev-parse", "HEAD");
}

export function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export interface Remote {
  /** A file:// URL that git can clone from (tests allow the "file" protocol explicitly). */
  url: string;
  /** The working repo behind the remote: edit and `publish` to give the remote a new commit. */
  work: string;
  publish(files: Record<string, string | null>, message?: string): string;
}

/** A bare "remote" repository, optionally seeded from a fixture, so clone and refresh can be tested without a network. */
export function makeRemote(seed: { fixture: string } | { files: Record<string, string> }): Remote {
  const root = tmpDir("sdd-remote-");
  const work = path.join(root, "work");
  fs.mkdirSync(work);
  if ("fixture" in seed) fs.cpSync(path.join(FIXTURES, seed.fixture), work, { recursive: true });
  else for (const [rel, content] of Object.entries(seed.files)) write(work, rel, content);
  git(work, "init", "-q", "-b", "main");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "initial");
  const bare = path.join(root, "remote.git");
  git(root, "clone", "-q", "--bare", work, bare);
  git(work, "remote", "add", "origin", bare);
  git(work, "fetch", "-q", "origin");
  git(work, "branch", "-q", "--set-upstream-to=origin/main", "main");
  return {
    url: pathToFileURL(bare).href,
    work,
    publish(files, message = "update") {
      for (const [rel, content] of Object.entries(files)) {
        if (content === null) fs.rmSync(path.join(work, ...rel.split("/")), { force: true });
        else write(work, rel, content);
      }
      git(work, "add", "-A");
      git(work, "commit", "-q", "-m", message);
      git(work, "push", "-q", "origin", "main");
      return git(work, "rev-parse", "HEAD");
    },
  };
}
