import { Pool } from "pg";

const g = globalThis as unknown as { __pgPool?: Pool };

export function getPool(): Pool {
  if (!g.__pgPool) {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
    g.__pgPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  }
  return g.__pgPool;
}

export async function closePool(): Promise<void> {
  await g.__pgPool?.end();
  g.__pgPool = undefined;
}
