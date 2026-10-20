export const MAX_RETRY_AFTER_MS = 60_000;

export interface BackoffOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  /** Returns a number in [0, 1). */
  random: () => number;
  /** A server-requested wait (Retry-After). Honoured up to MAX_RETRY_AFTER_MS. */
  retryAfterMs?: number;
}

/**
 * Exponential backoff with "equal jitter": the n-th retry waits between half and all of min(maxDelay, base * 2^n),
 * so many clients hitting the same 429 do not retry in lockstep. A Retry-After from the server raises the wait, never lowers it.
 */
export function backoffDelay(retryIndex: number, options: BackoffOptions): number {
  const ceiling = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** retryIndex);
  const jittered = ceiling / 2 + (options.random() * ceiling) / 2;
  return options.retryAfterMs === undefined ? jittered : Math.max(jittered, Math.min(options.retryAfterMs, MAX_RETRY_AFTER_MS));
}
