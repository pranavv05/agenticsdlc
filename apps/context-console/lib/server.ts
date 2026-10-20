import { ERROR_HTTP_STATUS, type ErrorCode, type ErrorResponse } from "@sdd/contracts";
import { RepoRegistry, getContextStore, isContextError, isRegistryError } from "@sdd/context";
import { NextResponse } from "next/server";

const g = globalThis as unknown as { __repoRegistry?: RepoRegistry };

/** By shape, not `instanceof`: Next.js can load a package once per route bundle, so a class from another copy would not match. */
const isZodError = (err: unknown): err is { issues: { code: string; path: PropertyKey[]; message: string }[] } =>
  typeof err === "object" &&
  err !== null &&
  (err as { name?: unknown }).name === "ZodError" &&
  Array.isArray((err as { issues?: unknown }).issues);

/** One registry per server process. Work interrupted by an earlier restart is marked failed the first time it is created. */
export function getRegistry(): RepoRegistry {
  if (!g.__repoRegistry) {
    g.__repoRegistry = new RepoRegistry({ store: getContextStore() });
    void g.__repoRegistry.recoverInterrupted().catch((err) => console.error("[registry] recovery failed:", err));
  }
  return g.__repoRegistry;
}

export function errorResponse(code: ErrorCode, message: string, details?: ErrorResponse["error"]["details"]): NextResponse {
  const body: ErrorResponse = { error: { code, message, ...(details ? { details } : {}) } };
  return NextResponse.json(body, { status: ERROR_HTTP_STATUS[code] });
}

/** Turns anything a handler can throw into the API's error envelope (docs/API.md, "Errors"). */
export function toErrorResponse(err: unknown): NextResponse {
  if (isZodError(err)) {
    return errorResponse(
      "validation_error",
      "Request is invalid",
      err.issues.map((i) => ({ code: i.code, path: i.path.map((p) => (typeof p === "symbol" ? String(p) : p)), message: i.message })),
    );
  }
  if (isRegistryError(err)) {
    if (err.code === "not_found") return errorResponse("not_found", err.message);
    if (err.code === "conflict") return errorResponse("conflict", err.message);
    return errorResponse("validation_error", err.message, [{ code: "custom", path: err.path ?? [], message: err.message }]);
  }
  if (isContextError(err)) {
    return err.code === "repo_not_found"
      ? errorResponse("not_found", err.message)
      : errorResponse(err.code === "repo_not_indexed" ? "conflict" : "validation_error", err.message);
  }
  console.error("[api] unexpected error:", err);
  return errorResponse("internal_error", err instanceof Error ? err.message : "Unexpected error");
}

/** Reads a JSON body; an empty or malformed body is treated as `{}` so schema validation reports what is missing. */
export async function readJson(req: Request): Promise<unknown> {
  return req.json().catch(() => ({}));
}
