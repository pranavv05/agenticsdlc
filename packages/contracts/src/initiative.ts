import { z } from "zod";
import { AcceptanceCriterionIdSchema, CaseTypeSchema, IdSchema, LIMITS, TimestampSchema } from "./common";
import { StatusSchema } from "./status";

export const AcceptanceCriterionSchema = z.object({
  id: AcceptanceCriterionIdSchema,
  text: z.string().min(1).max(LIMITS.shortText),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

export const InitiativeSchema = z.object({
  id: IdSchema,
  title: z.string().min(1).max(LIMITS.title),
  businessRequirement: z.string().min(1).max(LIMITS.longText),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1),
  caseType: CaseTypeSchema,
  /** Required for Case B (the indexed repo to ground against); absent for Case A. */
  repoId: z.string().min(1).optional(),
  status: StatusSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Initiative = z.infer<typeof InitiativeSchema>;
