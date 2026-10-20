import { z } from "zod";
import { TimestampSchema } from "./common";

/** Scope section 6.1: the full pipeline, or module docs and a mind map only. */
export const INDEX_STRATEGIES = ["full", "claude-md-only"] as const;
export const IndexStrategySchema = z.enum(INDEX_STRATEGIES);
export type IndexStrategy = z.infer<typeof IndexStrategySchema>;

export const RepoSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("path"),
    value: z.string().min(1).describe("Absolute path to a local checkout. For local development only."),
  }),
  z.object({
    type: z.literal("url"),
    value: z.url().describe("Git clone URL. The repo is cloned into the server's cache directory."),
  }),
]);
export type RepoSource = z.infer<typeof RepoSourceSchema>;

export const RepoLanguageStatsSchema = z.object({
  language: z.string().min(1),
  files: z.number().int().min(0),
  loc: z.number().int().min(0).describe("Non-empty lines of code."),
});
export type RepoLanguageStats = z.infer<typeof RepoLanguageStatsSchema>;

/** Output of the repo profiler. */
export const RepoProfileSchema = z.object({
  totalFiles: z.number().int().min(0),
  totalLoc: z.number().int().min(0),
  languages: z.array(RepoLanguageStatsSchema),
  recommendation: IndexStrategySchema,
  reason: z.string().describe("Why this strategy was recommended, quoting the thresholds that applied."),
});
export type RepoProfile = z.infer<typeof RepoProfileSchema>;

export const REPO_STATUSES = ["profiling", "profiled", "indexing", "indexed", "failed"] as const;
export const RepoStatusSchema = z.enum(REPO_STATUSES);
export type RepoStatus = z.infer<typeof RepoStatusSchema>;

export const RepoIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,62}$/, "lowercase letters, digits, dot, dash and underscore; at most 63 characters");

export const RepoSchema = z.object({
  id: RepoIdSchema.describe("Slug derived from the name. This is the value initiatives use as `repoId`."),
  name: z.string().min(1).max(200),
  source: RepoSourceSchema,
  status: RepoStatusSchema.describe(
    "profiling: being analysed. profiled: ready to index. indexing: index running. indexed: ready for Case B. failed: see `error`.",
  ),
  profile: RepoProfileSchema.nullable().describe("Null until profiling finishes."),
  indexStrategy: IndexStrategySchema.nullable().describe("The strategy the last index run used. Null before the first run."),
  indexedCommitSha: z.string().nullable().describe("Commit the current index was built from. Null before the first successful run."),
  indexedAt: TimestampSchema.nullable(),
  error: z.string().optional().describe("Present when status is failed."),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Repo = z.infer<typeof RepoSchema>;
