-- Context Agent schema. Applied automatically on the first start of the Docker database (see docker-compose.yml),
-- or manually: psql "$DATABASE_URL" -f schema.sql
-- Existing databases from before this version need `pnpm db:reset` (repo_name became repo_id and there are new tables).
-- docs/CONTEXT-SCHEMA.md describes every table for the Drizzle migrations.
CREATE EXTENSION IF NOT EXISTS vector;

-- One row per registered repo. `id` is the slug that initiatives use as repoId.
CREATE TABLE IF NOT EXISTS repos (
  id                  TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9._-]{0,62}$'),
  name                TEXT NOT NULL,
  source_type         TEXT NOT NULL CHECK (source_type IN ('path','url')),
  source_value        TEXT NOT NULL,
  local_path          TEXT,
  status              TEXT NOT NULL CHECK (status IN ('profiling','profiled','indexing','indexed','failed')),
  profile             JSONB,
  index_strategy      TEXT CHECK (index_strategy IN ('full','claude-md-only')),
  indexed_commit_sha  TEXT,
  indexed_at          TIMESTAMPTZ,
  error               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chunks (
  id           BIGSERIAL PRIMARY KEY,
  repo_id      TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  file_path    TEXT NOT NULL,
  symbol_name  TEXT,
  chunk_type   TEXT NOT NULL CHECK (chunk_type IN ('function','class','route','other')),
  code         TEXT NOT NULL,
  embedding    vector(1024),
  start_line   INT NOT NULL,
  end_line     INT NOT NULL,
  commit_sha   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chunks_repo_file_idx ON chunks (repo_id, file_path);
CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS dependencies (
  repo_id            TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  file_path          TEXT NOT NULL,
  imports_file_path  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS dependencies_from_idx ON dependencies (repo_id, file_path);
CREATE INDEX IF NOT EXISTS dependencies_to_idx ON dependencies (repo_id, imports_file_path);

CREATE TABLE IF NOT EXISTS cross_repo_links (
  from_repo  TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  to_repo    TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  evidence   TEXT[] NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS cross_repo_links_from_idx ON cross_repo_links (from_repo);

-- One row per indexing run of one repo.
CREATE TABLE IF NOT EXISTS indexing_runs (
  id               BIGSERIAL PRIMARY KEY,
  repo_id          TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ,
  status           TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','error')),
  strategy         TEXT NOT NULL CHECK (strategy IN ('full','claude-md-only')),
  mode             TEXT CHECK (mode IN ('full','incremental')),
  commit_sha       TEXT,
  from_commit_sha  TEXT,
  progress         JSONB NOT NULL DEFAULT '{}'::jsonb,
  error            TEXT
);
CREATE INDEX IF NOT EXISTS indexing_runs_repo_idx ON indexing_runs (repo_id, id DESC);
