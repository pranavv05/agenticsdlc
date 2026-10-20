# Tasks

The GitHub issues are the source of truth for status; this page is the map. Owners are in [TEAM.md](TEAM.md). One small PR per issue, with the PR template, and the rules in TEAM.md (never commit to `main`, tests pass offline, no secrets).

Status here means what is on the branches today: **done** (merged or in an open PR), **partly** (built, with a named gap), **open** (not started, or not reported to Pranav).

## Pranav

| Issue | Task                                         | Status | What is left                                                                                                                    |
| ----- | -------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| #3    | G0 LLM gateway (`@sdd/llm`)                  | done   | A live run with a real key (none available yet).                                                                                |
| #40   | W1 Workflow state machine                    | done   |                                                                                                                                 |
| #11   | C1 Repo profiler                             | done   |                                                                                                                                 |
| #12   | C2 Tree-sitter chunker                       | partly | Check route-handler detection on the real evaluation repo.                                                                      |
| #13   | C3 Dependency table                          | partly | tsconfig path aliases, logging unresolved imports, `getCallers`/`getCallees`.                                                   |
| #14   | C4 Module detection and CLAUDE.md generation | partly | Choose one generated-docs file name (`CLAUDE.generated.md` vs `CLAUDE.md.generated.md`); check output by hand with a live key.  |
| #15   | C5 Context provider                          | done   | Recall on the real repo comes from the C7 report.                                                                               |
| #16   | C6 Embeddings retrieval                      | partly | The **live** comparison table (needs `VOYAGE_API_KEY` and `ANTHROPIC_API_KEY`).                                                 |
| #45   | C7 Retrieval-quality harness                 | partly | Built offline; the real open-source repo dataset (Sourav, #22) and the live run.                                                |
| #41   | W2 Orchestrator workflow core, human gates   | open   | Phase 5, first. Mastra workflow, `Repository` interface with an in-memory implementation, Case A and Case B tests in mock mode. |
| #44   | W5 Service functions for the REST layer      | open   | Phase 5, right after W2. **Unblocks Shuraim (#7).**                                                                             |
| #42   | W3 Requirement Agent and Critic              | open   | Phase 5.                                                                                                                        |
| #43   | W4 Design Agent, Critic, grounding check     | open   | Phase 5.                                                                                                                        |
| #2    | Setup umbrella                               | partly | Branch protection (needs GitHub Pro or a public repo), a spend limit on the Claude Console organisation.                        |

## Shuraim

| Issue | Task                                    | Depends on                    |
| ----- | --------------------------------------- | ----------------------------- |
| #4    | Onboarding PR                           |                               |
| #7    | A1 REST API layer                       | W5 (#44), `docs/API.md`       |
| #8    | A2 Task Agent                           | W3, W4 (agent pattern)        |
| #9    | A3 Prompt-injection and input hardening | `wrapUntrusted` in `@sdd/llm` |
| #10   | A4 Evaluation scoring scripts           | W4 grounding result, C7       |

## Sourav

| Issue | Task                                 | Depends on                                   |
| ----- | ------------------------------------ | -------------------------------------------- |
| #5    | Onboarding PR                        |                                              |
| #17   | S1 UI app skeleton                   |                                              |
| #18   | S2 Mock API and typed client         | `docs/API.md` and `@sdd/contracts` (done)    |
| #19   | S3 Create-initiative page            | S2                                           |
| #20   | S4 Initiative detail and review page | S2                                           |
| #21   | S5 Switch the UI to the real API     | A1 (#7)                                      |
| #22   | S6 Evaluation cases                  | `packages/eval/retrieval/README.md` (format) |

## Tejas

| Issue | Task                    | Depends on                                                                                                  |
| ----- | ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| #6    | Onboarding PR           |                                                                                                             |
| #23   | P1 Local infrastructure | Postgres in Docker is already in the repo (`pnpm db:up`); extend, do not redo.                              |
| #24   | P2 Database migrations  | `docs/CONTEXT-SCHEMA.md` (the context tables) and the `Repository` interface from W2                        |
| #25   | P3 CI                   | `pnpm install --frozen-lockfile && pnpm -r typecheck && pnpm test && pnpm lint`, plus `pnpm docs:api:check` |
| #26   | P4 Git integration      |                                                                                                             |
| #27   | P5 MCP server           | tasks.md from the Task Agent (A2)                                                                           |
| #28   | P6 Evaluation runner    | C7 harness, A4                                                                                              |

## Critical path

`W2` (workflow core) → `W5` (service functions) → Shuraim's `A1` (REST layer) → Sourav's `S5` (real API in the UI).
Agents (`W3`, `W4`) can proceed in parallel after `W2`; `A2` follows them. Everything else is independent of that path.

## Not in scope

Per the scope document: no HTTP API, UI, MCP server, Task Agent or Git/PR integration has been built by Pranav. The seams are the `ContextProvider` interface, the `Repository` interface (W2) and the service functions (W5).
