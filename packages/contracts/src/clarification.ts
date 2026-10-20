import { z } from "zod";
import { IdSchema, LIMITS, TimestampSchema } from "./common";

export const ClarificationStageSchema = z.enum(["requirements", "design"]);
export type ClarificationStage = z.infer<typeof ClarificationStageSchema>;

export const ClarificationQuestionSchema = z.object({
  id: IdSchema,
  initiativeId: IdSchema,
  stage: ClarificationStageSchema.describe("Which agent raised the question."),
  question: z.string().min(1).max(LIMITS.shortText),
  answer: z.string().min(1).max(LIMITS.longText).nullable().describe("Null until a human answers."),
  createdAt: TimestampSchema,
  answeredAt: TimestampSchema.nullable().describe("Null until a human answers."),
});
export type ClarificationQuestion = z.infer<typeof ClarificationQuestionSchema>;
