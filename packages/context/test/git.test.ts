import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diffFiles, isRepoRoot, workingTreeState } from "../src/git";
import { commitAll, git, head, rmrf, tmpDir, write } from "./helpers/repos";

const dirs: string[] = [];
const fresh = () => {
  const d = tmpDir();
  dirs.push(d);
  return d;
};
const repoWith = (files: Record<string, string>) => {
  const dir = fresh();
  git(dir, "init", "-q", "-b", "main");
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  commitAll(dir, "initial");
  return dir;
};
afterEach(() => dirs.splice(0).forEach(rmrf));

describe("isRepoRoot / workingTreeState", () => {
  it("is null / false for a plain folder", async () => {
    const dir = fresh();
    write(dir, "a.ts", "export {}");
    expect(await isRepoRoot(dir)).toBe(false);
    expect(await workingTreeState(dir)).toBeNull();
  });

  it("is null for a folder that merely sits inside another repository", async () => {
    const outer = repoWith({ "outer.ts": "x", "inner/a.ts": "y" });
    const inner = path.join(outer, "inner");
    expect(await isRepoRoot(outer)).toBe(true);
    expect(await isRepoRoot(inner)).toBe(false);
    expect(await workingTreeState(inner)).toBeNull();
  });

  it("is null for a repository without commits", async () => {
    const dir = fresh();
    git(dir, "init", "-q", "-b", "main");
    write(dir, "a.ts", "x");
    expect(await workingTreeState(dir)).toBeNull();
  });

  it("reports HEAD and a clean tree", async () => {
    const dir = repoWith({ "a.ts": "x" });
    expect(await workingTreeState(dir)).toEqual({ sha: head(dir), dirty: false });
  });

  it("reports a modified tracked file, a new untracked file and a staged change as dirty", async () => {
    const dir = repoWith({ "a.ts": "x" });
    write(dir, "a.ts", "changed");
    expect((await workingTreeState(dir))?.dirty).toBe(true);
    git(dir, "checkout", "--", "a.ts");
    expect((await workingTreeState(dir))?.dirty).toBe(false);
    write(dir, "new.ts", "untracked");
    expect((await workingTreeState(dir))?.dirty).toBe(true);
    git(dir, "add", "new.ts");
    expect((await workingTreeState(dir))?.dirty).toBe(true);
  });

  it("ignores files covered by .gitignore", async () => {
    const dir = repoWith({ "a.ts": "x", ".gitignore": "ignored/\n*.log\n" });
    write(dir, "ignored/big.js", "x");
    write(dir, "debug.log", "x");
    expect((await workingTreeState(dir))?.dirty).toBe(false);
  });
});

describe("diffFiles", () => {
  it("reports added, modified, deleted and renamed files", async () => {
    const dir = repoWith({
      "keep.ts": "1\n2\n3\n4\n5\n6\n7\n8\n",
      "change.ts": "old",
      "remove.ts": "gone",
      "old-name.ts": "same content here\nmore lines\neven more\nand more\n",
    });
    const before = head(dir);
    write(dir, "change.ts", "new");
    fs.rmSync(path.join(dir, "remove.ts"));
    write(dir, "added.ts", "fresh");
    git(dir, "mv", "old-name.ts", "new-name.ts");
    const after = commitAll(dir, "edit");

    const entries = await diffFiles(dir, before, after);
    expect(entries).not.toBeNull();
    expect(entries!.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { status: "A", path: "added.ts" },
      { status: "M", path: "change.ts" },
      { status: "R", path: "new-name.ts", oldPath: "old-name.ts" },
      { status: "D", path: "remove.ts" },
    ]);
  });

  it("is empty when nothing changed and handles paths with spaces and unicode", async () => {
    const dir = repoWith({ "a.ts": "x" });
    const before = head(dir);
    expect(await diffFiles(dir, before, before)).toEqual([]);
    write(dir, "dir with space/файл.ts", "x");
    const after = commitAll(dir, "odd names");
    expect(await diffFiles(dir, before, after)).toEqual([{ status: "A", path: "dir with space/файл.ts" }]);
  });

  it("treats a copy as an added file", async () => {
    const dir = repoWith({ "orig.ts": "a long enough file\nwith several lines\nso that git sees a copy\nline four\nline five\n" });
    const before = head(dir);
    write(dir, "copy.ts", "a long enough file\nwith several lines\nso that git sees a copy\nline four\nline five\n");
    const after = commitAll(dir, "copy");
    const entries = await diffFiles(dir, before, after);
    expect(entries?.map((e) => e.path)).toEqual(["copy.ts"]);
    expect(entries?.[0].status).toBe("A");
  });

  it("returns null when the old commit is not in the repository", async () => {
    const dir = repoWith({ "a.ts": "x" });
    expect(await diffFiles(dir, "0123456789abcdef0123456789abcdef01234567", head(dir))).toBeNull();
    expect(await diffFiles(dir, "not-a-sha", head(dir))).toBeNull();
  });
});
