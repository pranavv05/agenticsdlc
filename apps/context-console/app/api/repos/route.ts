import { RegisterRepoRequestSchema } from "@sdd/contracts";
import { NextResponse } from "next/server";
import { getRegistry, readJson, toErrorResponse } from "../../../lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/repos (docs/API.md): the registered repos, newest first. */
export async function GET() {
  try {
    return NextResponse.json({ items: await getRegistry().list() });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** POST /api/repos: register a repo and start profiling it in the background. */
export async function POST(req: Request) {
  try {
    const body = RegisterRepoRequestSchema.parse(await readJson(req));
    const { repo } = await getRegistry().register(body);
    return NextResponse.json(repo, { status: 202 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
