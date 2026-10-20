# Context Agent database schema (for the Drizzle migrations)

Source of truth today: `packages/context/schema.sql` (applied by Docker on the first start of the database). This page explains each table so the Drizzle definitions in the migrations issue (P2) can match it exactly. The Context Agent talks to the database only through the `ContextStore` interface (`packages/context/src/store/types.ts`); `PgContextStore` is the Postgres implementation and `MemoryContextStore` is the database-free one used by tests.

Existing dev databases from before this version need `pnpm db:reset`: `repo_name` became `repo_id` and there are new tables and columns.

## Tables

### `repos`: one row per registered repo

| Column                     | Type               | Notes                                                                                                                                          |
| -------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                       | `text` PK          | Slug, `^[a-z0-9][a-z0-9._-]{0,62}$` (CHECK). This is the `repoId` used by initiatives and the API.                                             |
| `name`                     | `text`             | Display name.                                                                                                                                  |
| `source_type`              | `text`             | `'path'` or `'url'` (CHECK).                                                                                                                   |
| `source_value`             | `text`             | Local path or clone URL.                                                                                                                       |
| `local_path`               | `text` null        | Where the working tree lives (the source path, or the clone in the cache directory).                                                           |
| `status`                   | `text`             | `profiling`, `profiled`, `indexing`, `indexed`, `failed` (CHECK). Same values as `RepoStatus` in `@sdd/contracts`.                             |
| `profile`                  | `jsonb` null       | `RepoProfile` from `@sdd/contracts` (file and LOC counts per language, recommended strategy and the reason).                                   |
| `index_strategy`           | `text` null        | `full` or `claude-md-only` (CHECK). The strategy of the last successful run.                                                                   |
| `indexed_commit_sha`       | `text` null        | Commit of the last **fully successful** run (chunks and docs). `<sha>+dirty` means uncommitted changes were indexed. Null for non-git folders. |
| `indexed_at`               | `timestamptz` null |                                                                                                                                                |
| `error`                    | `text` null        | Message of the last failed run; cleared by the next success.                                                                                   |
| `created_at`, `updated_at` | `timestamptz`      | Default `now()`. The application sets `updated_at`.                                                                                            |

### `chunks`: function, class and route level pieces of code

| Column                   | Type                          | Notes                                                                                                                    |
| ------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `id`                     | `bigserial` PK                |                                                                                                                          |
| `repo_id`                | `text` FK `repos(id)` cascade |                                                                                                                          |
| `file_path`              | `text`                        | Repo-relative, forward slashes.                                                                                          |
| `symbol_name`            | `text` null                   |                                                                                                                          |
| `chunk_type`             | `text`                        | `function`, `class`, `route`, `other` (CHECK).                                                                           |
| `code`                   | `text`                        |                                                                                                                          |
| `embedding`              | `vector(1024)` null           | `voyage-code-3`, 1024 dimensions. Null for chunks of repos indexed with `claude-md-only` (those store no chunks at all). |
| `start_line`, `end_line` | `int`                         | 1-based.                                                                                                                 |
| `commit_sha`             | `text` null                   | Commit the file was indexed at. Chunks of unchanged files keep their older SHA after an incremental run.                 |
| `created_at`             | `timestamptz`                 |                                                                                                                          |

Indexes: `(repo_id, file_path)`, and `hnsw (embedding vector_cosine_ops)`.

### `dependencies`: file-to-file imports

`repo_id` (FK cascade), `file_path`, `imports_file_path`. No primary key. Indexes on `(repo_id, file_path)` and `(repo_id, imports_file_path)` (the second serves "who imports this file"). Rebuilt completely on every run, in the same transaction as the chunks.

### `cross_repo_links`

`from_repo`, `to_repo` (both FK `repos(id)` cascade), `evidence text[]`. Index on `from_repo`. Replaced per source repo.

### `indexing_runs`: one row per indexing run of one repo

| Column                      | Type              | Notes                                                                                     |
| --------------------------- | ----------------- | ----------------------------------------------------------------------------------------- |
| `id`                        | `bigserial` PK    |                                                                                           |
| `repo_id`                   | `text` FK cascade |                                                                                           |
| `started_at`, `finished_at` | `timestamptz`     | `finished_at` null while running.                                                         |
| `status`                    | `text`            | `running`, `done`, `error` (CHECK).                                                       |
| `strategy`                  | `text`            | `full` or `claude-md-only`.                                                               |
| `mode`                      | `text` null       | `full` or `incremental`; null until planned, and for skipped runs.                        |
| `commit_sha`                | `text` null       | Commit being indexed.                                                                     |
| `from_commit_sha`           | `text` null       | Commit the previous successful run indexed (what the diff started from).                  |
| `progress`                  | `jsonb`           | Latest counts per stage, e.g. `{"embeddings": {"done": 12, "total": 12, "complete": 1}}`. |
| `error`                     | `text` null       |                                                                                           |

Index on `(repo_id, id DESC)`.

## Behaviour the migrations must preserve

- **One transaction per index update.** `replaceIndex` deletes the old chunks (all of them, or the changed files') and inserts the new ones and the new dependency edges in a single transaction. If anything fails the previous index is untouched. Do not split this across connections or move the delete out of the transaction.
- **Incremental update.** Chunks are keyed by `(repo_id, file_path)` for deletion; chunk ids of unchanged files must not change.
- **Cascades.** Deleting a repo removes its chunks, dependencies, links and runs.

## Drizzle sketch

pgvector support is built into `drizzle-orm/pg-core` (`vector`).

```ts
import { bigserial, check, customType, index, integer, jsonb, pgTable, text, timestamp, vector } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const repos = pgTable(
  "repos",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    sourceType: text("source_type").notNull(),
    sourceValue: text("source_value").notNull(),
    localPath: text("local_path"),
    status: text("status").notNull(),
    profile: jsonb("profile"),
    indexStrategy: text("index_strategy"),
    indexedCommitSha: text("indexed_commit_sha"),
    indexedAt: timestamp("indexed_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("repos_id_slug", sql`${t.id} ~ '^[a-z0-9][a-z0-9._-]{0,62}$'`) /* plus the status / strategy / source_type checks */],
);

export const chunks = pgTable(
  "chunks",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    filePath: text("file_path").notNull(),
    symbolName: text("symbol_name"),
    chunkType: text("chunk_type").notNull(),
    code: text("code").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }),
    startLine: integer("start_line").notNull(),
    endLine: integer("end_line").notNull(),
    commitSha: text("commit_sha"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("chunks_repo_file_idx").on(t.repoId, t.filePath),
    index("chunks_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);
```

Remember `CREATE EXTENSION IF NOT EXISTS vector;` in the first migration.
