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
# edit apps/context-console/repos.config.json with your repos (name, absolute path, description)
pnpm dev:console         # http://localhost:3000 - open /indexing, then /query
```

Database helpers: `pnpm db:down` (stop, keep data), `pnpm db:reset` (wipe and re-apply the schema), `pnpm db:psql` (open a psql shell).

Integration tests (`packages/context/test/indexing.integration.test.ts`) run only when `DATABASE_URL`, `VOYAGE_API_KEY` and an LLM key are set.

## Context Agent notes

- Generated docs go to `<repo>/<module>/CLAUDE.md.generated.md`; an existing `CLAUDE.md` is never touched. Mindmaps go to `output/`.
- Supported languages: TypeScript/JavaScript (including TSX/JSX), Python and Java. Add grammars in `packages/context/src/parse.ts`.
- Optional env: `LLM_MODEL` (default `claude-haiku-5-5` in development, `claude-sonnet-5-5` in production), `MAX_MODULES_PER_REPO` (default 25).

## Contributing

Branch from `main`, open a PR using the template, get one review. See [`docs/TEAM.md`](docs/TEAM.md).
