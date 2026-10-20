import { z } from "zod";
import { IdSchema, LIMITS, TimestampSchema } from "./common";

export const AGENTS = ["requirement", "requirement_critic", "design", "design_critic", "task", "context"] as const;
export const AgentNameSchema = z.enum(AGENTS);
export type AgentName = z.infer<typeof AgentNameSchema>;

export const AgentRunStatusSchema = z.enum(["succeeded", "failed"]);
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;

export const AgentRunSchema = z.object({
  id: IdSchema,
  initiativeId: IdSchema.optional().describe("Absent for runs not tied to an initiative, such as indexing a repo."),
  agent: AgentNameSchema,
  model: z.string().min(1).describe("Model id the call was made with."),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  costUsd: z.number().min(0).describe("Estimated cost in US dollars, from the versioned price table."),
  latencyMs: z.number().int().min(0),
  status: AgentRunStatusSchema.describe("The row is written after the call finishes, so there is no running state."),
  error: z.string().max(LIMITS.shortText).optional().describe("Present when status is failed."),
  createdAt: TimestampSchema,
});
export type AgentRun = z.infer<typeof AgentRunSchema>;
