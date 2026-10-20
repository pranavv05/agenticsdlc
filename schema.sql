-- Run manually: psql "$DATABASE_URL" -f schema.sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS chunks (
  id           BIGSERIAL PRIMARY KEY,
  repo_name    TEXT NOT NULL,
  file_path    TEXT NOT NULL,
  symbol_name  TEXT,
  chunk_type   TEXT NOT NULL CHECK (chunk_type IN ('function','class','route','other')),
  code         TEXT NOT NULL,
  embedding    vector(1024),
  start_line   INT NOT NULL,
  end_line     INT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chunks_repo_idx ON chunks (repo_name, file_path);
CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS dependencies (
  repo_name          TEXT NOT NULL,
  file_path          TEXT NOT NULL,
  imports_file_path  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS dependencies_idx ON dependencies (repo_name, file_path);

CREATE TABLE IF NOT EXISTS cross_repo_links (
  from_repo  TEXT NOT NULL,
  to_repo    TEXT NOT NULL,
  evidence   TEXT[] NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS indexing_runs (
  id                  BIGSERIAL PRIMARY KEY,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at         TIMESTAMPTZ,
  status              TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','error')),
  per_repo_progress   JSONB NOT NULL DEFAULT '{}'::jsonb
);
