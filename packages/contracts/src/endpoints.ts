import { z } from "zod";
import {
  ApproveRequestSchema,
  ArtifactParamsSchema,
  ArtifactQuerySchema,
  ArtifactsResponseSchema,
  CreateInitiativeRequestSchema,
  DecisionResponseSchema,
  ERROR_HTTP_STATUS,
  HealthResponseSchema,
  IdParamsSchema,
  IndexRepoRequestSchema,
  ListApprovalsResponseSchema,
  ListInitiativesQuerySchema,
  ListInitiativesResponseSchema,
  ListQuestionsQuerySchema,
  ListQuestionsResponseSchema,
  ListReposResponseSchema,
  ListRunsResponseSchema,
  RegisterRepoRequestSchema,
  RepoIdParamsSchema,
  RequestChangesRequestSchema,
  SubmitAnswersRequestSchema,
  SubmitAnswersResponseSchema,
  type ErrorCode,
} from "./api-schemas";
import { ArtifactSchema } from "./artifacts";
import { InitiativeSchema } from "./initiative";
import { RepoSchema } from "./repo";
import {
  EXAMPLE_IDS,
  EXAMPLE_REPO_ID,
  exampleApprovalChanges,
  exampleApprovalRequirements,
  exampleDesign,
  exampleInitiative,
  exampleQuestions,
  exampleRepo,
  exampleRequirements,
  exampleRuns,
  exampleTasks,
} from "./examples";

export type HttpMethod = "GET" | "POST";

export interface InputDef {
  schema: z.ZodType;
  example: unknown;
}

export interface ResponseDef {
  status: number;
  description: string;
  schema: z.ZodType;
  example: unknown;
}

export interface ErrorDef {
  status: number;
  code: ErrorCode;
  when: string;
}

export interface EndpointDef {
  id: string;
  method: HttpMethod;
  /** Express/Hono style, for example `/api/initiatives/:id`. */
  path: string;
  tag: string;
  summary: string;
  /** Markdown. Say exactly which status transitions the call causes. */
  description: string;
  params?: InputDef;
  query?: InputDef;
  body?: InputDef;
  /** Success responses. */
  responses: ResponseDef[];
  /** Error responses specific to this endpoint (every endpoint can also return 500 `internal_error`). */
  errors: ErrorDef[];
}

/** Request inputs are typed with `z.input` so examples show what a client actually sends. */
const input = <S extends z.ZodType>(schema: S, example: z.input<S>): InputDef => ({ schema, example });

/** Responses are typed with `z.output` so examples show what the server actually returns. */
const response = <S extends z.ZodType>(status: number, description: string, schema: S, example: z.output<S>): ResponseDef => ({
  status,
  description,
  schema,
  example,
});

const error = (code: ErrorCode, when: string): ErrorDef => ({ status: ERROR_HTTP_STATUS[code], code, when });

const initiativeParams = input(IdParamsSchema, { id: EXAMPLE_IDS.initiative });
const badBody = error(
  "validation_error",
  "The request body, query or path parameter does not match the schema. `details` lists the Zod issues.",
);
const badParams = error("validation_error", "The path parameter is not a valid id.");
const noInitiative = error("not_found", "No initiative with this id.");
const noRepo = error("not_found", "No repo with this id.");

