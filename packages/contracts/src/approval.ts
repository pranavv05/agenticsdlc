import { z } from "zod";
import { IdSchema, LIMITS, TimestampSchema } from "./common";

export const ApprovalStageSchema = z.enum(["requirements", "design"]);
export type ApprovalStage = z.infer<typeof ApprovalStageSchema>;

export const ApprovalDecisionSchema = z.enum(["approved", "changes_requested"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ApprovalSchema = z.object({
  id: IdSchema,
  initiativeId: IdSchema,
  stage: ApprovalStageSchema.describe('"requirements" is decided by Product, "design" by Architecture.'),
  decision: ApprovalDecisionSchema,
  reviewer: z.string().min(1).max(LIMITS.title).describe("Who decided. A free-form identifier until real auth exists."),
  comment: z.string().max(LIMITS.longText).describe("Empty string when the reviewer gave no comment."),
  artifactVersion: z.number().int().min(1).describe("The artifact version the decision applies to."),
  createdAt: TimestampSchema,
});
export type Approval = z.infer<typeof ApprovalSchema>;
