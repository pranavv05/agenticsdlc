import type { AgentRun } from "./agent-run";
import type { Approval } from "./approval";
import type { Design, Requirement, TasksArtifact } from "./artifacts";
import type { ClarificationQuestion } from "./clarification";
import type { Initiative } from "./initiative";
import type { Repo } from "./repo";
import type { Status } from "./status";

/**
 * One consistent story used by every example in docs/API.md and by the tests:
 * a Case B initiative, "Invoice CSV export", against the repo `billing-service`.
 * These are typed against the entity types here and parsed against the schemas in the tests,
 * so an example can never describe a shape the API does not return.
 */

export const EXAMPLE_IDS = {
  initiative: "3f2b8c1e-5a7d-4e29-9c4b-1d6e8f0a2b34",
  questionOpen: "a1c4e7b2-8d3f-4a56-b2c9-5e0f1a7d3c68",
  questionAnswered: "b7d2f9a4-1c6e-4b83-8a15-9f3e2d6c0b47",
  requirements: "c3e5a1d8-7b2f-4c94-a6d0-2f8b4e1c9a53",
  design: "d9f1b3c6-4a8e-4d27-b5e1-7c0a3f9d2e86",
  tasks: "e2a6c8f0-3d5b-4f19-9a7c-6b1d4e8f0c25",
  approvalRequirements: "f4b8d0a2-6c1e-4a35-8d9f-3e7a5c2b1f90",
  approvalDesign: "0a5c9e1b-7d3f-4b48-a2c6-8f4e0d1a6b73",
  runRequirement: "1b6d0f2c-8e4a-4c59-b3d7-9a5f1e2c7d04",
  runRequirementCritic: "3d8f2b4e-0a6c-4e7b-95f9-1c7b3a4e9f26",
  runDesign: "2c7e1a3d-9f5b-4d6a-84e8-0b6a2f3d8e15",
} as const;

export const EXAMPLE_REPO_ID = "billing-service";

const T0 = "2026-10-21T09:30:00.000Z";
const T1 = "2026-10-21T09:31:12.000Z";
const T2 = "2026-10-21T10:05:40.000Z";

export function exampleInitiative(status: Status = "REQUIREMENT_REVIEW"): Initiative {
  return {
    id: EXAMPLE_IDS.initiative,
    title: "Invoice CSV export",
    businessRequirement: "Finance needs to export a month of invoices as a CSV file so they can reconcile them in a spreadsheet.",
    acceptanceCriteria: [
      { id: "AC-1", text: "A CSV with one row per invoice downloads in under 5 seconds for a month of data." },
      { id: "AC-2", text: "Only users with the finance role can export." },
    ],
    caseType: "B",
    repoId: EXAMPLE_REPO_ID,
    status,
    createdAt: T0,
    updatedAt: T1,
  };
}

export const exampleQuestions: ClarificationQuestion[] = [
  {
    id: EXAMPLE_IDS.questionAnswered,
    initiativeId: EXAMPLE_IDS.initiative,
    stage: "requirements",
    question: "Should voided invoices appear in the export?",
    answer: "No, exclude voided invoices.",
    createdAt: T1,
    answeredAt: T2,
  },
  {
    id: EXAMPLE_IDS.questionOpen,
    initiativeId: EXAMPLE_IDS.initiative,
    stage: "requirements",
    question: "InvoiceService retries failed payments three times. Should the export include invoices still being retried?",
    answer: null,
    createdAt: T1,
    answeredAt: null,
  },
];

export const exampleRequirements: Requirement = {
  id: EXAMPLE_IDS.requirements,
  initiativeId: EXAMPLE_IDS.initiative,
  kind: "requirements",
  version: 1,
  markdown: [
    "# Requirements: Invoice CSV export",
    "",
    "Finance can export a month of invoices as a CSV file.",
    "",
    "## Functional requirements",
    "",
    "- **FR-1** The system exports invoices for a chosen month as a CSV file with one row per invoice. (AC-1)",
    "- **FR-2** Only users with the finance role can start an export. (AC-2)",
    "",
    "## Non-functional requirements",
    "",
    "- **NFR-1** A month of invoices exports in under 5 seconds.",
    "",
    "## Out of scope",
    "",
    "- PDF export",
    "",
  ].join("\n"),
  needsHumanMerge: false,
  agentRunId: EXAMPLE_IDS.runRequirement,
  createdAt: T1,
  content: {
    summary: "Finance can export a month of invoices as a CSV file.",
    functionalRequirements: [
      {
        id: "FR-1",
        statement: "The system exports invoices for a chosen month as a CSV file with one row per invoice.",
        acceptanceCriterionRefs: ["AC-1"],
      },
      { id: "FR-2", statement: "Only users with the finance role can start an export.", acceptanceCriterionRefs: ["AC-2"] },
    ],
    nonFunctionalRequirements: [{ id: "NFR-1", statement: "A month of invoices exports in under 5 seconds." }],
    assumptions: ["Invoices are stored in the existing billing database."],
    outOfScope: ["PDF export"],
  },
};

