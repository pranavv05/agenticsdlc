import type { IndexStrategy, RepoProfile } from "@sdd/contracts";
import fs from "node:fs/promises";
import { CHUNKABLE_LANGUAGES, isChunkable, languageOfFile } from "./languages";
import { walkRepo } from "./walk";

/**
 * Scope section 6.1 gives the full pipeline to monorepo-scale repos (1000+ files) and CLAUDE.md-only to small utility repos
 * (under 200 files), and says nothing about 200 to 999. It also says most of this platform's repos need the full pipeline, so
 * the full pipeline is the default: it is used from 200 source files up.
 */
export const FULL_PIPELINE_MIN_SOURCE_FILES = 200;
/** Files larger than this (bundles, generated code) are counted as files but their lines are not read. */
export const MAX_COUNTED_FILE_BYTES = 2_000_000;

export interface Recommendation {
  recommendation: IndexStrategy;
  reason: string;
}

/** The decision of scope 6.1 as a pure function of the counts. `sourceFiles` are files in a programming language; `chunkableFiles` are the ones the chunker can parse. */
export function recommendStrategy(counts: { sourceFiles: number; chunkableFiles: number }): Recommendation {
  const { sourceFiles, chunkableFiles } = counts;
  const languages = CHUNKABLE_LANGUAGES.join(", ");
  if (sourceFiles === 0)
    return { recommendation: "claude-md-only", reason: "No source files found, so there is nothing to chunk or embed." };
  if (chunkableFiles === 0) {
    return {
      recommendation: "claude-md-only",
      reason: `None of its ${sourceFiles} source files is in a language the chunker supports (${languages}), so only module docs and a mind map are useful.`,
    };
  }
  if (sourceFiles < FULL_PIPELINE_MIN_SOURCE_FILES) {
    return {
      recommendation: "claude-md-only",
      reason: `${sourceFiles} source files is under ${FULL_PIPELINE_MIN_SOURCE_FILES}: a small repo, where CLAUDE.md files and native search are enough (scope 6.1).`,
    };
  }
  return {
    recommendation: "full",
    reason: `${sourceFiles} source files is at least ${FULL_PIPELINE_MIN_SOURCE_FILES}: the full pipeline (chunks, embeddings, dependencies, CLAUDE.md, mind map) pays off (scope 6.1${sourceFiles >= 1000 ? ", monorepo scale" : ""}).`,
  };
}

const countNonEmptyLines = (text: string): number => {
  let n = 0;
  for (const line of text.split("\n")) if (line.trim() !== "") n++;
  return n;
};

/**
 * Profiles a checked-out repo: how many files, how many lines of code in each programming language, and whether the full
 * indexing pipeline is worth running. `.gitignore` files (root and nested) and the usual build and dependency folders are
 * respected, so `node_modules`, build output and the like are not counted.
 */
export async function profileRepo(repoPath: string): Promise<RepoProfile> {
  const files = await walkRepo(repoPath);
  const perLanguage = new Map<string, { files: number; loc: number }>();
  let chunkableFiles = 0;

  for (const f of files) {
    const language = languageOfFile(f.rel);
    if (!language) continue;
    const entry = perLanguage.get(language) ?? { files: 0, loc: 0 };
    entry.files++;
    if (f.size <= MAX_COUNTED_FILE_BYTES) {
      try {
        entry.loc += countNonEmptyLines(await fs.readFile(f.abs, "utf8"));
      } catch {
        /* unreadable file: counted, but its lines are not */
      }
    }
    perLanguage.set(language, entry);
    if (isChunkable(f.rel)) chunkableFiles++;
  }

  const languages = [...perLanguage]
    .map(([language, v]) => ({ language, files: v.files, loc: v.loc }))
    .sort((a, b) => b.loc - a.loc || b.files - a.files || a.language.localeCompare(b.language));
  const sourceFiles = languages.reduce((n, l) => n + l.files, 0);

  return {
    totalFiles: files.length,
    totalLoc: languages.reduce((n, l) => n + l.loc, 0),
    languages,
    ...recommendStrategy({ sourceFiles, chunkableFiles }),
  };
}
