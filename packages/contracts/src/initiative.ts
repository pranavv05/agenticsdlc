import { z } from "zod";
import { AcceptanceCriterionIdSchema, CaseTypeSchema, IdSchema, LIMITS, TimestampSchema } from "./common";
import { StatusSchema } from "./status";

export const AcceptanceCriterionSchema = z.object({
  id: AcceptanceCriterionIdSchema.describe("Reference id, unique within the initiative. Tasks and requirements cite it."),
  text: z.string().min(1).max(LIMITS.shortText).describe("The criterion, in plain language."),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

export const InitiativeSchema = z.object({
  id: IdSchema,
  title: z.string().min(1).max(LIMITS.title).describe("Short name shown in lists."),
  businessRequirement: z
    .string()
    .min(1)
    .max(LIMITS.longText)
    .describe("The source requirement, as written by Product. Treated as untrusted text by the agents."),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1),
  caseType: CaseTypeSchema.describe('"A" builds something new with no repo context; "B" adds a feature to an existing, indexed repo.'),
  repoId: z.string().min(1).optional().describe("Id of the registered repo. Always present for Case B; usually absent for Case A."),
  status: StatusSchema.describe("Current workflow status. Only the orchestrator changes it."),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Initiative = z.infer<typeof InitiativeSchema>;
