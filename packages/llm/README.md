# @sdd/llm

The only module that calls a model or an embeddings API. Agents import from here; ESLint blocks `@anthropic-ai/sdk` everywhere else.

```ts
import { generateStructured, generateText, wrapUntrusted } from "@sdd/llm";

const { data, usage } = await generateStructured({
  agent: "requirement", // who is calling (an AgentName from @sdd/contracts)
  name: "requirements-draft", // tool name and mock-fixture key
  schema: RequirementDraftSchema, // a Zod object schema, no transforms
  system: promptFile,
  input: wrapUntrusted("requirement", initiative.businessRequirement), // anything from a user or a repo goes through wrapUntrusted
  maxTokens: 6000, // optional, at most 16,384 per call
  effort: "medium", // optional
  initiativeId, // optional, lands on the usage record
});
// data is typed as z.infer<typeof RequirementDraftSchema>
// usage = { inputTokens, outputTokens, costUsd, model, latencyMs }, summed over every billed attempt
```

`generateText({ agent, name?, system, input })` returns `{ text, truncated, usage }` for prose such as CLAUDE.md files.

## What it guarantees

| Behaviour               | Detail                                                                                                                                                                                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema-valid output     | The Zod schema is sent as a tool, the answer is validated with Zod. On failure it retries **once** with the validation errors fed back, then throws `LlmValidationError`.                                                                                                                            |
| Retry and backoff       | 429, 5xx (including 529), timeouts and network errors are retried up to 4 times with exponential backoff and jitter (1s, 2s, 4s, ... capped at 30s), honouring `Retry-After`. 4xx other than 408/409/429 fail at once with `LlmApiError`.                                                            |
| Timeout                 | 120s per request (`LLM_TIMEOUT_MS`). A hung request is aborted and retried.                                                                                                                                                                                                                          |
| Hard caps               | `maxTokens` above 16,384 is rejected. A prompt over 600,000 characters is rejected. Nothing is truncated for you.                                                                                                                                                                                    |
| Usage on every call     | `onUsage(record)` fires once per billed request, including the failed first attempt of a validation retry, and once more if the API gives up. Turn a record into an `AgentRun` row with `toAgentRun(record, { id, createdAt })`. A throwing hook fails the call, so a lost cost row is never silent. |
| Refusals and truncation | `stop_reason: refusal` throws `LlmRefusalError` (with the category). Structured output cut off at `maxTokens` throws `LlmTruncatedError`. Neither is retried.                                                                                                                                        |

## Models

The model comes from the call's `model`, else `LLM_MODEL` (the legacy `SDD_MODEL` and `CLAUDE_MODEL` still work), else `claude-sonnet-5-5` when `NODE_ENV=production` and the cheaper `claude-haiku-5-5` everywhere else. **Set `LLM_MODEL` for real evaluation runs.**

Every model needs a price in `src/prices.ts` (versioned by `PRICE_TABLE_VERSION`); a model without one is rejected before anything is sent, so a cost can never silently be $0.

**Forced tool use.** `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-fable-5-1` and `claude-mythos-5-1` return HTTP 400 for `tool_choice: {type: "tool"}`. For those (and any model not on the allow-list in `src/models.ts`) the gateway sends `tool_choice: auto` plus an explicit instruction to call the tool, and relies on Zod validation and the one retry. Older models that accept forced tool use get it. The gateway never sends `temperature`, `top_p`, `top_k` or `budget_tokens`, which the newer models reject.

## Modes (`LLM_MODE`)

| Mode             | What happens                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `live` (default) | Calls the model.                                                                                                                                 |
| `mock`           | No network, no keys. Structured calls are answered from fixtures; embeddings are deterministic offline vectors. CI and UI work run in this mode. |
| `record`         | Calls the model and saves each answer as a fixture, so a later `mock` run replays it.                                                            |

**Mock fixtures** are looked up by `sha256(agent, name, input)` in this order: entries added in code (`gateway.fixtures.put(agent, name, input, { data })`), files in `packages/llm/fixtures/<agent>/<name>/<key>.json` (or `LLM_FIXTURES_DIR`), then responders registered with `gateway.fixtures.respond(agent, name, input => data)`. A structured call with none of these throws `LlmMockFixtureMissingError` naming the key and the fix. A fixture that no longer matches its schema throws `LlmValidationError`, so fixtures cannot rot silently. Mock usage records have realistic token counts and costs, with `mocked: true`.

`generateText` in mock mode returns a fixture if one exists, else a clearly marked `[mock] agent/name key` placeholder.

**Embeddings.** `embedTexts` / `createEmbedder` use Voyage `voyage-code-3` (1024 dimensions, batches of 32, retries as above). In mock mode the vectors are feature-hashed word pieces, L2-normalised: texts that share words score higher, so offline retrieval tests rank sensibly. They are not semantic.

## `wrapUntrusted(label, text, { maxChars })`

Wraps text from a user or repository as data: an instruction before the block, markers carrying a hash of the content (so the closing marker cannot be forged from inside the text), `<<<` and `>>>` neutralised, control characters removed. Over `maxChars` (default 50,000) it throws instead of truncating. It lowers prompt-injection risk; it does not remove it, so agents must still validate their output.

## Providers

`LLM_PROVIDER=anthropic` (default) uses `ANTHROPIC_API_KEY` or whatever credentials the SDK resolves. `LLM_PROVIDER=bedrock` uses the bearer-token invoke endpoint from the prototype: set `BEDROCK_API_KEY` (or `AWS_BEARER_TOKEN_BEDROCK`), `AWS_REGION` and `LLM_MODEL` (a Bedrock model or inference-profile id; prices are matched on the Claude name inside it).

## Wiring it up

```ts
import { createEmbedder, createGateway, setEmbedder, setGateway, toAgentRun } from "@sdd/llm";

const onUsage = (record) => repository.saveRun(toAgentRun(record, { id: crypto.randomUUID(), createdAt: new Date().toISOString() }));
setGateway(createGateway({ onUsage }));
setEmbedder(createEmbedder({ onUsage }));
```

Tests pass a `transport` (see `test/helpers.ts`) to script responses, or use mock mode.

## Not covered

- The live API path was verified against a local server that plays the Messages API (the real SDK, no network). It has not been run against Anthropic itself because there is no key in this environment.
- Prompt caching is not used. Cache token fields in responses are priced if present.
- No streaming. Calls are capped at 16,384 output tokens so they stay within SDK non-streaming limits.
