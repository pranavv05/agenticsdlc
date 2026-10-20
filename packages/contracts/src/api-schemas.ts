import { z } from "zod";
import { AgentRunSchema } from "./agent-run";
import { ApprovalSchema, ApprovalStageSchema } from "./approval";
import { DesignSchema, RequirementSchema, TasksArtifactSchema } from "./artifacts";
import { ClarificationQuestionSchema, ClarificationStageSchema } from "./clarification";
import { CaseTypeSchema, IdSchema, LIMITS } from "./common";
import { InitiativeSchema } from "./initiative";
import { IndexStrategySchema, RepoIdSchema, RepoSchema, RepoSourceSchema } from "./repo";
import { StatusSchema } from "./status";

// ---- errors ----

export const ERROR_CODES = ["validation_error", "not_found", "invalid_transition", "conflict", "internal_error"] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/** HTTP status each error code is returned with. */
export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  validation_error: 400,
  not_found: 404,
  invalid_transition: 409,
  conflict: 409,
  internal_error: 500,
};

/** One Zod issue, as returned in `error.details` for validation errors. */
export const ValidationIssueSchema = z.object({
  code: z.string().describe("Zod issue code, for example `too_small` or `invalid_type`."),
  path: z.array(z.union([z.string(), z.number()])).describe('Where the problem is, for example `["acceptanceCriteria", 0]`.'),
  message: z.string(),
});
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string().describe("Human-readable. Safe to show in the UI."),
    details: z.array(ValidationIssueSchema).optional().describe("Only for `validation_error`: the Zod issues."),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

// ---- shared ----

export const IdParamsSchema = z.object({ id: IdSchema.describe("Initiative id.") });
export const RepoIdParamsSchema = z.object({ id: RepoIdSchema.describe("Repo id (slug).") });

const items = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item) });

// ---- health ----

export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  llmMode: z.enum(["mock", "live"]).describe("`mock` serves recorded fixtures (LLM_MODE=mock); `live` calls the model."),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

// ---- initiatives ----

export const CreateInitiativeRequestSchema = z
  .object({
    title: z.string().min(1).max(LIMITS.title),
    businessRequirement: z.string().min(1).max(LIMITS.longText),
    acceptanceCriteria: z
      .array(z.string().min(1).max(LIMITS.shortText))
      .min(1)
      .describe("Plain strings. The server assigns the ids AC-1, AC-2, ... in order."),
    caseType: CaseTypeSchema,
    repoId: RepoIdSchema.optional().describe("Required when caseType is `B`. Must be a registered repo with status `indexed`."),
  })
  .refine((v) => v.caseType === "A" || v.repoId !== undefined, { path: ["repoId"], message: "repoId is required for Case B" });
export type CreateInitiativeRequest = z.infer<typeof CreateInitiativeRequestSchema>;

export const ListInitiativesQuerySchema = z.object({
  status: StatusSchema.optional(),
  caseType: CaseTypeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50).describe("Page size. Defaults to 50."),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListInitiativesQuery = z.infer<typeof ListInitiativesQuerySchema>;

export const ListInitiativesResponseSchema = z.object({
  items: z.array(InitiativeSchema).describe("Newest first."),
  total: z.number().int().min(0).describe("Number of initiatives matching the filters, ignoring limit and offset."),
});
export type ListInitiativesResponse = z.infer<typeof ListInitiativesResponseSchema>;

// ---- artifacts ----

export const ArtifactsResponseSchema = z.object({
  requirements: RequirementSchema.nullable().describe("Latest version, or null if not generated yet."),
  design: DesignSchema.nullable().describe("Latest version, or null if not generated yet."),
  tasks: TasksArtifactSchema.nullable().describe("Latest version, or null if not generated yet."),
});
export type ArtifactsResponse = z.infer<typeof ArtifactsResponseSchema>;

export const ArtifactParamsSchema = z.object({
  id: IdSchema.describe("Initiative id."),
  kind: z.enum(["requirements", "design", "tasks"]),
});

export const ArtifactQuerySchema = z.object({
  version: z.coerce.number().int().min(1).optional().describe("A specific version. Defaults to the latest."),
});

// ---- clarification questions ----

export const ListQuestionsQuerySchema = z.object({
  stage: ClarificationStageSchema.optional(),
  answered: z.enum(["true", "false"]).optional().describe("Filter to answered (`true`) or open (`false`) questions."),
});

export const ListQuestionsResponseSchema = items(ClarificationQuestionSchema);

export const SubmitAnswersRequestSchema = z.object({
  answers: z
    .array(
      z.object({
        questionId: IdSchema,
        answer: z.string().min(1).max(LIMITS.longText),
      }),
    )
    .min(1),
});
export type SubmitAnswersRequest = z.infer<typeof SubmitAnswersRequestSchema>;

export const SubmitAnswersResponseSchema = z.object({
  initiative: InitiativeSchema,
  questions: z.array(ClarificationQuestionSchema).describe("The questions that were answered by this request."),
});
export type SubmitAnswersResponse = z.infer<typeof SubmitAnswersResponseSchema>;

// ---- approvals ----

export const ApproveRequestSchema = z.object({
  stage: ApprovalStageSchema,
  reviewer: z.string().min(1).max(LIMITS.title).describe("Who is approving. Free-form until real auth exists."),
  comment: z.string().max(LIMITS.longText).default("").describe("Optional."),
});
export type ApproveRequest = z.infer<typeof ApproveRequestSchema>;

export const RequestChangesRequestSchema = z.object({
  stage: ApprovalStageSchema,
  reviewer: z.string().min(1).max(LIMITS.title),
  comment: z.string().min(1).max(LIMITS.longText).describe("Required: the agent revises using this feedback."),
});
export type RequestChangesRequest = z.infer<typeof RequestChangesRequestSchema>;

export const DecisionResponseSchema = z.object({
  initiative: InitiativeSchema.describe("The initiative after the status change."),
  approval: ApprovalSchema.describe("The decision that was recorded."),
});
export type DecisionResponse = z.infer<typeof DecisionResponseSchema>;

export const ListApprovalsResponseSchema = items(ApprovalSchema);

// ---- agent runs ----

export const ListRunsResponseSchema = z.object({
  items: z.array(AgentRunSchema).describe("Oldest first."),
  totals: z.object({
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    costUsd: z.number().min(0),
  }),
});
export type ListRunsResponse = z.infer<typeof ListRunsResponseSchema>;

// ---- repos ----

export const RegisterRepoRequestSchema = z.object({
  name: z.string().min(1).max(200).describe("Display name. The repo id is derived from it as a slug."),
  source: RepoSourceSchema,
});
export type RegisterRepoRequest = z.infer<typeof RegisterRepoRequestSchema>;

export const IndexRepoRequestSchema = z.object({
  strategy: IndexStrategySchema.optional().describe("Defaults to the profile's recommendation."),
});
export type IndexRepoRequest = z.infer<typeof IndexRepoRequestSchema>;

export const ListReposResponseSchema = items(RepoSchema);
