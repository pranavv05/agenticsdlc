import { MemoryContextStore } from "../src/store/memory";
import { createIsolatedPg, hasDatabase } from "./helpers/pg";
import { describeStoreContract } from "./store.contract";

describeStoreContract("memory", async () => ({ store: new MemoryContextStore(), cleanup: async () => {} }));

// Needs the Docker database: `pnpm db:up`. Each run uses a private schema, so the dev data is never touched.
describeStoreContract(
  "postgres",
  async () => {
    const pg = await createIsolatedPg();
    return { store: pg.store, cleanup: pg.cleanup };
  },
  { skip: !hasDatabase },
);
