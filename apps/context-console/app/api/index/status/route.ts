import { NextResponse } from "next/server";
import { getContextStore } from "@sdd/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The latest indexing run of each repo, folded into one overall run for the page. */
export async function GET() {
  const runs = await getContextStore().listLatestRuns();
  if (!runs.length) return NextResponse.json({ run: null });

  const status = runs.some((r) => r.status === "running") ? "running" : runs.some((r) => r.status === "error") ? "error" : "done";
  const finished = runs.map((r) => r.finishedAt).filter((t): t is string => !!t);
  return NextResponse.json({
    run: {
      id: Math.max(...runs.map((r) => r.id)),
      status,
      startedAt: runs.map((r) => r.startedAt).sort()[0],
      finishedAt: status === "running" || finished.length < runs.length ? null : finished.sort().at(-1),
      perRepoProgress: Object.fromEntries(
        runs.map((r) => [r.repoId, { stage: r.status === "error" ? "error" : "running", stages: r.progress, error: r.error ?? undefined }]),
      ),
    },
  });
}
