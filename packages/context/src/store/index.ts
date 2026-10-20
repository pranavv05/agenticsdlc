import { getPool } from "../db";
import { PgContextStore } from "./pg";
import type { ContextStore } from "./types";

export { MemoryContextStore, EMBEDDING_DIMENSIONS } from "./memory";
export { PgContextStore } from "./pg";
export type * from "./types";

let current: ContextStore | undefined;

/** The Postgres-backed store for the process, created on first use from DATABASE_URL. */
export function getContextStore(): ContextStore {
  return (current ??= new PgContextStore(getPool()));
}

/** Replace the process-wide store (tests, or an app that wants the in-memory one). Pass undefined to reset. */
export function setContextStore(store: ContextStore | undefined): void {
  current = store;
}
