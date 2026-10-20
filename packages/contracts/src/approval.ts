import { z } from "zod";
import { IdSchema, LIMITS, TimestampSchema } from "./common";

export const ApprovalStageSchema = z.enum(["requirements", "design"]);
export type ApprovalStage = z.infer<typeof ApprovalStageSchema>;

export const ApprovalDecisionSchema = z.enum(["approved", "changes_requested"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ApprovalSchema = z.object({
  id: IdSchema,
  initiativeId: IdSchema,
  stage: ApprovalStageSchema,
  decision: ApprovalDecisionSchema,
  /** Who decided. A free-form identifier until real auth exists. */
  reviewer: z.string().min(1).max(LIMITS.title),
  comment: z.string().max(LIMITS.longText),
  /** The artifact version the decision applies to. */
  artifactVersion: z.number().int().min(1),
  createdAt: TimestampSchema,
});
export type Approval = z.infer<typeof ApprovalSchema>;
