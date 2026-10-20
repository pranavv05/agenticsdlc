import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  UnsafeRepoUrlError,
  assertSafeCloneUrl,
  cloneRepo,
  git as productGit,
  originUrl,
  protocolArgs,
  protocolEnv,
  refreshClone,
} from "../src/git";
import { git, head, makeRemote, rmrf, tmpDir, write } from "./helpers/repos";

const dirs: string[] = [];
const fresh = () => {
  const d = tmpDir("sdd-clone-");
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach(rmrf));
const FILE = { allowedProtocols: ["file"] } as const;

describe("assertSafeCloneUrl", () => {
  it.each([
    "https://github.com/org/repo.git",
    "https://gitlab.example.com/group/sub/repo",
    "ssh://git@github.com/org/repo.git",
    "ssh://github.com/org/repo.git",
  ])("accepts %s", (url) => {
    expect(() => assertSafeCloneUrl(url)).not.toThrow();
  });

  it.each([
    ["the file scheme (reads local files)", "file:///etc/passwd"],
    ["git's ext transport (runs commands)", "ext::sh -c touch% /tmp/pwned"],
    ["plain http", "http://example.com/org/repo.git"],
    ["the git protocol", "git://example.com/org/repo.git"],
    ["ftp", "ftp://example.com/repo"],
    ["an option masquerading as a URL", "--upload-pack=touch /tmp/pwned"],
    ["a single dash option", "-oProxyCommand=id"],
    ["credentials with a password", "https://user:secret@github.com/org/repo.git"],
    ["a token as the user name", "https://ghp_abc123@github.com/org/repo.git"],
    ["a password on ssh", "ssh://git:secret@github.com/org/repo.git"],
    ["scp-style syntax", "git@github.com:org/repo.git"],
    ["a plain path", "/home/me/repo"],
    ["nothing", ""],
  ])("rejects %s", (_label, url) => {
    expect(() => assertSafeCloneUrl(url)).toThrow(UnsafeRepoUrlError);
  });

  it("enforces a host allow-list, case-insensitively, when one is given", () => {
    const opts = { allowedHosts: ["github.com", "gitlab.example.com"] };
    expect(() => assertSafeCloneUrl("https://github.com/o/r", opts)).not.toThrow();
    expect(() => assertSafeCloneUrl("https://GitLab.Example.com/o/r", opts)).not.toThrow();
    expect(() => assertSafeCloneUrl("https://169.254.169.254/latest", opts)).toThrow(/not in the allowed list/);
    expect(() => assertSafeCloneUrl("https://localhost/o/r", opts)).toThrow(UnsafeRepoUrlError);
    expect(() => assertSafeCloneUrl("https://anything.example/o/r", { allowedHosts: [] })).not.toThrow();
  });

  it("allows only the protocols it is told to", () => {
    expect(() => assertSafeCloneUrl("file:///tmp/x", FILE)).not.toThrow();
    expect(() => assertSafeCloneUrl("https://github.com/o/r", FILE)).toThrow(UnsafeRepoUrlError);
  });
});