const definitions = {
  health: {
    method: "GET",
    path: "/api/health",
    tag: "System",
    summary: "Health check",
    description: "Returns `ok` when the server is up, and whether the LLM gateway is in mock or live mode.",
    responses: [response(200, "The server is up.", HealthResponseSchema, { status: "ok", llmMode: "mock" })],
    errors: [],
  },

  createInitiative: {
    method: "POST",
    path: "/api/initiatives",
    tag: "Initiatives",
    summary: "Create an initiative",
    description: [
      "Creates the initiative (status `READY_FOR_SPEC`) and starts the workflow in the same call, so the response already shows `REQUIREMENT_GENERATING`.",
      "The Requirement Agent runs in the background: poll `GET /api/initiatives/:id` until the status leaves `REQUIREMENT_GENERATING`.",
      "",
      "- Case `A` (no repo context): `repoId` is optional and ignored by the agents.",
      "- Case `B` (existing repo): `repoId` is required and the repo must have status `indexed`.",
      "- The server assigns acceptance criterion ids `AC-1`, `AC-2`, ... in the order given.",
    ].join("\n"),
    body: input(CreateInitiativeRequestSchema, {
      title: "Invoice CSV export",
      businessRequirement: "Finance needs to export a month of invoices as a CSV file so they can reconcile them in a spreadsheet.",
      acceptanceCriteria: [
        "A CSV with one row per invoice downloads in under 5 seconds for a month of data.",
        "Only users with the finance role can export.",
      ],
      caseType: "B",
      repoId: EXAMPLE_REPO_ID,
    }),
    responses: [
      response(
        201,
        "The initiative was created and the Requirement Agent has started.",
        InitiativeSchema,
        exampleInitiative("REQUIREMENT_GENERATING"),
      ),
    ],
    errors: [
      badBody,
      error("validation_error", "`repoId` does not match any registered repo, or `caseType` is `B` and `repoId` is missing."),
      error("conflict", "The repo exists but is not `indexed` yet."),
    ],
  },

  listInitiatives: {
    method: "GET",
    path: "/api/initiatives",
    tag: "Initiatives",
    summary: "List initiatives",
    description: "Newest first. All filters are optional and combine with AND.",
    query: input(ListInitiativesQuerySchema, { status: "REQUIREMENT_REVIEW", limit: 20 }),
    responses: [response(200, "A page of initiatives.", ListInitiativesResponseSchema, { items: [exampleInitiative()], total: 1 })],
    errors: [badBody],
  },

  getInitiative: {
    method: "GET",
    path: "/api/initiatives/:id",
    tag: "Initiatives",
    summary: "Get an initiative",
    description: "Use this to poll while the status is `*_GENERATING`.",
    params: initiativeParams,
    responses: [response(200, "The initiative.", InitiativeSchema, exampleInitiative())],
    errors: [badParams, noInitiative],
  },

  getArtifacts: {
    method: "GET",
    path: "/api/initiatives/:id/artifacts",
    tag: "Artifacts",
    summary: "Get the latest requirements, design and tasks",
    description:
      "Returns the latest version of each artifact. An artifact that has not been generated yet is `null`. `markdown` is the rendered file; `content` is the same data as structured JSON.",
    params: initiativeParams,
    responses: [
      response(200, "The latest version of each artifact.", ArtifactsResponseSchema, {
        requirements: exampleRequirements,
        design: exampleDesign,
        tasks: exampleTasks,
      }),
    ],
    errors: [badParams, noInitiative],
  },

  getArtifact: {
    method: "GET",
    path: "/api/initiatives/:id/artifacts/:kind",
    tag: "Artifacts",
    summary: "Get one artifact, optionally an older version",
    description: "`kind` is `requirements`, `design` or `tasks`. Without `version` the latest version is returned.",
    params: input(ArtifactParamsSchema, { id: EXAMPLE_IDS.initiative, kind: "design" }),
    query: input(ArtifactQuerySchema, { version: 1 }),
    responses: [response(200, "The artifact. Its shape depends on `kind`.", ArtifactSchema, exampleDesign)],
    errors: [badParams, noInitiative, error("not_found", "The artifact has not been generated yet, or that version does not exist.")],
  },

  listQuestions: {
    method: "GET",
    path: "/api/initiatives/:id/questions",
    tag: "Clarification",
    summary: "List clarification questions",
    description: "All questions raised by the agents for this initiative, oldest first. Filter with `stage` and `answered`.",
    params: initiativeParams,
    query: input(ListQuestionsQuerySchema, { stage: "requirements", answered: "false" }),
    responses: [response(200, "The questions.", ListQuestionsResponseSchema, { items: exampleQuestions })],
    errors: [badParams, noInitiative],
  },

  submitAnswers: {
    method: "POST",
    path: "/api/initiatives/:id/answers",
    tag: "Clarification",
    summary: "Answer clarification questions",
    description: [
      "Stores the answers.",
      "",
      "- Requirements stage (status `REQUIREMENT_REVIEW`): every open requirements question must be answered, in this request or an earlier one. The initiative then moves to `REQUIREMENT_GENERATING` and the Requirement Agent re-runs with the answers.",
      "- Design stage (status `DESIGN_REVIEW`): the answers are stored and used by the Design Agent the next time Architecture requests changes. The status does not change.",
      "- A question that already has an answer cannot be answered again.",
    ].join("\n"),
    params: initiativeParams,
    body: input(SubmitAnswersRequestSchema, {
      answers: [{ questionId: EXAMPLE_IDS.questionOpen, answer: "No, only invoices that are fully settled." }],
    }),
    responses: [
      response(200, "The answers were stored.", SubmitAnswersResponseSchema, {
        initiative: exampleInitiative("REQUIREMENT_GENERATING"),
        questions: [
          { ...exampleQuestions[1], answer: "No, only invoices that are fully settled.", answeredAt: "2026-10-21T10:10:00.000Z" },
        ],
      }),
    ],
    errors: [
      badBody,
      error("validation_error", "A `questionId` does not belong to this initiative, or open requirements questions remain unanswered."),
      noInitiative,
      error("invalid_transition", "The initiative is not waiting for answers (status is not `REQUIREMENT_REVIEW` or `DESIGN_REVIEW`)."),
      error("conflict", "One of the questions already has an answer."),
    ],
  },

  approve: {
    method: "POST",
    path: "/api/initiatives/:id/approve",
    tag: "Approvals",
    summary: "Approve the requirements or the design",
    description: [
      "Records an `approved` decision for the artifact version currently under review.",
      "",
      '- `stage: "requirements"` is decided by Product and needs status `REQUIREMENT_REVIEWED`. The initiative moves to `SPEC_APPROVED`, then the orchestrator starts the Design Agent (`DESIGN_GENERATING`).',
      '- `stage: "design"` is decided by Architecture and needs status `DESIGN_REVIEW`. The initiative moves to `DESIGN_APPROVED`, then the orchestrator starts the Task Agent (`TASKS_GENERATING`).',
      "",
      "The response shows the status after these automatic steps, so it is usually already `DESIGN_GENERATING` or `TASKS_GENERATING`.",
      "Agents never approve: only this call, made by a person, moves an initiative past a gate.",
    ].join("\n"),
    params: initiativeParams,
    body: input(ApproveRequestSchema, { stage: "requirements", reviewer: "priya.product", comment: "Looks complete." }),
    responses: [
      response(200, "The approval was recorded.", DecisionResponseSchema, {
        initiative: exampleInitiative("DESIGN_GENERATING"),
        approval: exampleApprovalRequirements,
      }),
    ],
    errors: [
      badBody,
      noInitiative,
      error("invalid_transition", "The initiative is not waiting for a decision at this `stage` (wrong status)."),
    ],
  },

  requestChanges: {
    method: "POST",
    path: "/api/initiatives/:id/request-changes",
    tag: "Approvals",
    summary: "Request changes to the requirements or the design",
    description: [
      "Records a `changes_requested` decision. `comment` is required and is passed to the agent as feedback.",
      "",
      '- `stage: "requirements"` needs status `REQUIREMENT_REVIEWED`. The initiative moves back to `REQUIREMENT_GENERATING`.',
      '- `stage: "design"` needs status `DESIGN_REVIEW`. The initiative moves to `DESIGN_REVISION_REQUESTED`, then the orchestrator re-runs the Design Agent (`DESIGN_GENERATING`).',
      "",
      "Re-analysis only ever happens through an explicit call like this one, never because of a comment.",
    ].join("\n"),
    params: initiativeParams,
    body: input(RequestChangesRequestSchema, {
      stage: "design",
      reviewer: "alex.architect",
      comment: "Stream the rows instead of loading the whole month into memory.",
    }),
    responses: [
      response(200, "The decision was recorded.", DecisionResponseSchema, {
        initiative: exampleInitiative("DESIGN_GENERATING"),
        approval: exampleApprovalChanges,
      }),
    ],
    errors: [
      badBody,
      noInitiative,
      error("invalid_transition", "The initiative is not waiting for a decision at this `stage` (wrong status)."),
    ],
  },

  listApprovals: {
    method: "GET",
    path: "/api/initiatives/:id/approvals",
    tag: "Approvals",
    summary: "List the decisions recorded for an initiative",
    description: "Oldest first. Includes approvals and change requests for both stages.",
    params: initiativeParams,
    responses: [
      response(200, "The recorded decisions.", ListApprovalsResponseSchema, {
        items: [exampleApprovalRequirements, exampleApprovalChanges],
      }),
    ],
    errors: [badParams, noInitiative],
  },

  listRuns: {
    method: "GET",
    path: "/api/initiatives/:id/runs",
    tag: "Agent runs",
    summary: "List agent runs and their cost",
    description: "One row per model call (including critics), oldest first, with token and cost totals for the initiative.",
    params: initiativeParams,
    responses: [
      response(200, "The runs and their totals.", ListRunsResponseSchema, {
        items: exampleRuns,
        totals: { inputTokens: 7300, outputTokens: 1700, costUsd: 0.0474 },
      }),
    ],
    errors: [badParams, noInitiative],
  },

  registerRepo: {
    method: "POST",
    path: "/api/repos",
    tag: "Repos",
    summary: "Register a repo and profile it",
    description: [
      "Registers a repo (cloning it first when `source.type` is `url`) and starts the profiler in the background. The response has status `profiling`; poll `GET /api/repos/:id` until it is `profiled`.",
      "The profile recommends a strategy (`full` or `claude-md-only`, scope section 6.1). Indexing is a separate call.",
    ].join("\n"),
    body: input(RegisterRepoRequestSchema, {
      name: "billing-service",
      source: { type: "url", value: "https://github.com/example-org/billing-service.git" },
    }),
    responses: [response(202, "The repo was registered and profiling has started.", RepoSchema, exampleRepo("profiling"))],
    errors: [badBody, error("conflict", "A repo with the same id (slug of the name) is already registered.")],
  },

  listRepos: {
    method: "GET",
    path: "/api/repos",
    tag: "Repos",
    summary: "List registered repos",
    description: "Newest first.",
    responses: [response(200, "The registered repos.", ListReposResponseSchema, { items: [exampleRepo()] })],
    errors: [],
  },

  getRepo: {
    method: "GET",
    path: "/api/repos/:id",
    tag: "Repos",
    summary: "Get a repo",
    description: "Use this to poll while the status is `profiling` or `indexing`.",
    params: input(RepoIdParamsSchema, { id: EXAMPLE_REPO_ID }),
    responses: [response(200, "The repo, with its profile and index state.", RepoSchema, exampleRepo())],
    errors: [badParams, noRepo],
  },

  indexRepo: {
    method: "POST",
    path: "/api/repos/:id/index",
    tag: "Repos",
    summary: "Index a repo",
    description: [
      "Starts indexing in the background and returns status `indexing`; poll `GET /api/repos/:id` until it is `indexed`.",
      "`strategy` defaults to the profile's recommendation. Allowed when the status is `profiled`, `indexed` or `failed`; a repo whose profiling failed is profiled again first. Re-indexing an `indexed` repo refreshes it (a repo registered by URL is pulled first); the previous index stays in place until the new one succeeds.",
    ].join("\n"),
    params: input(RepoIdParamsSchema, { id: EXAMPLE_REPO_ID }),
    body: input(IndexRepoRequestSchema, { strategy: "full" }),
    responses: [response(202, "Indexing has started.", RepoSchema, exampleRepo("indexing"))],
    errors: [badBody, noRepo, error("conflict", "The repo is still being profiled or is already being indexed.")],
  },
} satisfies Record<string, Omit<EndpointDef, "id">>;

type Definitions = typeof definitions;

/** Every REST endpoint, keyed by id. Hono routes, the UI client and the mock API are all built from this. */
export const API = Object.fromEntries(Object.entries(definitions).map(([id, def]) => [id, { id, ...def }])) as unknown as {
  [K in keyof Definitions]: EndpointDef & { id: K; method: Definitions[K]["method"] };
};

export type EndpointId = keyof typeof API;

export const ENDPOINTS: readonly EndpointDef[] = Object.values(API);
