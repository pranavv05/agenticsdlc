import { z } from "zod";

export const RETRIEVAL_MODES = ["claude-md", "embeddings", "hybrid"] as const;
export const RetrievalModeSchema = z.enum(RETRIEVAL_MODES);
export type RetrievalMode = z.infer<typeof RetrievalModeSchema>;

export const ContextChunkSchema = z.object({
  repoId: z.string().min(1),
  /** Repo-relative path with forward slashes. */
  filePath: z.string().min(1),
  symbolName: z.string().nullable(),
  chunkType: z.enum(["function", "class", "route", "other"]),
  code: z.string(),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  /** Cosine similarity for embedding hits; null for chunks found by other means. */
  score: z.number().nullable(),
  via: z.enum(["similarity", "dependency", "lexical"]),
});
export type ContextChunk = z.infer<typeof ContextChunkSchema>;

export const ClaudeMdSectionSchema = z.object({
  repoId: z.string().min(1),
  path: z.string().min(1),
  content: z.string(),
});
export type ClaudeMdSection = z.infer<typeof ClaudeMdSectionSchema>;

/** What a ContextProvider returns. The same shape for every retrieval mode; Case A gets an empty bundle. */
export const ContextBundleSchema = z.object({
  /** Null when no retrieval happened (Case A). */
  mode: RetrievalModeSchema.nullable(),
  chunks: z.array(ContextChunkSchema),
  relevantClaudeMdSections: z.array(ClaudeMdSectionSchema),
  relevantMindmapExcerpt: z.string(),
  /** Rough size of the bundle, used to enforce budgetTokens. */
  tokenEstimate: z.number().int().min(0),
  /** True when content was cut to fit the budget. */
  truncated: z.boolean(),
});
export type ContextBundle = z.infer<typeof ContextBundleSchema>;

export const EMPTY_CONTEXT_BUNDLE: ContextBundle = Object.freeze({
  mode: null,
  chunks: [],
  relevantClaudeMdSections: [],
  relevantMindmapExcerpt: "",
  tokenEstimate: 0,
  truncated: false,
});
