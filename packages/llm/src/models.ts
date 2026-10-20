import { LlmConfigError } from "./errors";
import { normalizeModelId } from "./prices";

/** Used when NODE_ENV is "production" and nothing else is configured. */
export const DEFAULT_MODEL = "claude-sonnet-5-5";
/** Used everywhere else (development, tests, CI): cheapest current model. Override with LLM_MODEL for real evaluation runs. */
export const DEV_MODEL = "claude-haiku-5-5";

/**
 * Models that still accept `tool_choice: { type: "tool", name }`.
 * Claude Fable 5.1, Mythos 5.1, Opus 5.5 and Sonnet 5.5 return HTTP 400 for forced tool use, and models that think by default
 * cannot combine thinking with a forced tool call. Every model not listed here is driven with `tool_choice: auto`,
 * an explicit instruction to call the tool, and Zod validation, which works on every model.
 */
const FORCED_TOOL_CHOICE_MODELS = new Set([
  "claude-haiku-4-5",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
]);

export function supportsForcedToolChoice(model: string): boolean {
  return FORCED_TOOL_CHOICE_MODELS.has(normalizeModelId(model));
}

export interface ModelEnv {
  LLM_MODEL?: string;
  /** Legacy names from the prototype; still honoured. */
  SDD_MODEL?: string;
  CLAUDE_MODEL?: string;
  NODE_ENV?: string;
}

/**
 * Picks the model for a call: the call's own `model`, else LLM_MODEL (SDD_MODEL / CLAUDE_MODEL for compatibility),
 * else DEFAULT_MODEL in production and the cheaper DEV_MODEL everywhere else.
 */
export function resolveModel(
  requested: string | undefined,
  env: ModelEnv = process.env,
  provider: "anthropic" | "bedrock" = "anthropic",
): string {
  const configured = requested?.trim() || env.LLM_MODEL?.trim() || env.SDD_MODEL?.trim() || env.CLAUDE_MODEL?.trim();
  if (configured) return configured;
  // Bedrock model ids and inference profiles differ per account and region, so there is no safe default.
  if (provider === "bedrock") throw new LlmConfigError("LLM_MODEL (a Bedrock model or inference-profile id) is not set");
  return env.NODE_ENV === "production" ? DEFAULT_MODEL : DEV_MODEL;
}
