import { describe, expect, it } from "vitest";
import { INCREMENTAL_MAX_CHANGED_SHARE, planIndex, type PlanInput } from "../src/plan";

const clean = { sha: "bbb222", dirty: false };
const base: PlanInput = {
  mode: "auto",
  strategy: "full",
  last: { sha: "aaa111", strategy: "full" },
  current: clean,
  diff: [{ status: "M", path: "src/a.ts" }],
  totalSourceFiles: 100,
  docsExist: true,
};
const plan = (patch: Partial<PlanInput>) => planIndex({ ...base, ...patch });

describe("planIndex: when a full rebuild is needed", () => {
  it.each([
    ["it is forced", { mode: "full" as const }, /requested/],
    ["the repo was never indexed", { last: { sha: null, strategy: null } }, /first index/],
    [
      "the strategy changed",
      { last: { sha: "aaa111", strategy: "claude-md-only" as const } },
      /strategy changed from claude-md-only to full/,
    ],
    ["the repo is not a git checkout", { current: null }, /not a git repository/],
    ["the working tree has uncommitted changes", { current: { sha: "bbb222", dirty: true } }, /uncommitted/],
    [
      "the previous run indexed uncommitted changes",
      { last: { sha: "aaa111+dirty", strategy: "full" as const } },
      /previous run indexed uncommitted/,
    ],
    ["the previous run recorded no commit", { last: { sha: null, strategy: "full" as const } }, /did not record a commit/],
    ["the old commit cannot be diffed", { diff: null }, /not in this repository/],
  ])("%s", (_label, patch, reason) => {
    const result = plan(patch);
    expect(result.kind).toBe("full");
    expect(result.reason).toMatch(reason);
  });

  it("prefers forcing over every other signal, even when everything is up to date", () => {
    expect(plan({ mode: "full", last: { sha: "bbb222", strategy: "full" } }).kind).toBe("full");
  });
});

describe("planIndex: skip", () => {
  it("skips when the commit is unchanged and the docs exist", () => {
    expect(plan({ last: { sha: "bbb222", strategy: "full" }, diff: [] })).toEqual({
      kind: "skip",
      reason: "already indexed at this commit",
    });
  });

  it("rebuilds instead when the generated docs are missing", () => {
    const result = plan({ last: { sha: "bbb222", strategy: "full" }, docsExist: false });
    expect(result.kind).toBe("full");
    expect(result.reason).toMatch(/docs are missing/);
  });
});

describe("planIndex: incremental", () => {
  it("re-embeds added and modified source files and drops modified ones first", () => {
    const result = plan({
      diff: [
        { status: "A", path: "src/new.ts" },
        { status: "M", path: "src/changed.py" },
      ],
    });
    expect(result).toMatchObject({ kind: "incremental", changed: ["src/changed.py", "src/new.ts"], removed: ["src/changed.py"] });
  });

  it("drops deleted source files without re-embedding them", () => {
    const result = plan({ diff: [{ status: "D", path: "src/gone.ts" }] });
    expect(result).toMatchObject({ kind: "incremental", changed: [], removed: ["src/gone.ts"] });
  });

  it("handles a rename as drop old + embed new", () => {
    const result = plan({ diff: [{ status: "R", path: "src/new-name.ts", oldPath: "src/old-name.ts" }] });
    expect(result).toMatchObject({ kind: "incremental", changed: ["src/new-name.ts"], removed: ["src/old-name.ts"] });
  });

  it("ignores files that are not source code for the index, but reports them as touched", () => {
    const result = plan({
      diff: [
        { status: "M", path: "README.md" },
        { status: "M", path: "package.json" },
        { status: "A", path: "logo.png" },
      ],
    });
    expect(result).toMatchObject({ kind: "incremental", changed: [], removed: [], touched: ["README.md", "logo.png", "package.json"] });
  });

  it("an empty diff between two commits is an (empty) incremental update, not a rebuild", () => {
    expect(plan({ diff: [] })).toMatchObject({ kind: "incremental", changed: [], removed: [] });
  });

  it("records old and new paths of a rename as touched", () => {
    const result = plan({ diff: [{ status: "R", path: "b/new.ts", oldPath: "a/old.ts" }] });
    expect(result.kind === "incremental" && result.touched).toEqual(["a/old.ts", "b/new.ts"]);
  });

  it("falls back to a full rebuild when too large a share of the source files changed", () => {
    const share = INCREMENTAL_MAX_CHANGED_SHARE;
    const filesChanged = (n: number) => Array.from({ length: n }, (_, i) => ({ status: "M" as const, path: `src/f${i}.ts` }));
    expect(plan({ diff: filesChanged(share * 100) }).kind).toBe("incremental"); // exactly at the limit is fine
    const over = plan({ diff: filesChanged(share * 100 + 1) });
    expect(over.kind).toBe("full");
    expect(over.reason).toMatch(/over 30%/);
  });

  it("counts a modified file once, not as both changed and removed", () => {
    const diff = Array.from({ length: 20 }, (_, i) => ({ status: "M" as const, path: `src/f${i}.ts` }));
    expect(plan({ diff, totalSourceFiles: 100 }).kind).toBe("incremental"); // 20 files, not 40
  });

  it("does not divide by zero for an empty repo", () => {
    expect(plan({ totalSourceFiles: 0, diff: [{ status: "A", path: "src/a.ts" }] }).kind).toBe("incremental");
  });
});
