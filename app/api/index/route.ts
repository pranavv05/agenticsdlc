import { NextResponse } from "next/server";
import { getPool } from "../../../lib/db";
import { indexAllRepos } from "../../../lib/context-agent/pipeline";
import type { ProgressCounts, ProgressStage } from "../../../lib/context-agent/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const g = globalThis as unknown as { __indexRunId?: number | null };

type RepoProgress = { stage: ProgressStage; stages: Partial<Record<ProgressStage, ProgressCounts>>; error?: string };

export async function POST() {
  if (g.__indexRunId) {
    return NextResponse.json({ runId: g.__indexRunId, alreadyRunning: true }, { status: 202 });
  }

  const pool = getPool();
  const { rows } = await pool.query("INSERT INTO indexing_runs (status, per_repo_progress) VALUES ('running', '{}') RETURNING id");
  const runId = Number(rows[0].id);
  g.__indexRunId = runId;

  const progress: Record<string, RepoProgress> = {};
  let chain: Promise<void> = Promise.resolve();
  const persist = () => {
    const snapshot = JSON.stringify(progress);
    chain = chain
      .then(async () => {
        await pool.query("UPDATE indexing_runs SET per_repo_progress = $2::jsonb WHERE id = $1", [runId, snapshot]);
      })
      .catch((e) => console.error("[index] failed to persist progress:", e));
    return chain;
  };

  // Fire and forget: the HTTP response returns immediately with the run id.
  void (async () => {
    let status: "done" | "error" = "done";
    try {
      const result = await indexAllRepos((repo, stage, counts) => {
        const p = (progress[repo] ??= { stage, stages: {} });
        p.stage = stage;
        p.stages[stage] = counts;
        if (stage === "error") p.error = String(counts.message ?? "unknown error");
        return persist();
      });
      if (result.failedRepos.length) status = "error";
    } catch (err) {
      status = "error";
      console.error("[index] run failed:", err);
      progress["(run)"] = { stage: "error", stages: {}, error: (err as Error).message };
      await persist();
    } finally {
      await chain;
      await pool.query("UPDATE indexing_runs SET status = $2, finished_at = now() WHERE id = $1", [runId, status]);
      g.__indexRunId = null;
    }
  })();

  return NextResponse.json({ runId }, { status: 202 });
}
