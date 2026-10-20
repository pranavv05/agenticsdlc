import { IndexRepoRequestSchema, RepoIdParamsSchema } from "@sdd/contracts";
import { NextResponse } from "next/server";
import { getRegistry, readJson, toErrorResponse } from "../../../../../lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/repos/:id/index (docs/API.md): start indexing in the background; poll GET /api/repos/:id. */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = RepoIdParamsSchema.parse(params);
    const body = IndexRepoRequestSchema.parse(await readJson(req));
    const { repo } = await getRegistry().startIndexing(id, body);
    return NextResponse.json(repo, { status: 202 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
