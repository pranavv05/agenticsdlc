import { RETRIEVAL_MODES, RepoIdSchema } from "@sdd/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";
import { RepoContextProvider, getContextStore } from "@sdd/context";
import { readJson, toErrorResponse } from "../../../lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const g = globalThis as unknown as { __contextProvider?: RepoContextProvider };

/** Console only (not part of docs/API.md): what context would the agents get for this task? */
const QuerySchema = z.object({
  repoId: RepoIdSchema,
  task: z.string().trim().min(1).max(20_000),
  mode: z.enum(RETRIEVAL_MODES).optional(),
  budgetTokens: z.number().int().min(1).max(200_000).optional(),
});

export async function POST(req: Request) {
  try {
    const query = QuerySchema.parse(await readJson(req));
    g.__contextProvider ??= new RepoContextProvider({ store: getContextStore() });
    return NextResponse.json(await g.__contextProvider.getContext(query));
  } catch (err) {
    return toErrorResponse(err);
  }
}
