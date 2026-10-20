# sdd-poc — Context Agent indexing

1. `cp .env.example .env.local` and fill `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `DATABASE_URL`.
2. `psql "$DATABASE_URL" -f schema.sql` (needs the pgvector extension available).
3. Edit `repos.config.json` with your real repos (`name`, absolute `path`, `description`).
4. `npm run dev`, open `/index`, press **Start Indexing**; verbose logs print in the dev-server terminal.
5. Open `/query` to sanity-check retrieval.

Tests: `npm test` (static-analysis tests always run; the end-to-end `indexing.integration.test.ts` runs only when all three env vars are set).

Notes
- Generated docs go to `<repo>/<module>/CLAUDE.md.generated.md`; an existing `CLAUDE.md` is never touched. Mindmaps go to `output/`.
- Supported languages: TypeScript/JavaScript (incl. TSX/JSX) and Python. Add grammars in `lib/context-agent/parse.ts`.
- Optional env: `CLAUDE_MODEL` (default `claude-sonnet-5-5`), `MAX_MODULES_PER_REPO` (default 25).
