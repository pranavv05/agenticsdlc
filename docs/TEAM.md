# Team and ownership

| Person  | Owns                                                                                                           | Packages                                                |
| ------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Pranav  | Technical owner. Contracts, LLM gateway, Context Agent, workflow, Requirement and Design agents, architecture | `contracts`, `llm`, `context`, `orchestrator`, `agents` |
| Shuraim | REST API layer, Task Agent, prompt-injection hardening, evaluation scoring                                     | `orchestrator` (API layer), `agents` (Task), `eval`     |
| Sourav  | React UI built against a mock API, evaluation cases                                                            | `ui`, `eval` (cases)                                    |
| Tejas   | Docker, migrations, CI, Git integration, MCP server, evaluation runner                                         | `mcp-server`, infra, CI, `eval` (runner)                |

Detailed task lists, owners and timing live in `docs/TASKS.md` and the GitHub issues.

## Working agreements

- Never commit to `main`. One branch per piece of work (`feat/<topic>`, `fix/<topic>`), one PR per branch, one review before merge.
- Conventional commit messages (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).
- Commit with your personal git identity. Check `git config user.email` before your first commit.
- No secrets in the repo. Keys live in `.env` (gitignored); `.env.example` lists names only.
- Tests must pass offline with no API keys (mock mode). A test that needs a real key is an integration test and skips itself unless the keys are set.
- Contracts are the source of truth: change `packages/contracts` first, then the code that depends on it, and regenerate `docs/API.md`.