export const exampleDesign: Design = {
  id: EXAMPLE_IDS.design,
  initiativeId: EXAMPLE_IDS.initiative,
  kind: "design",
  version: 1,
  markdown: [
    "# Design: Invoice CSV export",
    "",
    "Add a CSV export route next to the existing invoice controller.",
    "",
    "## DS-1 Export endpoint",
    "",
    "Add `GET /invoices/export` to `src/billing/InvoiceController.java`, guarded by the finance role.",
    "",
    "Files: `src/billing/InvoiceController.java`, `src/billing/InvoiceService.java`",
    "",
  ].join("\n"),
  needsHumanMerge: false,
  agentRunId: EXAMPLE_IDS.runDesign,
  createdAt: T2,
  content: {
    overview: "Add a CSV export route next to the existing invoice controller.",
    sections: [
      {
        id: "DS-1",
        title: "Export endpoint",
        body: "Add `GET /invoices/export` to the invoice controller, guarded by the finance role.",
        referencedPaths: ["src/billing/InvoiceController.java", "src/billing/InvoiceService.java"],
      },
    ],
    risks: ["A large month could exceed the 5 second target; stream rows instead of buffering."],
  },
  grounding: {
    checkedPaths: ["src/billing/InvoiceController.java", "src/billing/InvoiceService.java"],
    missingPaths: [],
    checkedAt: T2,
  },
};

export const exampleTasks: TasksArtifact = {
  id: EXAMPLE_IDS.tasks,
  initiativeId: EXAMPLE_IDS.initiative,
  kind: "tasks",
  version: 1,
  markdown: [
    "# Tasks: Invoice CSV export",
    "",
    "- [ ] **T-1** Add export query to InvoiceService (DS-1, AC-1)",
    "- [ ] **T-2** Add `GET /invoices/export` with finance role guard (DS-1, AC-1, AC-2). Depends on T-1.",
    "",
  ].join("\n"),
  needsHumanMerge: false,
  createdAt: "2026-10-21T11:00:00.000Z",
  content: {
    tasks: [
      {
        id: "T-1",
        title: "Add export query to InvoiceService",
        description: "Stream invoices for a month, excluding voided ones, in CSV row order.",
        designSectionRef: "DS-1",
        acceptanceCriterionRefs: ["AC-1"],
        dependsOn: [],
        status: "todo",
      },
      {
        id: "T-2",
        title: "Add GET /invoices/export with finance role guard",
        description: "Expose the export as a CSV download and reject users without the finance role.",
        designSectionRef: "DS-1",
        acceptanceCriterionRefs: ["AC-1", "AC-2"],
        dependsOn: ["T-1"],
        status: "todo",
      },
    ],
  },
};

export const exampleApprovalRequirements: Approval = {
  id: EXAMPLE_IDS.approvalRequirements,
  initiativeId: EXAMPLE_IDS.initiative,
  stage: "requirements",
  decision: "approved",
  reviewer: "priya.product",
  comment: "Looks complete.",
  artifactVersion: 1,
  createdAt: T2,
};

export const exampleApprovalChanges: Approval = {
  id: EXAMPLE_IDS.approvalDesign,
  initiativeId: EXAMPLE_IDS.initiative,
  stage: "design",
  decision: "changes_requested",
  reviewer: "alex.architect",
  comment: "Stream the rows instead of loading the whole month into memory.",
  artifactVersion: 1,
  createdAt: T2,
};

export const exampleRuns: AgentRun[] = [
  {
    id: EXAMPLE_IDS.runRequirement,
    initiativeId: EXAMPLE_IDS.initiative,
    agent: "requirement",
    model: "claude-sonnet-5-5",
    inputTokens: 5200,
    outputTokens: 1400,
    costUsd: 0.0366,
    latencyMs: 9100,
    status: "succeeded",
    createdAt: T1,
  },
  {
    id: EXAMPLE_IDS.runRequirementCritic,
    initiativeId: EXAMPLE_IDS.initiative,
    agent: "requirement_critic",
    model: "claude-sonnet-5-5",
    inputTokens: 2100,
    outputTokens: 300,
    costUsd: 0.0108,
    latencyMs: 3400,
    status: "succeeded",
    createdAt: T1,
  },
];

export function exampleRepo(status: Repo["status"] = "indexed"): Repo {
  const done = status === "indexed";
  const profiled = status !== "profiling";
  return {
    id: EXAMPLE_REPO_ID,
    name: "billing-service",
    source: { type: "url", value: "https://github.com/example-org/billing-service.git" },
    status,
    profile: profiled
      ? {
          totalFiles: 1240,
          totalLoc: 96500,
          languages: [
            { language: "Java", files: 830, loc: 71000 },
            { language: "TypeScript", files: 410, loc: 25500 },
          ],
          recommendation: "full",
          reason: "1240 source files is at or above the 1000 file threshold for the full pipeline.",
        }
      : null,
    indexStrategy: done || status === "indexing" ? "full" : null,
    indexedCommitSha: done ? "9fceb02d0ae598e95dc970b74767f19372d61af8" : null,
    indexedAt: done ? T2 : null,
    createdAt: T0,
    updatedAt: T2,
  };
}
