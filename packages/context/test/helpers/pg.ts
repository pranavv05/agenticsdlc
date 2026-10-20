import { Pool } from "pg";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PgContextStore } from "../../src/store/pg";

export const hasDatabase = !!process.env.DATABASE_URL;

const SCHEMA_SQL = fs.readFileSync(path.resolve(import.meta.dirname, "../../schema.sql"), "utf8");

export interface IsolatedPg {
  pool: Pool;
  store: PgContextStore;
  cleanup(): Promise<void>;
}

/** A private Postgres schema with the real tables, so tests never touch the data of the dev database. */
export async function createIsolatedPg(): Promise<IsolatedPg> {
  const url = process.env.DATABASE_URL!;
  const schema = `t_${crypto.randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: url, max: 4, options: `-c search_path=${schema},public` });
  await pool.query(SCHEMA_SQL);
  return {
    pool,
    store: new PgContextStore(pool),
    async cleanup() {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}