describe("cloneRepo / refreshClone (against a local bare repository)", () => {
  it("clones the full history and remembers the origin", async () => {
    const remote = makeRemote({ files: { "a.ts": "export const a = 1;\n" } });
    remote.publish({ "b.ts": "export const b = 2;\n" }, "second");
    const dest = path.join(fresh(), "clone");
    await cloneRepo(remote.url, dest, FILE);

    expect(fs.existsSync(path.join(dest, "a.ts"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "b.ts"))).toBe(true);
    expect(git(dest, "rev-list", "--count", "HEAD")).toBe("2"); // history is there, so incremental indexing can diff
    expect(await originUrl(dest)).toBe(remote.url);
    expect(head(dest)).toBe(head(remote.work));
  });

  it("refuses to clone over the default protocol list and never contacts the URL", async () => {
    const remote = makeRemote({ files: { "a.ts": "x" } });
    const dest = path.join(fresh(), "clone");
    await expect(cloneRepo(remote.url, dest)).rejects.toBeInstanceOf(UnsafeRepoUrlError);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("fails clearly when the remote does not exist", async () => {
    const dest = path.join(fresh(), "clone");
    await expect(cloneRepo("file:///definitely/not/here.git", dest, FILE)).rejects.toThrow();
    expect(fs.existsSync(path.join(dest, ".git"))).toBe(false);
  });

  it("refresh brings the clone to the remote's latest commit, discarding local edits", async () => {
    const remote = makeRemote({ files: { "a.ts": "export const a = 1;\n" } });
    const dest = path.join(fresh(), "clone");
    await cloneRepo(remote.url, dest, FILE);
    const first = head(dest);

    const second = remote.publish({ "a.ts": "export const a = 99;\n", "new.ts": "export const n = 1;\n" }, "update");
    write(dest, "a.ts", "local edit that must not survive");
    write(dest, "junk.ts", "untracked junk");
    await refreshClone(dest, FILE);

    expect(head(dest)).toBe(second);
    expect(head(dest)).not.toBe(first);
    // git may convert line endings on checkout (Windows), so compare content, not bytes
    expect(fs.readFileSync(path.join(dest, "a.ts"), "utf8").replace(/\r\n/g, "\n")).toBe("export const a = 99;\n");
    expect(fs.existsSync(path.join(dest, "new.ts"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "junk.ts"))).toBe(false);
    // checked with the same git settings the clone was made with (the test helper ignores the developer's autocrlf)
    expect((await productGit(dest, ["status", "--porcelain"])).trim()).toBe("");
  });

  it("refresh follows files deleted upstream", async () => {
    const remote = makeRemote({ files: { "keep.ts": "k", "drop.ts": "d" } });
    const dest = path.join(fresh(), "clone");
    await cloneRepo(remote.url, dest, FILE);
    remote.publish({ "drop.ts": null }, "delete");
    await refreshClone(dest, FILE);
    expect(fs.existsSync(path.join(dest, "drop.ts"))).toBe(false);
  });

  it("originUrl is null outside a git repo", async () => {
    expect(await originUrl(fresh())).toBeNull();
  });
});

describe("git's own protocol restrictions (a second layer behind URL validation)", () => {
  // `ls-remote` contacts the remote without cloning, which is enough to see whether git allows the transport.
  const contact = (remoteUrl: string, args: string[], env: Record<string, string | undefined> = {}) =>
    productGit(fresh(), [...args, "ls-remote", remoteUrl], env);

  it("works for an allowed protocol through either mechanism", async () => {
    const remote = makeRemote({ files: { "a.ts": "x" } });
    await expect(contact(remote.url, protocolArgs(["file"]))).resolves.toContain("refs/heads/main");
    await expect(contact(remote.url, [], protocolEnv(["file"]))).resolves.toContain("refs/heads/main");
  });

  it("-c protocol.allow=never alone blocks a protocol that was not listed", async () => {
    const remote = makeRemote({ files: { "a.ts": "x" } });
    await expect(contact(remote.url, protocolArgs(["https"]))).rejects.toThrow(/not allowed|disallowed/i);
  });

  it("GIT_ALLOW_PROTOCOL alone blocks a protocol that was not listed", async () => {
    const remote = makeRemote({ files: { "a.ts": "x" } });
    await expect(contact(remote.url, [], protocolEnv(["https"]))).rejects.toThrow(/not allowed|disallowed/i);
  });

  it("blocks git's command-running ext transport even when nothing else would", async () => {
    await expect(contact("ext::sh -c echo% pwned", protocolArgs(["https", "ssh"]), protocolEnv(["https", "ssh"]))).rejects.toThrow();
    await expect(contact("ext::sh -c echo% pwned", protocolArgs(["https", "ssh"]))).rejects.toThrow(/not allowed|disallowed/i);
  });
});
