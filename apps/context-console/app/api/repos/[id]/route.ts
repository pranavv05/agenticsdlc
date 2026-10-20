import { RepoIdParamsSchema } from "@sdd/contracts";
import { NextResponse } from "next/server";
import { getRegistry, toErrorResponse } from "../../../../lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/repos/:id (docs/API.md): one repo, with its profile and index state. */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = RepoIdParamsSchema.parse(params);
    return NextResponse.json(await getRegistry().get(id));
  } catch (err) {
    return toErrorResponse(err);
  }
}
