import Anthropic from "@anthropic-ai/sdk";
import { TransportError, isRetryableStatus, parseRetryAfter } from "./errors";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** A provider-neutral request. The gateway builds it; a Transport turns it into one HTTP call. */
export interface LlmRequest {
  model: string;
  system: string;
  /** The single user message. */
  user: string;
  maxTokens: number;
  effort?: Effort;
  /** When set, the model must answer by calling this tool. `forced` pins tool_choice to it (only on models that allow that). */
  tool?: { name: string; description: string; inputSchema: Record<string, unknown>; forced: boolean };
  signal?: AbortSignal;
}

export interface LlmResponse {
  /** All text blocks, concatenated. */
  text: string;
  /** Input of the first tool_use block for the requested tool, or undefined. */
  toolInput: unknown;
  stopReason: string | null;
  /** Present when stopReason is "refusal". */
  refusalCategory: string | null;
  /** The model that actually served the request. */
  model: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
}

/** One HTTP call to the model API. No retries here: the gateway owns retry, backoff and timeouts. */
export interface Transport {
  readonly name: string;
  send(request: LlmRequest): Promise<LlmResponse>;
}

// ---- shared parsing of a Messages API body (what the Anthropic SDK returns) ----

interface MessagesBody {
  model?: string;
  content?: { type: string; text?: string; name?: string; input?: unknown }[];
  stop_reason?: string | null;
  stop_details?: { category?: string | null } | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
}

export function parseMessagesBody(body: MessagesBody, request: LlmRequest): LlmResponse {
  const blocks = body.content ?? [];
  const toolBlock = request.tool ? blocks.find((b) => b.type === "tool_use" && b.name === request.tool?.name) : undefined;
  return {
    text: blocks
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
      .trim(),
    toolInput: toolBlock?.input,
    stopReason: body.stop_reason ?? null,
    refusalCategory: body.stop_details?.category ?? null,
    model: body.model ?? request.model,
    usage: {
      inputTokens: body.usage?.input_tokens ?? 0,
      outputTokens: body.usage?.output_tokens ?? 0,
      cacheReadTokens: body.usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: body.usage?.cache_creation_input_tokens ?? 0,
    },
  };
}

/** The Messages API request fields built from a neutral request. */
function messagesParams(request: LlmRequest) {
  return {
    max_tokens: request.maxTokens,
    system: request.system,
    messages: [{ role: "user" as const, content: request.user }],
    ...(request.effort ? { output_config: { effort: request.effort } } : {}),
    ...(request.tool
      ? {
          tools: [{ name: request.tool.name, description: request.tool.description, input_schema: request.tool.inputSchema }],
          tool_choice: request.tool.forced ? { type: "tool" as const, name: request.tool.name } : { type: "auto" as const },
        }
      : {}),
  };
}

// ---- Anthropic SDK ----

/** The slice of the SDK client the gateway uses; tests pass a fake. */
export interface AnthropicLike {
  messages: { create(params: never, options?: { signal?: AbortSignal; maxRetries?: number }): Promise<unknown> };
}

export function createAnthropicTransport(client?: AnthropicLike): Transport {
  // maxRetries 0: the gateway does its own retry with backoff, so the SDK must not retry underneath it.
  const sdk: AnthropicLike = client ?? (new Anthropic({ maxRetries: 0 }) as unknown as AnthropicLike);
  return {
    name: "anthropic",
    async send(request) {
      try {
        const body = (await sdk.messages.create({ model: request.model, ...messagesParams(request) } as never, {
          signal: request.signal,
          maxRetries: 0,
        })) as MessagesBody;
        return parseMessagesBody(body, request);
      } catch (error) {
        throw toTransportError(error);
      }
    },
  };
}

function toTransportError(error: unknown): TransportError {
  if (error instanceof TransportError) return error;
  if (error instanceof Anthropic.APIError && error.status !== undefined) {
    return new TransportError(
      error.message,
      error.status,
      isRetryableStatus(error.status),
      parseRetryAfter(error.headers?.get("retry-after")),
      { cause: error },
    );
  }
  // The SDK refusing to start (for example no credentials could be resolved) will not fix itself: do not retry.
  if (error instanceof Anthropic.AnthropicError && !(error instanceof Anthropic.APIError)) {
    return new TransportError(error.message, undefined, false, undefined, { cause: error });
  }
  // Connection resets, DNS failures, aborts: no HTTP status, worth another try.
  const message = error instanceof Error ? error.message : String(error);
  return new TransportError(message, undefined, true, undefined, { cause: error });
}
