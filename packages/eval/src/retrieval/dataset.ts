import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export const RetrievalCaseSchema = z.object({
  task: z.string().min(10).describe("A feature request in the words a product owner would use."),
  expectedFiles: z
    .array(z.string().min(1))
    .min(1)
    .describe("Repo-relative files a developer would need to touch or read to build it, with forward slashes."),
});
export type RetrievalCase = z.infer<typeof RetrievalCaseSchema>;

export const RetrievalDatasetSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().min(1),
  /** Folder of the repo to index, relative to this JSON file. */
  repo: z.string().min(1),
  cases: z.array(RetrievalCaseSchema).min(1),
});
export type RetrievalDataset = z.infer<typeof RetrievalDatasetSchema>;

export interface LoadedDataset extends RetrievalDataset {
  /** Absolute path of the repo folder. */
  repoPath: string;
  /** Absolute path of the JSON file. */
  file: string;
}

/** Loads and validates one dataset file. Throws with the file name if it is malformed or points at a missing repo. */
export function loadDataset(file: string): LoadedDataset {
  const absolute = path.resolve(file);
  let parsed: RetrievalDataset;
  try {
    parsed = RetrievalDatasetSchema.parse(JSON.parse(fs.readFileSync(absolute, "utf8")));
  } catch (error) {
    throw new Error(`Invalid retrieval dataset ${absolute}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const repoPath = path.resolve(path.dirname(absolute), parsed.repo);
  if (!fs.statSync(repoPath, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`Dataset ${absolute}: repo folder ${parsed.repo} does not exist`);
  return { ...parsed, repoPath, file: absolute };
}

/** Every `*.json` dataset in a folder, sorted by name. */
export function loadDatasets(dir: string): LoadedDataset[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => loadDataset(path.join(dir, f)));
}

/** Problems that would make a dataset score wrongly: expected files that do not exist in the repo, and repeated files in one case. */
export function checkDataset(dataset: LoadedDataset): string[] {
  const problems: string[] = [];
  dataset.cases.forEach((c, i) => {
    if (new Set(c.expectedFiles).size !== c.expectedFiles.length) problems.push(`case ${i + 1}: expectedFiles has duplicates`);
    for (const file of c.expectedFiles) {
      if (!fs.statSync(path.join(dataset.repoPath, ...file.split("/")), { throwIfNoEntry: false })?.isFile()) {
        problems.push(`case ${i + 1}: expected file "${file}" does not exist in ${dataset.repo}`);
      }
    }
  });
  return problems;
}
