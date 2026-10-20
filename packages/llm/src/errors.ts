/** The part of a Zod issue the gateway reports: where, and what is wrong. */
export interface ValidationIssue {
  code?: string;
  path: PropertyKey[];
  message: string;
}

/** Base class: everything the gateway throws extends it, so callers can `instanceof LlmError`. */
export class LlmError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The gateway is misconfigured (missing key, unknown mode, schema that cannot be sent as a tool). Fix the setup, do not retry. */
export class LlmConfigError extends LlmError {}

/** The request itself is not acceptable: oversize input, token cap exceeded, bad name. Nothing was sent to the model. */
export class LlmInputError extends LlmError {}

/** The API kept failing (or failed in a way retrying cannot fix). */
export class LlmApiError extends LlmError {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly attempts: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** The model's output did not match the schema, even after the one allowed retry. */
export class LlmValidationError extends LlmError {
  constructor(
    message: string,
    readonly issues: readonly ValidationIssue[],
    readonly rawOutput: unknown,
  ) {
    super(message);
  }
}

/** The model declined (stop_reason "refusal"). `category` is the API's open-set refusal category when present. */
export class LlmRefusalError extends LlmError {
  constructor(
    message: string,
    readonly category: string | null,
  ) {
    super(message);
  }
}

/** Structured output was cut off at max_tokens, so it cannot be valid. Raise maxTokens (within the cap) or shorten the task. */
export class LlmTruncatedError extends LlmError {}

/** Mock mode has no fixture or responder for this call. Record one (LLM_MODE=record) or register a responder. */
export class LlmMockFixtureMissingError extends LlmError {
  constructor(
    message: string,
    readonly key: string,
  ) {
    super(message);
  }
}

/** Raised by a transport; the gateway decides from `retryable` whether to back off and try again. */
export class TransportError extends LlmError {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** HTTP statuses worth retrying: timeout, conflict, rate limit, server errors and Anthropic's 529 overloaded. */
export function isRetryableStatus(status: number | undefined): boolean {
  return status === undefined || status === 408 || status === 409 || status === 429 || status >= 500;
}

/** Parses a Retry-After header (seconds or an HTTP date) into milliseconds, or undefined. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
