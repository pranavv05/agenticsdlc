# Architecture

AI agents turn a business requirement into approved `requirements.md`, `design.md` and `tasks.md`, with a human approval gate between each, and the approved spec is handed to Claude Code through an MCP server. Agents propose; the orchestrator moves the status; humans approve.

## Components

```mermaid
flowchart LR
  UI["UI (packages/ui)"] --> API["REST API layer (docs/API.md)"]
  API --> SVC["Service functions (packages/orchestrator)"]
  SVC --> WF["Workflow with human gates (Mastra)"]
  WF --> REPO[("Repository interface")]
  REPO --> DB[("Postgres + pgvector")]
  WF --> AG["Agents: Requirement, Design, Task (packages/agents)"]
  AG --> LLM["LLM gateway (packages/llm)"]
  LLM --> CLAUDE["Claude API"]
  LLM --> VOYAGE["Voyage embeddings"]
  AG --> CTX["ContextProvider (packages/context)"]
  CTX --> STORE[("ContextStore")]
  STORE --> DB
  IDX["Indexer + repo registry (packages/context)"] --> STORE
  IDX --> LLM
  IDX --> GIT["Target repos"]
  MCP["MCP server (packages/mcp-server)"] --> API
  CC["Claude Code"] --> MCP
  CON["Context console (apps/context-console)"] --> IDX
  CON --> CTX
  EVAL["Evaluation (packages/eval)"] --> CTX
  CONTRACTS["Contracts (packages/contracts)"] -.-> API
  CONTRACTS -.-> SVC
  CONTRACTS -.-> AG
```

Built today: `contracts`, `llm`, `context` (indexer, registry, provider), the context console and the retrieval harness in `eval`. Not built yet: `orchestrator`, `agents`, the REST layer, `ui`, `mcp-server` (see [TASKS.md](TASKS.md)).

## Initiative status machine

Source of truth: `packages/contracts/src/state-machine.ts`. Every transition names who may trigger it; there is no "agent" actor.

```mermaid
stateDiagram-v2
  [*] --> READY_FOR_SPEC
  READY_FOR_SPEC --> REQUIREMENT_GENERATING: product, orchestrator
  REQUIREMENT_GENERATING --> REQUIREMENT_REVIEW: orchestrator, open questions
  REQUIREMENT_GENERATING --> REQUIREMENT_REVIEWED: orchestrator, no gaps
  REQUIREMENT_REVIEW --> REQUIREMENT_GENERATING: product answers
  REQUIREMENT_REVIEWED --> SPEC_APPROVED: product approves
  REQUIREMENT_REVIEWED --> REQUIREMENT_GENERATING: product requests changes
  SPEC_APPROVED --> DESIGN_GENERATING: orchestrator
  DESIGN_GENERATING --> DESIGN_REVIEW: orchestrator
  DESIGN_REVIEW --> DESIGN_APPROVED: architecture approves
  DESIGN_REVIEW --> DESIGN_REVISION_REQUESTED: architecture requests changes
  DESIGN_REVISION_REQUESTED --> DESIGN_GENERATING: orchestrator
  DESIGN_APPROVED --> TASKS_GENERATING: orchestrator
  TASKS_GENERATING --> READY_FOR_DEVELOPMENT: orchestrator
  READY_FOR_DEVELOPMENT --> IN_DEVELOPMENT: developer, orchestrator
  IN_DEVELOPMENT --> DONE: developer, orchestrator
  DONE --> [*]
```

The two human gates are `REQUIREMENT_REVIEW`/`REQUIREMENT_REVIEWED` (Product) and `DESIGN_REVIEW` (Architecture). The workflow suspends at each and resumes only on an explicit decision, never because of a comment.

## Case A and Case B

|                  | Case A: new product                  | Case B: existing repo                                           |
| ---------------- | ------------------------------------ | --------------------------------------------------------------- |
| Context provider | `NullContextProvider` (empty bundle) | `RepoContextProvider`                                           |
| Design Agent     | proposes the structure               | must cite real files and modules, checked by the grounding step |
| Retrieval        | none                                 | `claude-md`, `embeddings` or `hybrid`, under `budgetTokens`     |

## Context Agent (what exists)

```mermaid
flowchart TD
  REG["Register repo (folder or Git URL)"] --> PROF["Profile: files and lines per language"]
  PROF --> REC{"Source files >= 200?"}
  REC -- yes --> FULL["strategy: full"]
  REC -- no --> LITE["strategy: claude-md-only"]
  FULL --> PLAN["Plan: full or incremental (git diff)"]
  LITE --> PLAN
  PLAN --> CHUNK["Tree-sitter chunks + dependency edges"]
  CHUNK --> EMB["Embeddings (full only)"]
  CHUNK --> DOCS["Module docs, root index, mind map"]
  EMB --> TX["One transaction: replace the index, record commit SHA"]
  DOCS --> OUT["Docs output folder (never the target repo by default)"]
  TX --> QUERY["getContext(task, mode, budget)"]
  OUT --> QUERY
```

## Where each rule is enforced

| Rule                                       | Where                                                            |
| ------------------------------------------ | ---------------------------------------------------------------- |
| Agents cannot change status                | no `agent` actor in `ACTORS`; `assertTransition`                 |
| Only Product approves requirements         | `TRANSITION_RULES` (`REQUIREMENT_REVIEWED` → `SPEC_APPROVED`)    |
| Only Architecture approves designs         | `TRANSITION_RULES` (`DESIGN_REVIEW` → `DESIGN_APPROVED`)         |
| API cannot drift from the contracts        | `docs/API.md` is generated; `pnpm docs:api:check` fails on drift |
| Untrusted text cannot act as instructions  | `wrapUntrusted` in `@sdd/llm`                                    |
| Cost is recorded for every model call      | `AgentRun` via `toAgentRun`, one per billed call                 |
| A failed index never leaves a half-index   | transactional `replaceIndex` in `ContextStore`                   |
| Generated docs never overwrite a real file | `DocsOutput` writes to its own folder; `publishToRepo` is opt-in |

See [DECISIONS.md](DECISIONS.md) for the reasoning, [API.md](API.md) for the endpoints and [CONTEXT-SCHEMA.md](CONTEXT-SCHEMA.md) for the context tables.
