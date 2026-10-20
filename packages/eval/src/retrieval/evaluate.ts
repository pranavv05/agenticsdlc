import { RETRIEVAL_MODES, type IndexStrategy, type RetrievalMode } from "@sdd/contracts";
import { MemoryContextStore, RepoContextProvider, indexRepo } from "@sdd/context";
import {
  createEmbedder,
  createGateway,
  setEmbedder,
  setGateway,
  type Embedder,
  type Gateway,
  type LlmMode,
  type UsageRecord,
} from "@sdd/llm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LoadedDataset } from "./dataset";
import { hitAtK, mean, precisionAtK, rankedFiles, recallAtK, reciprocalRank } from "./metrics";

export const DEFAULT_KS = [1, 3, 5, 10] as const;

export interface CaseResult {
  task: string;
  expectedFiles: string[];
  /** Files of the bundle in reading order (see `rankedFiles`). */
  ranked: string[];
  recall: Record<number, number>;
  precision: Record<number, number>;
  hit: Record<number, number>;
  reciprocalRank: number;
  tokens: number;
  chunks: number;
  truncated: boolean;
}

export interface ModeSummary {
  mode: RetrievalMode;
  cases: number;
  recall: Record<number, number>;
  precision: Record<number, number>;
  hit: Record<number, number>;
  mrr: number;
  meanTokens: number;
  meanChunks: number;
  meanFiles: number;
  truncatedShare: number;
}

export interface DatasetReport {
  dataset: string;
  description: string;
  repo: string;
  modes: { mode: RetrievalMode; summary: ModeSummary; cases: CaseResult[] }[];
}

export interface UsageTotals {
  calls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** True when answers came from fixtures and offline vectors instead of the real APIs. */
  mocked: boolean;
}

export interface RetrievalReport {
  generatedAt: string;
  llmMode: "mock" | "live" | "record";
  budgetTokens: number;
  topK: number;
  ks: number[];
  datasets: DatasetReport[];
  /** Mean over every case of every dataset, per mode. */
  overall: ModeSummary[];
  /** What building the indexes (embeddings, CLAUDE.md files, mind maps) and answering the queries cost. */
  usage: UsageTotals;
}

export interface EvaluateOptions {
  datasets: LoadedDataset[];
  modes?: readonly RetrievalMode[];
  ks?: readonly number[];
  /** Token budget given to every bundle. Default 12,000. */
  budgetTokens?: number;
  /** Primary chunk hits gathered per query before the budget applies. Default 15. */
  topK?: number;
  /** How the repos are indexed. Default "full", which the comparison needs: without embeddings the modes cannot be told apart. */
  strategy?: IndexStrategy;
  /** Where the generated docs go. Default: a temporary folder that is removed afterwards. */
  outputRoot?: string;
  /** "mock" runs offline, "live" calls Voyage and Claude. Default: LLM_MODE from the environment, else "mock". */
  llmMode?: LlmMode;
  /** Replace the gateway and embedder (tests). */
  gateway?: Gateway;
  embedder?: Embedder;
  onProgress?: (message: string) => void;
}

function summarise(mode: RetrievalMode, cases: CaseResult[], ks: readonly number[]): ModeSummary {
  const byK = (pick: (c: CaseResult) => Record<number, number>) =>
    Object.fromEntries(ks.map((k) => [k, mean(cases.map((c) => pick(c)[k]))]));
  return {
    mode,
    cases: cases.length,
    recall: byK((c) => c.recall),
    precision: byK((c) => c.precision),
    hit: byK((c) => c.hit),
    mrr: mean(cases.map((c) => c.reciprocalRank)),
    meanTokens: mean(cases.map((c) => c.tokens)),
    meanChunks: mean(cases.map((c) => c.chunks)),
    meanFiles: mean(cases.map((c) => c.ranked.length)),
    truncatedShare: mean(cases.map((c) => (c.truncated ? 1 : 0))),
  };
}

/**
 * Index each dataset's repo with the full pipeline (embeddings included), then ask every retrieval mode for the context of
 * every task and score the files it returns against the labelled expected files.
 *
 * Offline (LLM_MODE=mock) this checks the harness and gives a rough comparison, but the mock embeddings are hashed words and
 * the generated CLAUDE.md files are placeholders, so the numbers are NOT evidence about the modes. The comparison the
 * project reports must be run live (real Voyage embeddings, real generated docs).
 */
