import { AgentNameSchema, AgentRunSchema, type AgentName, type AgentRun } from "@sdd/contracts";
import { z } from "zod";
import {
  LlmApiError,
  LlmConfigError,
  LlmError,
  LlmInputError,
  LlmMockFixtureMissingError,
  LlmRefusalError,
  LlmTruncatedError,
  LlmValidationError,
  TransportError,
} from "./errors";
import { FixtureStore, fixtureKey } from "./fixtures";
import { resolveModel, supportsForcedToolChoice } from "./models";
import { MODEL_PRICES, computeCostUsd, normalizeModelId } from "./prices";
import { backoffDelay } from "./retry";
import {
  createAnthropicTransport,
  createBedrockTransport,
  type Effort,
  type LlmRequest,
  type LlmResponse,
  type Transport,
} from "./transport";

export type LlmMode = "live" | "mock" | "record";
export type LlmProvider = "anthropic" | "bedrock";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
  latencyMs: number;
}

/** One billed model call. The orchestrator turns each into an AgentRun row (see `toAgentRun`). */
export interface UsageRecord extends Usage {
  agent: AgentName;
  /** The schema name for structured calls, the request's name (default "text") for text calls. */
  name: string;
  status: "succeeded" | "failed";
  error?: string;
  initiativeId?: string;
  /** True when the answer came from a fixture, not the model. Cost is still computed so mock runs show realistic numbers. */
  mocked: boolean;
}

export type UsageHook = (record: UsageRecord) => void | Promise<void>;

interface CommonRequest {
  /** Which agent is calling. Used for the usage record and the mock fixture key. */
  agent: AgentName;
  /** Tool name and fixture key. Letters, digits, underscore and dash, at most 64 characters. */
  name: string;
  system: string;
  /** The user message. Wrap anything that came from a user or a repo with `wrapUntrusted` first. */
  input: string;
  /** Overrides the configured model for this call. */
  model?: string;
  /** Output ceiling for this call, at most `maxTokensCap` (default 16,384). Thinking tokens count against it. */
  maxTokens?: number;
  /** Thinking depth on models that support it. Omitted means the model's own default. */
  effort?: Effort;
  initiativeId?: string;
  signal?: AbortSignal;
}

export interface StructuredRequest<S extends z.ZodType> extends CommonRequest {
  /** Must describe a JSON object and contain no transforms, so it can be sent as a tool schema. */
  schema: S;
}

export interface TextRequest extends Omit<CommonRequest, "name"> {
  name?: string;
}

export interface StructuredResult<T> {
  data: T;
  /** Summed over every billed attempt, including the retry after a validation failure. */
  usage: Usage;
}

export interface TextResult {
  text: string;
  /** True when the model hit maxTokens, so `text` is cut off. Callers decide whether that is acceptable. */
  truncated: boolean;
  usage: Usage;
}

export interface GatewayOptions {
  /** "live" calls the model, "mock" serves fixtures, "record" calls the model and saves fixtures. Default: LLM_MODE or "live". */
  mode?: LlmMode;
  /** Default: LLM_PROVIDER or "anthropic". */
  provider?: LlmProvider;
  /** Replaces the real HTTP transport (tests). */
  transport?: Transport;
  fixtures?: FixtureStore;
  onUsage?: UsageHook;
  timeoutMs?: number;
  /** Retries after the first attempt, for 429/5xx/network errors. Default 4. */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxTokensCap?: number;
  defaultMaxTokens?: number;
  /** Ceiling for system + input characters in one call. Default 600,000. */
  maxInputChars?: number;
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  clock?: () => number;
}

export interface Gateway {
  readonly mode: LlmMode;
  readonly provider: LlmProvider;
  readonly fixtures: FixtureStore;
  generateStructured<S extends z.ZodType>(request: StructuredRequest<S>): Promise<StructuredResult<z.output<S>>>;
  generateText(request: TextRequest): Promise<TextResult>;
}

