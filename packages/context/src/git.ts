import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Runs git with an argument array (no shell, so nothing in a path or URL can be interpreted as a command). */
export async function git(cwd: string, args: string[], extraEnv: Record<string, string | undefined> = {}): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extraEnv },
  });
  return stdout;
}

const same = async (a: string, b: string): Promise<boolean> => {
  const [ra, rb] = await Promise.all([fs.realpath(a), fs.realpath(b)]);
  return path.resolve(ra).toLowerCase() === path.resolve(rb).toLowerCase();
};

/**
 * True only when `dir` is the root of its own git repository. A folder that merely sits inside some other repo
 * (a test fixture, a vendored copy) is not treated as one: its HEAD would describe the outer repo.
 */
export async function isRepoRoot(dir: string): Promise<boolean> {
  try {
    const top = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
    return top !== "" && (await same(top, dir));
  } catch {
    return false;
  }
}

export interface WorkingTreeState {
  /** HEAD commit. */
  sha: string;
  /** True when tracked files have uncommitted changes or there are untracked, non-ignored files. */
  dirty: boolean;
}

/** HEAD and cleanliness of a repo's working tree, or null for a directory that is not a git repo root (or has no commits). */
export async function workingTreeState(dir: string): Promise<WorkingTreeState | null> {
  if (!(await isRepoRoot(dir))) return null;
  try {
    const sha = (await git(dir, ["rev-parse", "HEAD"])).trim();
    const status = await git(dir, ["status", "--porcelain", "--untracked-files=normal"]);
    return { sha, dirty: status.trim() !== "" };
  } catch {
    return null;
  }
}

export interface DiffEntry {
  status: "A" | "M" | "D" | "R";
  /** Path after the change. */
  path: string;
  /** Previous path, for renames. */
  oldPath?: string;
}

/** Files changed between two commits, or null when `from` is not a commit in this repo (history rewritten, shallow clone). */
export async function diffFiles(dir: string, from: string, to: string): Promise<DiffEntry[] | null> {
  try {
    await git(dir, ["cat-file", "-e", `${from}^{commit}`]);
  } catch {
    return null;
  }
  const out = await git(dir, ["diff", "--name-status", "-M", "-z", from, to]);
  const tokens = out.split("\0");
  const entries: DiffEntry[] = [];
  for (let i = 0; i < tokens.length;) {
    const status = tokens[i++];
    if (!status) continue;
    const letter = status[0];
    if (letter === "R" || letter === "C") {
      const oldPath = tokens[i++];
      const newPath = tokens[i++];
      // a copy leaves the original in place, so it only adds a file
      entries.push(letter === "R" ? { status: "R", path: newPath, oldPath } : { status: "A", path: newPath });
    } else if (letter === "A" || letter === "M" || letter === "D") {
      entries.push({ status: letter, path: tokens[i++] });
    } else {
      entries.push({ status: "M", path: tokens[i++] }); // T (type change), U, X: treat as modified
    }
  }
  return entries;
}