export async function evaluateRetrieval(options: EvaluateOptions): Promise<RetrievalReport> {
  const modes = options.modes ?? RETRIEVAL_MODES;
  const ks = [...(options.ks ?? DEFAULT_KS)];
  const budgetTokens = options.budgetTokens ?? 12_000;
  const topK = options.topK ?? 15;
  const say = options.onProgress ?? (() => {});

  const usageRecords: UsageRecord[] = [];
  const onUsage = (record: UsageRecord) => void usageRecords.push(record);
  // Never spend money by accident: with no explicit mode and no LLM_MODE in the environment, run offline.
  const llmMode = options.llmMode ?? (process.env.LLM_MODE as LlmMode | undefined) ?? "mock";
  const gateway = options.gateway ?? createGateway({ mode: llmMode, onUsage });
  const embedder = options.embedder ?? createEmbedder({ mode: llmMode, onUsage });
  setGateway(gateway);
  setEmbedder(embedder);

  const ownOutput = !options.outputRoot;
  const outputRoot = options.outputRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "sdd-retrieval-eval-"));

  try {
    const datasets: DatasetReport[] = [];
    for (const dataset of options.datasets) {
      say(`indexing ${dataset.name} (${dataset.repoPath})`);
      const store = new MemoryContextStore();
      const result = await indexRepo(
        { id: dataset.name, name: dataset.name, path: dataset.repoPath },
        { store, outputRoot, strategy: options.strategy ?? "full", mode: "full" },
      );
      if (result.failedRepos.length) {
        const run = result.runs[0];
        throw new Error(`Indexing ${dataset.name} failed: ${run?.error ?? "unknown error"}`);
      }
      const provider = new RepoContextProvider({ store, outputRoot, topK, defaultBudgetTokens: budgetTokens });

      const perMode: DatasetReport["modes"] = [];
      for (const mode of modes) {
        const cases: CaseResult[] = [];
        for (const c of dataset.cases) {
          const bundle = await provider.getContext({ repoId: dataset.name, task: c.task, mode, budgetTokens });
          if (bundle.mode !== mode) {
            // e.g. a repo without embeddings answers every mode as claude-md; reporting that as "embeddings" would be a lie
            throw new Error(
              `Asked for mode "${mode}" on ${dataset.name} but the bundle was built as "${bundle.mode}". The comparison would be invalid.`,
            );
          }
          const ranked = rankedFiles(bundle);
          cases.push({
            task: c.task,
            expectedFiles: c.expectedFiles,
            ranked,
            recall: Object.fromEntries(ks.map((k) => [k, recallAtK(ranked, c.expectedFiles, k)])),
            precision: Object.fromEntries(ks.map((k) => [k, precisionAtK(ranked, c.expectedFiles, k)])),
            hit: Object.fromEntries(ks.map((k) => [k, hitAtK(ranked, c.expectedFiles, k)])),
            reciprocalRank: reciprocalRank(ranked, c.expectedFiles),
            tokens: bundle.tokenEstimate,
            chunks: bundle.chunks.length,
            truncated: bundle.truncated,
          });
        }
        say(`  ${mode}: ${cases.length} tasks scored`);
        perMode.push({ mode, summary: summarise(mode, cases, ks), cases });
      }
      datasets.push({ dataset: dataset.name, description: dataset.description, repo: dataset.repo, modes: perMode });
    }

    const overall = modes.map((mode) =>
      summarise(
        mode,
        datasets.flatMap((d) => d.modes.find((m) => m.mode === mode)!.cases),
        ks,
      ),
    );
    return {
      generatedAt: new Date().toISOString(),
      llmMode: gateway.mode,
      budgetTokens,
      topK,
      ks,
      datasets,
      overall,
      usage: {
        calls: usageRecords.length,
        costUsd: Math.round(usageRecords.reduce((n, r) => n + r.costUsd, 0) * 1e6) / 1e6,
        inputTokens: usageRecords.reduce((n, r) => n + r.inputTokens, 0),
        outputTokens: usageRecords.reduce((n, r) => n + r.outputTokens, 0),
        mocked: usageRecords.length > 0 && usageRecords.every((r) => r.mocked),
      },
    };
  } finally {
    setGateway(undefined);
    setEmbedder(undefined);
    if (ownOutput) fs.rmSync(outputRoot, { recursive: true, force: true });
  }
}
