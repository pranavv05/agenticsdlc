import { NextResponse } from "next/server";
import { getContextStore } from "@sdd/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const repos = await getContextStore().listRepos();
  return NextResponse.json({
    items: repos.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      indexStrategy: r.indexStrategy,
      indexedCommitSha: r.indexedCommitSha,
      indexedAt: r.indexedAt,
    })),
  });
}
