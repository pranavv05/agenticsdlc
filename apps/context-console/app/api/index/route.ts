import { NextResponse } from "next/server";
import { getContextStore, indexRepos, loadRepoConfig, repoConfigToTarget } from "@sdd/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const g = globalThis as unknown as { __indexing?: boolean };

/** Starts indexing every repo in repos.config.json in the background and returns at once; poll /api/index/status. */
export async function POST() {
  if (g.__indexing) return NextResponse.json({ alreadyRunning: true }, { status: 202 });

  let targets;
  try {
    targets = loadRepoConfig().map(repoConfigToTarget);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }

  g.__indexing = true;
  void indexRepos(targets, { store: getContextStore() })
    .catch((err) => console.error("[index] run failed:", err))
    .finally(() => {
      g.__indexing = false;
    });
  return NextResponse.json({ started: true, repos: targets.map((t) => t.id) }, { status: 202 });
}
