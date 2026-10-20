import { NextResponse } from "next/server";
import { queryContext } from "../../../lib/context-agent/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { featureDescription?: string; topK?: number };
  if (!body.featureDescription?.trim()) {
    return NextResponse.json({ error: "featureDescription is required" }, { status: 400 });
  }
  const topK = Math.min(Math.max(Number(body.topK) || 15, 1), 50);
  try {
    return NextResponse.json(await queryContext(body.featureDescription, topK));
  } catch (err) {
    console.error("[query] failed:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
