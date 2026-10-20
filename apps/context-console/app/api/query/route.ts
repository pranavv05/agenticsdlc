import { RETRIEVAL_MODES, type RetrievalMode } from "@sdd/contracts";
import { NextResponse } from "next/server";
import { ContextError, RepoContextProvider, getContextStore } from "@sdd/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const g = globalThis as unknown as { __contextProvider?: RepoContextProvider };

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { repoId?: string; task?: string; mode?: string; budgetTokens?: number };
  if (!body.repoId) return NextResponse.json({ error: "repoId is required" }, { status: 400 });
  if (!body.task?.trim()) return NextResponse.json({ error: "task is required" }, { status: 400 });
  if (body.mode && !RETRIEVAL_MODES.includes(body.mode as RetrievalMode)) {
    return NextResponse.json({ error: `mode must be one of ${RETRIEVAL_MODES.join(", ")}` }, { status: 400 });
  }
  try {
    g.__contextProvider ??= new RepoContextProvider({ store: getContextStore() });
    return NextResponse.json(
      await g.__contextProvider.getContext({
        repoId: body.repoId,
        task: body.task,
        mode: body.mode as RetrievalMode | undefined,
        budgetTokens: body.budgetTokens ? Number(body.budgetTokens) : undefined,
      }),
    );
  } catch (err) {
    if (err instanceof ContextError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.code === "repo_not_found" ? 404 : 400 });
    }
    console.error("[query] failed:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
