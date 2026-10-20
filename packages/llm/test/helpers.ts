import { z } from "zod";
import {
  createGateway,
  type Gateway,
  type GatewayOptions,
  type LlmRequest,
  type LlmResponse,
  type Transport,
  type UsageRecord,
} from "../src";

export const Answer = z.object({ title: z.string().min(3), count: z.number().int().min(0) });
export type Answer = z.infer<typeof Answer>;

export function reply(overrides: Partial<LlmResponse> & { toolInput?: unknown } = {}): LlmResponse {
  return {
    text: "",
    toolInput: undefined,
    stopReason: "tool_use",
    refusalCategory: null,
    model: "claude-haiku-5-5",
    usage: { inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ...overrides,
  };
}

export type Step = LlmResponse | Error | ((request: LlmRequest) => LlmResponse | Promise<LlmResponse>);

/** A transport that plays back a script and records every request it receives. */
export class ScriptedTransport implements Transport {
  readonly name = "scripted";
  readonly calls: LlmRequest[] = [];
  constructor(private readonly steps: Step[]) {}

  async send(request: LlmRequest): Promise<LlmResponse> {
    this.calls.push(request);
    const step = this.steps[Math.min(this.calls.length - 1, this.steps.length - 1)];
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step(request) : step;
  }
}

export interface Harness {
  gateway: Gateway;
  transport: ScriptedTransport;
  usage: UsageRecord[];
  sleeps: number[];
}

/** A live-mode gateway wired to a scripted transport, with deterministic jitter, latency and sleeping. */
export function harness(steps: Step[], options: GatewayOptions = {}): Harness {
  const transport = new ScriptedTransport(steps);
  const usage: UsageRecord[] = [];
  const sleeps: number[] = [];
  let now = 0;
  const gateway = createGateway({
    mode: "live",
    transport,
    env: {},
    random: () => 0.5,
    clock: () => (now += 10),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    onUsage: (record) => {
      usage.push(record);
    },
    ...options,
  });
  return { gateway, transport, usage, sleeps };
}

export const baseRequest = {
  agent: "requirement" as const,
  name: "answer",
  schema: Answer,
  system: "You are a test agent.",
  input: "Produce an answer.",
};
