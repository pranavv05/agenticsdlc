import type { IndexStrategy } from "@sdd/contracts";
import type { DiffEntry } from "./git";
import { isSourceFile } from "./parse";

/** If more than this share of source files changed, a full rebuild is simpler and not much dearer than patching. */
export const INCREMENTAL_MAX_CHANGED_SHARE = 0.3;

export interface PlanInput {
  /** "full" forces a rebuild; "auto" patches the index when it safely can. */
  mode: "auto" | "full";
  strategy: IndexStrategy;
  /** What the last successful run recorded. `sha` is null if the repo has never been indexed. */
  last: { sha: string | null; strategy: IndexStrategy | null };
  /** HEAD and cleanliness now; null for a directory that is not a git repo. */
  current: { sha: string; dirty: boolean } | null;
  /** Result of `git diff last..current`; null when it could not be computed (last commit unknown). */
  diff: DiffEntry[] | null;
  /** Source files in the working tree now (the denominator for the changed share). */
  totalSourceFiles: number;
  /** Are the generated docs for this repo present in the output root? */
  docsExist: boolean;
}

export type Plan =
  | { kind: "skip"; reason: string }
  | { kind: "full"; reason: string }
  | {
      kind: "incremental";
      reason: string;
      /** Source files to re-chunk and re-embed (added, modified, renamed to). */
      changed: string[];
      /** Files whose old chunks must go: modified, deleted and the old side of a rename. */
      removed: string[];
      /** Every changed path, source or not, so docs can find the modules that need rewriting. */
      touched: string[];
    };

/** Decides how to bring a repo's index up to date. Pure, so every branch is unit-tested. */
export function planIndex(input: PlanInput): Plan {
  const { mode, strategy, last, current, diff } = input;
  if (mode === "full") return { kind: "full", reason: "full rebuild requested" };
  if (last.sha === null && last.strategy === null) return { kind: "full", reason: "first index" };
  if (last.strategy !== strategy) return { kind: "full", reason: `strategy changed from ${last.strategy} to ${strategy}` };
  if (!current) return { kind: "full", reason: "not a git repository, so changes cannot be diffed" };
  if (current.dirty) return { kind: "full", reason: "working tree has uncommitted changes" };
  if (last.sha === null) return { kind: "full", reason: "previous run did not record a commit" };
  if (last.sha.endsWith("+dirty")) return { kind: "full", reason: "previous run indexed uncommitted changes" };

  if (last.sha === current.sha) {
    return input.docsExist
      ? { kind: "skip", reason: "already indexed at this commit" }
      : { kind: "full", reason: "generated docs are missing" };
  }
  if (!diff) return { kind: "full", reason: "previous commit is not in this repository's history" };

  const changed = new Set<string>();
  const removed = new Set<string>();
  const touched = new Set<string>();
  for (const e of diff) {
    touched.add(e.path);
    if (e.oldPath) touched.add(e.oldPath);
    if (e.status === "D") {
      if (isSourceFile(e.path)) removed.add(e.path);
    } else if (e.status === "R") {
      if (e.oldPath && isSourceFile(e.oldPath)) removed.add(e.oldPath);
      if (isSourceFile(e.path)) changed.add(e.path);
    } else if (isSourceFile(e.path)) {
      changed.add(e.path);
      if (e.status === "M") removed.add(e.path);
    }
  }

  const touchedSource = new Set([...changed, ...removed]).size;
  if (input.totalSourceFiles > 0 && touchedSource / input.totalSourceFiles > INCREMENTAL_MAX_CHANGED_SHARE) {
    return {
      kind: "full",
      reason: `${touchedSource} of ${input.totalSourceFiles} source files changed, over ${INCREMENTAL_MAX_CHANGED_SHARE * 100}%`,
    };
  }
  return {
    kind: "incremental",
    reason: `${changed.size} source file(s) to re-embed, ${removed.size} to drop since ${last.sha.slice(0, 7)}`,
    changed: [...changed].sort(),
    removed: [...removed].sort(),
    touched: [...touched].sort(),
  };
}
