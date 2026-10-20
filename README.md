# Agentic SDD Platform

AI agents turn a business requirement into approved `requirements.md`, `design.md` and `tasks.md`, with human approval gates, then hand the approved spec to Claude Code through an MCP server. Full scope: [`docs/scope.pdf`](docs/scope.pdf). Team and ownership: [`docs/TEAM.md`](docs/TEAM.md).

Two cases, one pipeline with a pluggable context provider:

- **Case A**: build a small new project from scratch (no repo context).
- **Case B**: add a feature to an existing repo (a Context Agent grounds requirements and design in the real codebase).

## Layout

```
packages/
  contracts/     Zod schemas, status enum, state machine
  llm/           LLM gateway (the only module that calls the Anthropic SDK)
  context/       Context Agent library (chunking, embeddings, dependencies, CLAUDE.md, mindmaps, query)
  orchestrator/  Mastra workflow + REST API
  agents/        Requirement, Design and Task agents
  mcp-server/    MCP server for Claude Code
  ui/            React UI
  eval/          Evaluation cases, runner, scoring
apps/
  context-console/   Internal dev tool: run indexing and sanity-check retrieval
docs/                scope, decisions, team, tasks
```

Only `context` and `context-console` contain code today; the other packages are placeholders owned by teammates.

## Run locally in 5 minutes

Prerequisites: Node 22+, pnpm 12 (`npm i -g pnpm`), Docker (only for the console).

```bash
pnpm install
pnpm -r typecheck && pnpm test && pnpm lint   # needs no network and no API keys
```

Every model call goes through `@sdd/llm`. Set `LLM_MODE=mock` to run agents with no keys and no network (fixtures and offline embeddings); see [`packages/llm/README.md`](packages/llm/README.md).

To use the Context Agent console:

```bash
cp .env.example .env     # fill ANTHROPIC_API_KEY and VOYAGE_API_KEY (the DATABASE_URL default matches docker-compose)
pnpm db:up               # Postgres + pgvector in Docker; applies packages/context/schema.sql on first start
pnpm dev:console         # http://localhost:3000 - /indexing: register a repo (folder or Git URL), then index it; /query: try retrieval
```

Database helpers: `pnpm db:down` (stop, keep data), `pnpm db:reset` (wipe and re-apply the schema), `pnpm db:psql` (open a psql shell).

The Postgres tests (`packages/context/test/store.test.ts`, `indexing.pg.test.ts`) run in a private schema of the dev database and skip themselves when `DATABASE_URL` is not set; they need no API keys. After pulling a schema change run `pnpm db:reset`.

## Context Agent notes

- Generated docs and mind maps go to `output/` (or `CONTEXT_OUTPUT_DIR`), never into the target repo: `output/<repoId>/docs/<module>/CLAUDE.md.generated.md`, `output/<repoId>/mindmap.md`, `output/system.md`. They can be copied into a repo on request and an existing `CLAUDE.md` is never touched.
- Profile any folder or Git URL from the terminal: `pnpm --filter @sdd/context repo:profile <folder | url>` prints file count, lines of code per language and the recommended strategy (full pipeline from 200 source files, otherwise CLAUDE.md only).
- Getting context for a task (the seam the orchestrator uses):

  ```ts
  import { RepoContextProvider, NullContextProvider, getContextStore } from "@sdd/context";

  const provider = new RepoContextProvider({ store: getContextStore() }); // Case B; Case A uses new NullContextProvider()
  const bundle = await provider.getContext({
    repoId: "billing-service",
    task: "refund a partially paid invoice",
    mode: "hybrid",
    budgetTokens: 8000,
  });
  ```

  `mode` is `claude-md` (module docs + code search, no embeddings), `embeddings` or `hybrid`; the bundle never exceeds `budgetTokens`. The console's Query page lets you try all three.

- Re-indexing is incremental: only files changed since the last indexed commit are re-embedded. Schema notes for the migrations are in [`docs/CONTEXT-SCHEMA.md`](docs/CONTEXT-SCHEMA.md).
- Supported languages: TypeScript/JavaScript (including TSX/JSX), Python and Java. Add grammars in `packages/context/src/parse.ts`.
- Optional env: `LLM_MODEL` (default `claude-haiku-5-5` in development, `claude-sonnet-5-5` in production), `MAX_MODULES_PER_REPO` (default 25).

## Contributing

Branch from `main`, open a PR using the template, get one review. See [`docs/TEAM.md`](docs/TEAM.md).
