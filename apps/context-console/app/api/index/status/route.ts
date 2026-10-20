import { NextResponse } from "next/server";
import { getContextStore } from "@sdd/context";
import { toErrorResponse } from "../../../../lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Console only (not part of docs/API.md): the latest indexing run of every repo, with per-stage progress. */
export async function GET() {
  try {
    return NextResponse.json({ items: await getContextStore().listLatestRuns() });
  } catch (err) {
    return toErrorResponse(err);
  }
}
