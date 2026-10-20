import { z } from "zod";

/**
 * Workflow statuses (scope §5), reduced to the subset this project implements.
 * The order is the happy path. See docs/DECISIONS.md for what was cut and why.
 */
export const STATUSES = [
  "READY_FOR_SPEC",
  "REQUIREMENT_GENERATING",
  "REQUIREMENT_REVIEW",
  "REQUIREMENT_REVIEWED",
  "SPEC_APPROVED",
  "DESIGN_GENERATING",
  "DESIGN_REVIEW",
  "DESIGN_REVISION_REQUESTED",
  "DESIGN_APPROVED",
  "TASKS_GENERATING",
  "READY_FOR_DEVELOPMENT",
  "IN_DEVELOPMENT",
  "DONE",
] as const;

export const StatusSchema = z.enum(STATUSES);
export type Status = z.infer<typeof StatusSchema>;

export const INITIAL_STATUS: Status = "READY_FOR_SPEC";
export const TERMINAL_STATUS: Status = "DONE";