const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function parseMode(value: string | undefined): LlmMode {
  if (value === undefined || value === "") return "live";
  if (value === "live" || value === "mock" || value === "record") return value;
  throw new LlmConfigError(`LLM_MODE must be "live", "mock" or "record", got "${value}"`);
}

function parseProvider(value: string | undefined): LlmProvider {
  if (value === undefined || value === "") return "anthropic";
  if (value === "anthropic" || value === "bedrock") return value;
  throw new LlmConfigError(`LLM_PROVIDER must be "anthropic" or "bedrock", got "${value}"`);
}

function envNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new LlmConfigError(`Expected a non-negative number, got "${value}"`);
  return n;
}

const estimateTokens = (chars: number) => Math.ceil(chars / 4);

function formatIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, 20)
    .map((i) => `- ${i.path.length ? i.path.map(String).join(".") : "(root)"}: ${i.message}`)
    .join("\n");
}

export function createGateway(options: GatewayOptions = {}): Gateway {
  const env = options.env ?? process.env;
  const mode = options.mode ?? parseMode(env.LLM_MODE);
  const provider = options.provider ?? parseProvider(env.LLM_PROVIDER);
  const timeoutMs = options.timeoutMs ?? envNumber(env.LLM_TIMEOUT_MS, 120_000);
  const maxRetries = options.maxRetries ?? envNumber(env.LLM_MAX_RETRIES, 4);
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const maxTokensCap = options.maxTokensCap ?? 16_384;
  const defaultMaxTokens = Math.min(options.defaultMaxTokens ?? 8_192, maxTokensCap);
  const maxInputChars = options.maxInputChars ?? 600_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const clock = options.clock ?? (() => performance.now());
  const fixtures = options.fixtures ?? new FixtureStore({ dir: env.LLM_FIXTURES_DIR });

  let transport = options.transport;
  const getTransport = (): Transport => {
    transport ??=
      provider === "bedrock"
        ? createBedrockTransport({ apiKey: env.BEDROCK_API_KEY || env.AWS_BEARER_TOKEN_BEDROCK || "", region: env.AWS_REGION || "" })
        : createAnthropicTransport();
    return transport;
  };

  // ---- shared pieces ----

  function checkRequest(request: CommonRequest): { model: string; maxTokens: number } {
    if (!AgentNameSchema.safeParse(request.agent).success) throw new LlmInputError(`Unknown agent "${request.agent}"`);
    if (!NAME_PATTERN.test(request.name)) throw new LlmInputError(`Call name "${request.name}" must match ${NAME_PATTERN}`);
    if (!request.input.trim()) throw new LlmInputError("input is empty");
    const size = request.system.length + request.input.length;
    if (size > maxInputChars) {
      throw new LlmInputError(
        `Prompt is ${size} characters, over the limit of ${maxInputChars}. Shorten the input; it is not truncated for you.`,
      );
    }
    const maxTokens = request.maxTokens ?? defaultMaxTokens;
    if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new LlmInputError(`maxTokens must be a positive integer, got ${maxTokens}`);
    if (maxTokens > maxTokensCap) throw new LlmInputError(`maxTokens ${maxTokens} is over the hard cap of ${maxTokensCap} per call`);

    const model = resolveModel(request.model, env, provider);
    // Fail before spending anything if the cost of this model cannot be computed.
    try {
      computeCostUsd(model, { inputTokens: 0, outputTokens: 0 });
    } catch (error) {
      throw new LlmConfigError(error instanceof Error ? error.message : String(error), { cause: error });
    }
    return { model, maxTokens };
  }

  /** One logical request: retries 429/5xx/network/timeouts with backoff; throws LlmApiError when it gives up. */
  async function send(base: LlmRequest, outer?: AbortSignal): Promise<{ response: LlmResponse; latencyMs: number }> {
    for (let attempt = 1; ; attempt++) {
      const controller = new AbortController();
      const forward = () => controller.abort(outer?.reason);
      outer?.addEventListener("abort", forward, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const started = clock();
      try {
        const response = await Promise.race([
          getTransport().send({ ...base, signal: controller.signal }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new TransportError(`Request timed out after ${timeoutMs}ms`, undefined, true));
            }, timeoutMs);
          }),
        ]);
        return { response, latencyMs: Math.max(0, Math.round(clock() - started)) };
      } catch (error) {
        if (outer?.aborted) throw new LlmApiError("Request aborted by the caller", undefined, attempt, { cause: error });
        if (error instanceof LlmConfigError) throw error;
        const failure =
          error instanceof TransportError
            ? error
            : new TransportError(error instanceof Error ? error.message : String(error), undefined, true, undefined, { cause: error });
        if (!failure.retryable || attempt > maxRetries) {
          throw new LlmApiError(
            `LLM request failed after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${failure.message}`,
            failure.status,
            attempt,
            { cause: failure },
          );
        }
        await sleep(backoffDelay(attempt - 1, { baseDelayMs, maxDelayMs, random, retryAfterMs: failure.retryAfterMs }));
      } finally {
        clearTimeout(timer);
        outer?.removeEventListener("abort", forward);
      }
    }
  }

  const pricedModel = (served: string, requested: string): string => (MODEL_PRICES[normalizeModelId(served)] ? served : requested);

  async function report(
    request: CommonRequest,
    usage: Usage,
    status: "succeeded" | "failed",
    mocked: boolean,
    error?: string,
  ): Promise<void> {
    await options.onUsage?.({
      ...usage,
      agent: request.agent,
      name: request.name,
      status,
      ...(error ? { error: error.slice(0, 2_000) } : {}),
      ...(request.initiativeId ? { initiativeId: request.initiativeId } : {}),
      mocked,
    });
  }

  const usageFrom = (response: LlmResponse, requested: string, latencyMs: number): Usage => {
    const model = pricedModel(response.model, requested);
    return {
      inputTokens: response.usage.inputTokens + response.usage.cacheReadTokens + response.usage.cacheWriteTokens,
      outputTokens: response.usage.outputTokens,
      costUsd: computeCostUsd(model, {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cacheReadTokens: response.usage.cacheReadTokens,
        cacheWriteTokens: response.usage.cacheWriteTokens,
      }),
      model: response.model,
      latencyMs,
    };
  };

  const sum = (a: Usage, b: Usage): Usage => ({
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: Math.round((a.costUsd + b.costUsd) * 1e6) / 1e6,
    model: b.model,
    latencyMs: a.latencyMs + b.latencyMs,
  });

  const zeroUsage = (model: string): Usage => ({ inputTokens: 0, outputTokens: 0, costUsd: 0, model, latencyMs: 0 });

  function mockUsage(model: string, inputChars: number, output: string, recorded?: { inputTokens: number; outputTokens: number }): Usage {
    const inputTokens = recorded?.inputTokens ?? estimateTokens(inputChars);
    const outputTokens = recorded?.outputTokens ?? estimateTokens(output.length);
    return { inputTokens, outputTokens, costUsd: computeCostUsd(model, { inputTokens, outputTokens }), model, latencyMs: 0 };
  }

  // ---- structured output ----

  function toolSchemaFor(name: string, schema: z.ZodType): Record<string, unknown> {
    let json: Record<string, unknown>;
    try {
      json = z.toJSONSchema(schema, { io: "output", unrepresentable: "throw" }) as Record<string, unknown>;
    } catch (error) {
      throw new LlmConfigError(
        `Schema "${name}" cannot be sent as a tool schema (remove transforms and other unrepresentable types): ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (json.type !== "object") throw new LlmConfigError(`Schema "${name}" must describe a JSON object: tool inputs are objects`);
    delete json.$schema;
    return json;
  }

  async function generateStructured<S extends z.ZodType>(request: StructuredRequest<S>): Promise<StructuredResult<z.output<S>>> {
    const { model, maxTokens } = checkRequest(request);
    const inputSchema = toolSchemaFor(request.name, request.schema);

    if (mode === "mock") return mockStructured(request, model);

    const forced = supportsForcedToolChoice(model);
    const system = forced
      ? request.system
      : `${request.system}\n\nAnswer by calling the "${request.name}" tool exactly once with your complete answer. Do not write any other text.`;
    const tool = {
      name: request.name,
      description: "Return the final answer as structured data that matches the input schema.",
      inputSchema,
      forced,
    };

    let total = zeroUsage(model);
    let user = request.input;

    for (let attempt = 1; attempt <= 2; attempt++) {
      let sent;
      try {
        sent = await send({ model, system, user, maxTokens, effort: request.effort, tool }, request.signal);
      } catch (error) {
        await report(request, zeroUsage(model), "failed", false, error instanceof Error ? error.message : String(error));
        throw error;
      }
      const usage = usageFrom(sent.response, model, sent.latencyMs);
      total = sum(total, usage);

      if (sent.response.stopReason === "refusal") {
        const message = `The model declined to answer "${request.name}"${sent.response.refusalCategory ? ` (category: ${sent.response.refusalCategory})` : ""}`;
        await report(request, usage, "failed", false, message);
        throw new LlmRefusalError(message, sent.response.refusalCategory);
      }
      if (sent.response.stopReason === "max_tokens") {
        const message = `Output for "${request.name}" was cut off at maxTokens (${maxTokens}); thinking tokens count against it. Raise maxTokens (cap ${maxTokensCap}) or split the task.`;
        await report(request, usage, "failed", false, message);
        throw new LlmTruncatedError(message);
      }

      const parsed = sent.response.toolInput === undefined ? undefined : request.schema.safeParse(sent.response.toolInput);
      if (parsed?.success) {
        await report(request, usage, "succeeded", false);
        if (mode === "record")
          fixtures.record(
            request.agent,
            request.name,
            request.input,
            { data: parsed.data, usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } },
            usage.model,
          );
        return { data: parsed.data, usage: total };
      }

      const issues = parsed
        ? parsed.error.issues
        : [{ code: "custom" as const, path: [], message: `You did not call the "${request.name}" tool.` }];
      const summary = formatIssues(issues);
      await report(request, usage, "failed", false, `Schema validation failed:\n${summary}`);
      if (attempt === 2) {
        throw new LlmValidationError(
          `Output for "${request.name}" did not match the schema after one retry:\n${summary}`,
          issues,
          sent.response.toolInput ?? sent.response.text,
        );
      }

      const previous = sent.response.toolInput === undefined ? sent.response.text : JSON.stringify(sent.response.toolInput);
      user = `${request.input}\n\n<validation_feedback>\nYour previous answer was rejected because it did not match the required schema:\n${summary}\n\nYour previous answer was:\n${previous.slice(0, 4_000)}\n\nCall the "${request.name}" tool again with a corrected, complete answer.\n</validation_feedback>`;
    }
    throw new LlmError("unreachable");
  }

  async function mockStructured<S extends z.ZodType>(request: StructuredRequest<S>, model: string): Promise<StructuredResult<z.output<S>>> {
    const entry = fixtures.get(request.agent, request.name, request.input);
    const key = fixtureKey(request.agent, request.name, request.input);
    if (!entry) {
      const message = `Mock mode: no fixture or responder for agent "${request.agent}", call "${request.name}" (key ${key}). Run once with LLM_MODE=record to save it, add a file under ${fixtures.dir}, or register a responder with fixtures.respond().`;
      await report(request, zeroUsage(model), "failed", true, message);
      throw new LlmMockFixtureMissingError(message, key);
    }
    const parsed = request.schema.safeParse(entry.data);
    if (!parsed.success) {
      const summary = formatIssues(parsed.error.issues);
      await report(request, zeroUsage(model), "failed", true, `Fixture ${key} is invalid:\n${summary}`);
      throw new LlmValidationError(
        `Mock fixture ${key} for "${request.name}" does not match the schema:\n${summary}`,
        parsed.error.issues,
        entry.data,
      );
    }
    const usage = mockUsage(model, request.system.length + request.input.length, JSON.stringify(entry.data), entry.usage);
    await report(request, usage, "succeeded", true);
    return { data: parsed.data, usage };
  }

  // ---- free text ----

  async function generateText(request: TextRequest): Promise<TextResult> {
    const named = { ...request, name: request.name ?? "text" };
    const { model, maxTokens } = checkRequest(named);

    if (mode === "mock") {
      const entry = fixtures.get(named.agent, named.name, named.input);
      // Prose has no schema to check, so unlike structured output an unknown prompt gets a clearly marked placeholder.
      const text =
        typeof entry?.data === "string"
          ? entry.data
          : `[mock] ${named.agent}/${named.name} ${fixtureKey(named.agent, named.name, named.input)}`;
      const usage = mockUsage(model, named.system.length + named.input.length, text, entry?.usage);
      await report(named, usage, "succeeded", true);
      return { text, truncated: false, usage };
    }

    let sent;
    try {
      sent = await send({ model, system: named.system, user: named.input, maxTokens, effort: named.effort }, named.signal);
    } catch (error) {
      await report(named, zeroUsage(model), "failed", false, error instanceof Error ? error.message : String(error));
      throw error;
    }
    const usage = usageFrom(sent.response, model, sent.latencyMs);
    if (sent.response.stopReason === "refusal") {
      const message = `The model declined to answer "${named.name}"${sent.response.refusalCategory ? ` (category: ${sent.response.refusalCategory})` : ""}`;
      await report(named, usage, "failed", false, message);
      throw new LlmRefusalError(message, sent.response.refusalCategory);
    }
    const truncated = sent.response.stopReason === "max_tokens";
    if (!sent.response.text && !truncated) {
      const message = `The model returned no text for "${named.name}"`;
      await report(named, usage, "failed", false, message);
      throw new LlmError(message);
    }
    await report(named, usage, "succeeded", false);
    if (mode === "record")
      fixtures.record(
        named.agent,
        named.name,
        named.input,
        { data: sent.response.text, usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } },
        usage.model,
      );
    return { text: sent.response.text, truncated, usage };
  }

  return { mode, provider, fixtures, generateStructured, generateText };
}

// ---- process-wide default, so agents can just `import { generateStructured }` ----

let current: Gateway | undefined;

/** The gateway configured from the environment on first use. */
export function getGateway(): Gateway {
  return (current ??= createGateway());
}

/** Replace the default gateway (the orchestrator installs one with its usage hook; tests install a mock). Pass undefined to reset. */
export function setGateway(gateway: Gateway | undefined): void {
  current = gateway;
}

export function generateStructured<S extends z.ZodType>(request: StructuredRequest<S>): Promise<StructuredResult<z.output<S>>> {
  return getGateway().generateStructured(request);
}

export function generateText(request: TextRequest): Promise<TextResult> {
  return getGateway().generateText(request);
}

/** Converts a usage record into the AgentRun the orchestrator stores. The caller supplies the row id and timestamp. */
export function toAgentRun(record: UsageRecord, row: { id: string; createdAt: string }): AgentRun {
  return AgentRunSchema.parse({
    id: row.id,
    ...(record.initiativeId ? { initiativeId: record.initiativeId } : {}),
    agent: record.agent,
    model: record.model,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    costUsd: record.costUsd,
    latencyMs: record.latencyMs,
    status: record.status,
    ...(record.error ? { error: record.error } : {}),
    createdAt: row.createdAt,
  });
}
