import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Runs git with an argument array (no shell, so nothing in a path or URL can be interpreted as a command). */
export async function git(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
  timeoutMs?: number,
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
    timeout: timeoutMs ?? 10 * 60_000,
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

// ---------------------------------------------------------------------------------------------------------------------
// Cloning a repo from a URL. The URL comes from a user, so it is checked before git ever sees it.

export const DEFAULT_CLONE_PROTOCOLS = ["https", "ssh"] as const;

export class UnsafeRepoUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeRepoUrlError";
  }
}

export interface CloneOptions {
  /** URL schemes git may use. Default https and ssh; "file" is for tests only. */
  allowedProtocols?: readonly string[];
  /** When non-empty, only these host names may be cloned from (a guard against the server being pointed at internal addresses). */
  allowedHosts?: readonly string[];
  /** Give up after this long. Default 10 minutes. */
  timeoutMs?: number;
}

/**
 * Validates a clone URL and returns it normalised. Rejects: other schemes (git's `ext::` and `file:` transports can run
 * commands or read local files), credentials embedded in the URL (they would be stored in `.git/config` and the database),
 * a leading dash (an option, not a URL), and hosts outside the allow-list.
 */
export function assertSafeCloneUrl(raw: string, options: CloneOptions = {}): URL {
  if (raw.startsWith("-")) throw new UnsafeRepoUrlError("A repo URL cannot start with a dash");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeRepoUrlError(`"${raw}" is not a valid URL`);
  }
  const protocol = url.protocol.replace(/:$/, "");
  const allowed = options.allowedProtocols ?? DEFAULT_CLONE_PROTOCOLS;
  if (!allowed.includes(protocol)) throw new UnsafeRepoUrlError(`The "${protocol}" scheme is not allowed; use ${allowed.join(" or ")}`);
  if (url.password || (protocol !== "ssh" && url.username)) {
    throw new UnsafeRepoUrlError("Credentials in a repo URL are not accepted; use a deploy key or a public URL");
  }
  const hosts = options.allowedHosts ?? [];
  if (hosts.length && !hosts.includes(url.hostname.toLowerCase())) {
    throw new UnsafeRepoUrlError(`Host "${url.hostname}" is not in the allowed list (${hosts.join(", ")})`);
  }
  return url;
}

/** Git's own transport allow-list as `-c` options: nothing is allowed except the listed protocols. */
export const protocolArgs = (allowed: readonly string[]): string[] => [
  "-c",
  "protocol.allow=never",
  ...allowed.flatMap((p) => ["-c", `protocol.${p}.allow=always`]),
];
/** The same allow-list as an environment variable, which git also enforces (for example for submodules and redirects). */
export const protocolEnv = (allowed: readonly string[]): Record<string, string> => ({ GIT_ALLOW_PROTOCOL: allowed.join(":") });

/** Clones `url` into `dest` (which must not exist; its parent must). The full history is fetched so incremental indexing can diff. */
export async function cloneRepo(url: string, dest: string, options: CloneOptions = {}): Promise<void> {
  const safe = assertSafeCloneUrl(url, options);
  const allowed = options.allowedProtocols ?? DEFAULT_CLONE_PROTOCOLS;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await git(
    path.dirname(dest),
    [...protocolArgs(allowed), "clone", "--quiet", "--no-tags", "--", safe.href, dest],
    protocolEnv(allowed),
    options.timeoutMs,
  );
}

/** The URL a clone was made from, or null. */
export async function originUrl(dir: string): Promise<string | null> {
  try {
    return (await git(dir, ["config", "--get", "remote.origin.url"])).trim() || null;
  } catch {
    return null;
  }
}

/** Brings a clone up to date with the remote's default branch and checks it out (we own the cache clone, so local edits are discarded). */
export async function refreshClone(dir: string, options: CloneOptions = {}): Promise<void> {
  const allowed = options.allowedProtocols ?? DEFAULT_CLONE_PROTOCOLS;
  const env = protocolEnv(allowed);
  const base = protocolArgs(allowed);
  await git(dir, [...base, "fetch", "--quiet", "--prune", "--no-tags", "origin"], env, options.timeoutMs);
  await git(dir, [...base, "remote", "set-head", "origin", "--auto"], env, options.timeoutMs).catch(() => undefined);
  await git(dir, ["reset", "--hard", "--quiet", "origin/HEAD"]);
  await git(dir, ["clean", "-fdq"]);
}
