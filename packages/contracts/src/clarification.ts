import { z } from "zod";
import { IdSchema, LIMITS, TimestampSchema } from "./common";

export const ClarificationStageSchema = z.enum(["requirements", "design"]);
export type ClarificationStage = z.infer<typeof ClarificationStageSchema>;

export const ClarificationQuestionSchema = z.object({
  id: IdSchema,
  initiativeId: IdSchema,
  stage: ClarificationStageSchema,
  question: z.string().min(1).max(LIMITS.shortText),
  /** Null until a human answers. */
  answer: z.string().min(1).max(LIMITS.longText).nullable(),
  createdAt: TimestampSchema,
  answeredAt: TimestampSchema.nullable(),
});
export type ClarificationQuestion = z.infer<typeof ClarificationQuestionSchema>;
