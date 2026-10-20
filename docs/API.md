# REST API

<!-- GENERATED FILE. Do not edit by hand: change the schemas or endpoint definitions in packages/contracts, then run `pnpm docs:api`. CI fails if this file is out of date. -->

This document is generated from the Zod schemas and endpoint definitions in `@sdd/contracts` (`packages/contracts/src/endpoints.ts`). Every example below is parsed against its schema when this file is generated, so an example cannot drift from the API.

Building against it: the endpoint registry (`API` / `ENDPOINTS`) is exported from `@sdd/contracts` with the schemas and examples, so the server can validate with the same schemas and the UI mock API can serve the same example responses.

## Endpoints

| Endpoint | Summary |
| --- | --- |
| `GET /api/health` | Health check |
| `POST /api/initiatives` | Create an initiative |
| `GET /api/initiatives` | List initiatives |
| `GET /api/initiatives/:id` | Get an initiative |
| `GET /api/initiatives/:id/artifacts` | Get the latest requirements, design and tasks |
| `GET /api/initiatives/:id/artifacts/:kind` | Get one artifact, optionally an older version |
| `GET /api/initiatives/:id/questions` | List clarification questions |
| `POST /api/initiatives/:id/answers` | Answer clarification questions |
| `POST /api/initiatives/:id/approve` | Approve the requirements or the design |
| `POST /api/initiatives/:id/request-changes` | Request changes to the requirements or the design |
| `GET /api/initiatives/:id/approvals` | List the decisions recorded for an initiative |
| `GET /api/initiatives/:id/runs` | List agent runs and their cost |
| `POST /api/repos` | Register a repo and profile it |
| `GET /api/repos` | List registered repos |
| `GET /api/repos/:id` | Get a repo |
| `POST /api/repos/:id/index` | Index a repo |

## Conventions

- All paths are relative to the server origin. Requests and responses are JSON (`Content-Type: application/json`).
- There is no authentication yet. `reviewer` fields are free-form identifiers.
- Ids of initiatives, artifacts, questions, approvals and runs are UUIDs. Repo ids are lowercase slugs.
- Inside one initiative, items are referenced by readable ids: acceptance criteria `AC-1`, requirements `FR-1` / `NFR-1`, design sections `DS-1`, tasks `T-1`.
- Timestamps are ISO 8601 in UTC (`2026-10-21T09:30:00.000Z`).
- Agents run in the background. Calls that start an agent return immediately with a `*_GENERATING` status (or a repo status of `profiling` / `indexing`); poll the resource until it settles. In mock mode (`LLM_MODE=mock`) this takes milliseconds.
- A request that would move an initiative to a status the state machine does not allow is rejected with `409 invalid_transition` and changes nothing.

### Errors

Every error has the same shape:

```json
{
  "error": {
    "code": "not_found",
    "message": "Initiative 3f2b8c1e-5a7d-4e29-9c4b-1d6e8f0a2b34 not found"
  }
}
```

| Status | `error.code` | Meaning |
| --- | --- | --- |
| 400 | `validation_error` | The request does not match the schema. `error.details` lists the Zod issues. |
| 404 | `not_found` | The initiative, repo or artifact does not exist. |
| 409 | `invalid_transition` | The initiative is in a status where this action is not allowed. |
| 409 | `conflict` | The request conflicts with current state (for example a duplicate repo or an already-answered question). |
| 500 | `internal_error` | Unexpected server error. |

A validation error carries the Zod issues:

```json
{
  "error": {
    "code": "validation_error",
    "message": "Request body is invalid",
    "details": [
      {
        "code": "too_small",
        "path": [
          "acceptanceCriteria"
        ],
        "message": "Too small: expected array to have >=1 items"
      }
    ]
  }
}
```

## Status model

Every change of `Initiative.status` goes through the state machine in `@sdd/contracts`. Agents never change status: they propose, the orchestrator transitions, humans approve. These are all the legal transitions and who may trigger them:

| From | To | Triggered by | Meaning |
| --- | --- | --- | --- |
| `READY_FOR_SPEC` | `REQUIREMENT_GENERATING` | product, orchestrator | Product confirms the requirement is ready; the Requirement Agent starts. |
| `REQUIREMENT_GENERATING` | `REQUIREMENT_REVIEW` | orchestrator | Draft produced with open clarification questions (or a failed critique escalated to a human). |
| `REQUIREMENT_GENERATING` | `REQUIREMENT_REVIEWED` | orchestrator | Draft produced with no gaps remaining; waiting for Product's final approval. |
| `REQUIREMENT_REVIEW` | `REQUIREMENT_GENERATING` | product | Product submitted answers; the agent re-runs. |
| `REQUIREMENT_REVIEWED` | `SPEC_APPROVED` | product | Product approves the requirements. |
| `REQUIREMENT_REVIEWED` | `REQUIREMENT_GENERATING` | product | Product requests changes; the agent re-runs. |
| `SPEC_APPROVED` | `DESIGN_GENERATING` | orchestrator | Design Agent starts from the approved requirements. |
| `DESIGN_GENERATING` | `DESIGN_REVIEW` | orchestrator | Design drafted; waiting for architecture review. |
| `DESIGN_REVIEW` | `DESIGN_APPROVED` | architecture | Architecture approves the design. |
| `DESIGN_REVIEW` | `DESIGN_REVISION_REQUESTED` | architecture | Architecture requests changes. |
| `DESIGN_REVISION_REQUESTED` | `DESIGN_GENERATING` | orchestrator | Design Agent re-runs with the review feedback. |
| `DESIGN_APPROVED` | `TASKS_GENERATING` | orchestrator | Both approvals are recorded; the Task Agent starts. |
| `TASKS_GENERATING` | `READY_FOR_DEVELOPMENT` | orchestrator | tasks.md produced. |
| `READY_FOR_DEVELOPMENT` | `IN_DEVELOPMENT` | developer, orchestrator | A developer picks up the work (for example through the MCP server). |
| `IN_DEVELOPMENT` | `DONE` | developer, orchestrator | Implementation finished (or the PR merged). |

Statuses ending in `_GENERATING` are transient: an agent is running. Poll `GET /api/initiatives/:id` until the status changes.

## System

### Health check

`GET /api/health`

Returns `ok` when the server is up, and whether the LLM gateway is in mock or live mode.

**Response `200 OK`**: The server is up.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `status` | `"ok"` | yes |  |
| `llmMode` | `"mock"` \| `"live"` | yes | `mock` serves recorded fixtures (LLM_MODE=mock); `live` calls the model. |

```json
{
  "status": "ok",
  "llmMode": "mock"
}
```

**Errors**

| Status | `error.code` | When |
| --- | --- | --- |
| 500 | `internal_error` | Unexpected server error. |

## Initiatives

### Create an initiative

`POST /api/initiatives`

Creates the initiative (status `READY_FOR_SPEC`) and starts the workflow in the same call, so the response already shows `REQUIREMENT_GENERATING`.
The Requirement Agent runs in the background: poll `GET /api/initiatives/:id` until the status leaves `REQUIREMENT_GENERATING`.

- Case `A` (no repo context): `repoId` is optional and ignored by the agents.
- Case `B` (existing repo): `repoId` is required and the repo must have status `indexed`.
- The server assigns acceptance criterion ids `AC-1`, `AC-2`, ... in the order given.

**Request body**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `title` | string | yes | (1–200 chars) |
| `businessRequirement` | string | yes | (1–20000 chars) |
| `acceptanceCriteria` | string[] | yes | Plain strings. The server assigns the ids AC-1, AC-2, ... in order. (at least 1 item) |
| `caseType` | `"A"` \| `"B"` | yes |  |
| `repoId` | string | no | Required when caseType is `B`. Must be a registered repo with status `indexed`. (pattern `^[a-z0-9][a-z0-9._-]{0,62}$`) |

```json
{
  "title": "Invoice CSV export",
  "businessRequirement": "Finance needs to export a month of invoices as a CSV file so they can reconcile them in a spreadsheet.",
  "acceptanceCriteria": [
    "A CSV with one row per invoice downloads in under 5 seconds for a month of data.",
    "Only users with the finance role can export."
  ],
  "caseType": "B",
  "repoId": "billing-service"
}
```

**Response `201 Created`**: The initiative was created and the Requirement Agent has started.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string (uuid) | yes |  |
| `title` | string | yes | Short name shown in lists. (1–200 chars) |
| `businessRequirement` | string | yes | The source requirement, as written by Product. Treated as untrusted text by the agents. (1–20000 chars) |
| `acceptanceCriteria` | object[] | yes | (at least 1 item) |
| `acceptanceCriteria[].id` | string | yes | Reference id, unique within the initiative. Tasks and requirements cite it. (pattern `^AC-[1-9]\d*$`) |
| `acceptanceCriteria[].text` | string | yes | The criterion, in plain language. (1–2000 chars) |
| `caseType` | `"A"` \| `"B"` | yes | "A" builds something new with no repo context; "B" adds a feature to an existing, indexed repo. |
| `repoId` | string | no | Id of the registered repo. Always present for Case B; usually absent for Case A. (non-empty) |
| `status` | `"READY_FOR_SPEC"` \| `"REQUIREMENT_GENERATING"` \| `"REQUIREMENT_REVIEW"` \| `"REQUIREMENT_REVIEWED"` \| `"SPEC_APPROVED"` \| `"DESIGN_GENERATING"` \| `"DESIGN_REVIEW"` \| `"DESIGN_REVISION_REQUESTED"` \| `"DESIGN_APPROVED"` \| `"TASKS_GENERATING"` \| `"READY_FOR_DEVELOPMENT"` \| `"IN_DEVELOPMENT"` \| `"DONE"` | yes | Current workflow status. Only the orchestrator changes it. |
| `createdAt` | string (ISO 8601 UTC) | yes |  |
| `updatedAt` | string (ISO 8601 UTC) | yes |  |

```json
{
  "id": "3f2b8c1e-5a7d-4e29-9c4b-1d6e8f0a2b34",
  "title": "Invoice CSV export",
  "businessRequirement": "Finance needs to export a month of invoices as a CSV file so they can reconcile them in a spreadsheet.",
  "acceptanceCriteria": [
    {
      "id": "AC-1",
      "text": "A CSV with one row per invoice downloads in under 5 seconds for a month of data."
    },
    {
      "id": "AC-2",
      "text": "Only users with the finance role can export."
    }
  ],
  "caseType": "B",
  "repoId": "billing-service",
  "status": "REQUIREMENT_GENERATING",
  "createdAt": "2026-10-21T09:30:00.000Z",
  "updatedAt": "2026-10-21T09:31:12.000Z"
}
```

**Errors**

| Status | `error.code` | When |
| --- | --- | --- |
| 400 | `validation_error` | The request body, query or path parameter does not match the schema. `details` lists the Zod issues. |
| 400 | `validation_error` | `repoId` does not match any registered repo, or `caseType` is `B` and `repoId` is missing. |
| 409 | `conflict` | The repo exists but is not `indexed` yet. |
| 500 | `internal_error` | Unexpected server error. |

### List initiatives

`GET /api/initiatives`

Newest first. All filters are optional and combine with AND.

Example request line: `GET /api/initiatives?status=REQUIREMENT_REVIEW&limit=20`

**Query parameters**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `status` | `"READY_FOR_SPEC"` \| `"REQUIREMENT_GENERATING"` \| `"REQUIREMENT_REVIEW"` \| `"REQUIREMENT_REVIEWED"` \| `"SPEC_APPROVED"` \| `"DESIGN_GENERATING"` \| `"DESIGN_REVIEW"` \| `"DESIGN_REVISION_REQUESTED"` \| `"DESIGN_APPROVED"` \| `"TASKS_GENERATING"` \| `"READY_FOR_DEVELOPMENT"` \| `"IN_DEVELOPMENT"` \| `"DONE"` | no |  |
| `caseType` | `"A"` \| `"B"` | no |  |
| `limit` | integer | no | Page size. Defaults to 50. (1 to 200, default `50`) |
| `offset` | integer | no | (at least 0, default `0`) |

**Response `200 OK`**: A page of initiatives.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `items` | object[] | yes | Newest first. |
| `items[].id` | string (uuid) | yes |  |
| `items[].title` | string | yes | Short name shown in lists. (1–200 chars) |
| `items[].businessRequirement` | string | yes | The source requirement, as written by Product. Treated as untrusted text by the agents. (1–20000 chars) |
| `items[].acceptanceCriteria` | object[] | yes | (at least 1 item) |
| `items[].acceptanceCriteria[].id` | string | yes | Reference id, unique within the initiative. Tasks and requirements cite it. (pattern `^AC-[1-9]\d*$`) |
| `items[].acceptanceCriteria[].text` | string | yes | The criterion, in plain language. (1–2000 chars) |
| `items[].caseType` | `"A"` \| `"B"` | yes | "A" builds something new with no repo context; "B" adds a feature to an existing, indexed repo. |
| `items[].repoId` | string | no | Id of the registered repo. Always present for Case B; usually absent for Case A. (non-empty) |
| `items[].status` | `"READY_FOR_SPEC"` \| `"REQUIREMENT_GENERATING"` \| `"REQUIREMENT_REVIEW"` \| `"REQUIREMENT_REVIEWED"` \| `"SPEC_APPROVED"` \| `"DESIGN_GENERATING"` \| `"DESIGN_REVIEW"` \| `"DESIGN_REVISION_REQUESTED"` \| `"DESIGN_APPROVED"` \| `"TASKS_GENERATING"` \| `"READY_FOR_DEVELOPMENT"` \| `"IN_DEVELOPMENT"` \| `"DONE"` | yes | Current workflow status. Only the orchestrator changes it. |
| `items[].createdAt` | string (ISO 8601 UTC) | yes |  |
| `items[].updatedAt` | string (ISO 8601 UTC) | yes |  |
| `total` | integer | yes | Number of initiatives matching the filters, ignoring limit and offset. (at least 0) |

```json
{
  "items": [
    {
      "id": "3f2b8c1e-5a7d-4e29-9c4b-1d6e8f0a2b34",
      "title": "Invoice CSV export",
      "businessRequirement": "Finance needs to export a month of invoices as a CSV file so they can reconcile them in a spreadsheet.",
      "acceptanceCriteria": [
        {
          "id": "AC-1",
          "text": "A CSV with one row per invoice downloads in under 5 seconds for a month of data."
        },
        {
          "id": "AC-2",
          "text": "Only users with the finance role can export."
        }
      ],
      "caseType": "B",
      "repoId": "billing-service",
      "status": "REQUIREMENT_REVIEW",
      "createdAt": "2026-10-21T09:30:00.000Z",
      "updatedAt": "2026-10-21T09:31:12.000Z"
    }
  ],
  "total": 1
}
```

**Errors**

| Status | `error.code` | When |
| --- | --- | --- |
| 400 | `validation_error` | The request body, query or path parameter does not match the schema. `details` lists the Zod issues. |
| 500 | `internal_error` | Unexpected server error. |

### Get an initiative

`GET /api/initiatives/:id`

Use this to poll while the status is `*_GENERATING`.

Example request line: `GET /api/initiatives/3f2b8c1e-5a7d-4e29-9c4b-1d6e8f0a2b34`

**Path parameters**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string (uuid) | yes | Initiative id. |

**Response `200 OK`**: The initiative.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string (uuid) | yes |  |
| `title` | string | yes | Short name shown in lists. (1–200 chars) |
| `businessRequirement` | string | yes | The source requirement, as written by Product. Treated as untrusted text by the agents. (1–20000 chars) |
| `acceptanceCriteria` | object[] | yes | (at least 1 item) |
| `acceptanceCriteria[].id` | string | yes | Reference id, unique within the initiative. Tasks and requirements cite it. (pattern `^AC-[1-9]\d*$`) |
| `acceptanceCriteria[].text` | string | yes | The criterion, in plain language. (1–2000 chars) |
| `caseType` | `"A"` \| `"B"` | yes | "A" builds something new with no repo context; "B" adds a feature to an existing, indexed repo. |
| `repoId` | string | no | Id of the registered repo. Always present for Case B; usually absent for Case A. (non-empty) |
| `status` | `"READY_FOR_SPEC"` \| `"REQUIREMENT_GENERATING"` \| `"REQUIREMENT_REVIEW"` \| `"REQUIREMENT_REVIEWED"` \| `"SPEC_APPROVED"` \| `"DESIGN_GENERATING"` \| `"DESIGN_REVIEW"` \| `"DESIGN_REVISION_REQUESTED"` \| `"DESIGN_APPROVED"` \| `"TASKS_GENERATING"` \| `"READY_FOR_DEVELOPMENT"` \| `"IN_DEVELOPMENT"` \| `"DONE"` | yes | Current workflow status. Only the orchestrator changes it. |
| `createdAt` | string (ISO 8601 UTC) | yes |  |
| `updatedAt` | string (ISO 8601 UTC) | yes |  |

```json
{
  "id": "3f2b8c1e-5a7d-4e29-9c4b-1d6e8f0a2b34",
  "title": "Invoice CSV export",
  "businessRequirement": "Finance needs to export a month of invoices as a CSV file so they can reconcile them in a spreadsheet.",
  "acceptanceCriteria": [
    {
      "id": "AC-1",
      "text": "A CSV with one row per invoice downloads in under 5 seconds for a month of data."
    },
    {
      "id": "AC-2",
      "text": "Only users with the finance role can export."
    }
  ],
  "caseType": "B",
  "repoId": "billing-service",
  "status": "REQUIREMENT_REVIEW",
  "createdAt": "2026-10-21T09:30:00.000Z",
  "updatedAt": "2026-10-21T09:31:12.000Z"
}
```

**Errors**

| Status | `error.code` | When |
| --- | --- | --- |
| 400 | `validation_error` | The path parameter is not a valid id. |
| 404 | `not_found` | No initiative with this id. |
| 500 | `internal_error` | Unexpected server error. |

## Artifacts

### Get the latest requirements, design and tasks

`GET /api/initiatives/:id/artifacts`

Returns the latest version of each artifact. An artifact that has not been generated yet is `null`. `markdown` is the rendered file; `content` is the same data as structured JSON.

Example request line: `GET /api/initiatives/3f2b8c1e-5a7d-4e29-9c4b-1d6e8f0a2b34/artifacts`

**Path parameters**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string (uuid) | yes | Initiative id. |

**Response `200 OK`**: The latest version of each artifact.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `requirements` | object or null | yes | Latest version, or null if not generated yet. |
| `requirements.id` | string (uuid) | yes |  |
| `requirements.initiativeId` | string (uuid) | yes |  |
| `requirements.version` | integer | yes | 1-based; increases on every regeneration or human edit. (at least 1) |
| `requirements.markdown` | string | yes | The rendered file (requirements.md, design.md or tasks.md), always generated from `content`. (0–200000 chars) |
| `requirements.needsHumanMerge` | boolean | yes | True when a human edited the markdown and regenerating would overwrite it. Regeneration stops until a human merges. |
| `requirements.agentRunId` | string (uuid) | no | The agent run that produced this version. Absent for human edits. |
| `requirements.createdAt` | string (ISO 8601 UTC) | yes |  |
| `requirements.kind` | `"requirements"` | yes |  |
| `requirements.content` | object | yes |  |
| `requirements.content.summary` | string | yes | One paragraph restating what is being built and why. (1–20000 chars) |
| `requirements.content.functionalRequirements` | object[] | yes | (at least 1 item) |
| `requirements.content.functionalRequirements[].id` | string | yes | (pattern `^FR-[1-9]\d*$`) |
| `requirements.content.functionalRequirements[].statement` | string | yes | (1–2000 chars) |
| `requirements.content.functionalRequirements[].acceptanceCriterionRefs` | string[] | yes | Acceptance criteria (AC-n) this requirement covers. |
| `requirements.content.nonFunctionalRequirements` | object[] | yes |  |
| `requirements.content.nonFunctionalRequirements[].id` | string | yes | (pattern `^NFR-[1-9]\d*$`) |
| `requirements.content.nonFunctionalRequirements[].statement` | string | yes | (1–2000 chars) |
| `requirements.content.assumptions` | string[] | yes |  |
| `requirements.content.outOfScope` | string[] | yes |  |
| `design` | object or null | yes | Latest version, or null if not generated yet. |
| `design.id` | string (uuid) | yes |  |
| `design.initiativeId` | string (uuid) | yes |  |
| `design.version` | integer | yes | 1-based; increases on every regeneration or human edit. (at least 1) |
| `design.markdown` | string | yes | The rendered file (requirements.md, design.md or tasks.md), always generated from `content`. (0–200000 chars) |
| `design.needsHumanMerge` | boolean | yes | True when a human edited the markdown and regenerating would overwrite it. Regeneration stops until a human merges. |
| `design.agentRunId` | string (uuid) | no | The agent run that produced this version. Absent for human edits. |
| `design.createdAt` | string (ISO 8601 UTC) | yes |  |
| `design.kind` | `"design"` | yes |  |
| `design.content` | object | yes |  |
| `design.content.overview` | string | yes | (1–20000 chars) |
| `design.content.sections` | object[] | yes | (at least 1 item) |
| `design.content.sections[].id` | string | yes | (pattern `^DS-[1-9]\d*$`) |
| `design.content.sections[].title` | string | yes | (1–200 chars) |
| `design.content.sections[].body` | string | yes | (1–20000 chars) |
| `design.content.sections[].referencedPaths` | string[] | yes | Repo-relative files or modules this section touches. In Case B each one must exist in the indexed repo. |
| `design.content.risks` | string[] | yes |  |
| `design.grounding` | object or null | yes | Null for Case A or before the check has run. |
| `design.grounding.checkedPaths` | string[] | yes | Every path named in design.md that was checked. |
| `design.grounding.missingPaths` | string[] | yes | Checked paths that do not exist in the indexed repo. Empty means fully grounded. |
| `design.grounding.checkedAt` | string (ISO 8601 UTC) | yes |  |
| `tasks` | object or null | yes | Latest version, or null if not generated yet. |
| `tasks.id` | string (uuid) | yes |  |
| `tasks.initiativeId` | string (uuid) | yes |  |
| `tasks.version` | integer | yes | 1-based; increases on every regeneration or human edit. (at least 1) |
| `tasks.markdown` | string | yes | The rendered file (requirements.md, design.md or tasks.md), always generated from `content`. (0–200000 chars) |
| `tasks.needsHumanMerge` | boolean | yes | True when a human edited the markdown and regenerating would overwrite it. Regeneration stops until a human merges. |
| `tasks.agentRunId` | string (uuid) | no | The agent run that produced this version. Absent for human edits. |
| `tasks.createdAt` | string (ISO 8601 UTC) | yes |  |
| `tasks.kind` | `"tasks"` | yes |  |
| `tasks.content` | object | yes |  |
| `tasks.content.tasks` | object[] | yes | (at least 1 item) |
| `tasks.content.tasks[].id` | string | yes | Unique within the tasks artifact. (pattern `^T-[1-9]\d*$`) |
| `tasks.content.tasks[].title` | string | yes | (1–200 chars) |
| `tasks.content.tasks[].description` | string | yes | (1–20000 chars) |
| `tasks.content.tasks[].designSectionRef` | string | yes | The design section (DS-n) this task implements. (pattern `^DS-[1-9]\d*$`) |
| `tasks.content.tasks[].acceptanceCriterionRefs` | string[] | yes | Acceptance criteria (AC-n) this task helps satisfy. (at least 1 item) |
| `tasks.content.tasks[].dependsOn` | string[] | yes | Ids of tasks that must finish first. Never forms a cycle. |
| `tasks.content.tasks[].status` | `"todo"` \| `"in_progress"` \| `"done"` | yes |  |

```json
{
  "requirements": {
    "id": "c3e5a1d8-7b2f-4c94-a6d0-2f8b4e1c9a53",
    "initiativeId": "3f2b8c1e-5a7d-4e29-9c4b-1d6e8f0a2b34",
    "kind": "requirements",
    "version": 1,
    "markdown": "# Requirements: Invoice CSV export\n\nFinance can export a month of invoices as a CSV file.\n\n## Functional requirements\n\n- **FR-1** The system exports invoices for a chosen month as a CSV file with one row per invoice. (AC-1)\n- **FR-2** Only users with the finance role can start an export. (AC-2)\n\n## Non-functional requirements\n\n- **NFR-1** A month of invoices exports in under 5 seconds.\n\n## Out of scope\n\n- PDF export\n",
    "needsHumanMerge": false,
    "agentRunId": "1b6d0f2c-8e4a-4c59-b3d7-9a5f1e2c7d04",
    "createdAt": "2026-10-21T09:31:12.000Z",
    "content": {
      "summary": "Finance can export a month of invoices as a CSV file.",
      "functionalRequirements": [
        {
          "id": "FR-1",
          "statement": "The system exports invoices for a chosen month as a CSV file with one row per invoice.",
          "acceptanceCriterionRefs": [
            "AC-1"
          ]
        },
        {
          "id": "FR-2",
          "statement": "Only users with the finance role can start an export.",
          "acceptanceCriterionRefs": [
            "AC-2"
          ]
        }
      ],
      "nonFunctionalRequirements": [
        {
          "id": "NFR-1",
          "statement": "A month of invoices exports in under 5 seconds."
        }
      ],
      "assumptions": [
        "Invoices are stored in the existing billing database."
      ],
      "outOfScope": [
        "PDF export"
      ]
    }
  },
  "design": {
    "id": "d9f1b3c6-4a8e-4d27-b5e1-7c0a3f9d2e86",
    "initiativeId": "3f2b8c1e-5a7d-4e29-9c4b-1d6e8f0a2b34",
    "kind": "design",
    "version": 1,
    "markdown": "# Design: Invoice CSV export\n\nAdd a CSV export route next to the existing invoice controller.\n\n## DS-1 Export endpoint\n\nAdd `GET /invoices/export` to `src/billing/InvoiceController.java`, guarded by the finance role.\n\nFiles: `src/billing/InvoiceController.java`, `src/billing/InvoiceService.java`\n",
    "needsHumanMerge": false,
    "agentRunId": "2c7e1a3d-9f5b-4d6a-84e8-0b6a2f3d8e15",
    "createdAt": "2026-10-21T10:05:40.000Z",
    "content": {
      "overview": "Add a CSV export route next to the existing invoice controller.",
      "sections": [
        {
          "id": "DS-1",
          "title": "Export endpoint",
          "body": "Add `GET /invoices/export` to the invoice controller, guarded by the finance role.",
          "referencedPaths": [
            "src/billing/InvoiceController.java",
            "src/billing/InvoiceService.java"
          ]
        }
      ],
      "risks": [
        "A large month could exceed the 5 second target; stream rows instead of buffering."
      ]
    },
    "grounding": {
      "checkedPaths": [
        "src/billing/InvoiceController.java",
        "src/billing/InvoiceService.java"
      ],
      "missingPaths": [],
      "checkedAt": "2026-10-21T10:05:40.000Z"
    }
  },
  "tasks": {
    "id": "e2a6c8f0-3d5b-4f19-9a7c-6b1d4e8f0c25",
    "initiativeId": "3f2b8c1e-5a7d-4e29-9c4b-1d6e8f0a2b34",
    "kind": "tasks",
    "version": 1,
    "markdown": "# Tasks: Invoice CSV export\n\n- [ ] **T-1** Add export query to InvoiceService (DS-1, AC-1)\n- [ ] **T-2** Add `GET /invoices/export` with finance role guard (DS-1, AC-1, AC-2). Depends on T-1.\n",
    "needsHumanMerge": false,
    "createdAt": "2026-10-21T11:00:00.000Z",
    "content": {
      "tasks": [
        {
          "id": "T-1",
          "title": "Add export query to InvoiceService",
          "description": "Stream invoices for a month, excluding voided ones, in CSV row order.",
          "designSectionRef": "DS-1",
          "acceptanceCriterionRefs": [
            "AC-1"
          ],
          "dependsOn": [],
          "status": "todo"
        },
        {
          "id": "T-2",
          "title": "Add GET /invoices/export with finance role guard",
          "description": "Expose the export as a CSV download and reject users without the finance role.",
          "designSectionRef": "DS-1",
          "acceptanceCriterionRefs": [
            "AC-1",
            "AC-2"
          ],
          "dependsOn": [
            "T-1"
          ],
          "status": "todo"
        }
      ]
    }
  }
}
```

**Errors**

| Status | `error.code` | When |
| --- | --- | --- |
| 400 | `validation_error` | The path parameter is not a valid id. |
| 404 | `not_found` | No initiative with this id. |
| 500 | `internal_error` | Unexpected server error. |

### Get one artifact, optionally an older version

`GET /api/initiatives/:id/artifacts/:kind`

`kind` is `requirements`, `design` or `tasks`. Without `version` the latest version is returned.

Example request line: `GET /api/initiatives/3f2b8c1e-5a7d-4e29-9c4b-1d6e8f0a2b34/artifacts/design?version=1`

**Path parameters**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string (uuid) | yes | Initiative id. |
| `kind` | `"requirements"` \| `"design"` \| `"tasks"` | yes |  |

**Query parameters**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `version` | integer | no | A specific version. Defaults to the latest. (at least 1) |

**Response `200 OK`**: The artifact. Its shape depends on `kind`.

When `kind="requirements"`:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string (uuid) | yes |  |
| `initiativeId` | string (uuid) | yes |  |
| `version` | integer | yes | 1-based; increases on every regeneration or human edit. (at least 1) |
| `markdown` | string | yes | The rendered file (requirements.md, design.md or tasks.md), always generated from `content`. (0–200000 chars) |
| `needsHumanMerge` | boolean | yes | True when a human edited the markdown and regenerating would overwrite it. Regeneration stops until a human merges. |
| `agentRunId` | string (uuid) | no | The agent run that produced this version. Absent for human edits. |
| `createdAt` | string (ISO 8601 UTC) | yes |  |
| `kind` | `"requirements"` | yes |  |
| `content` | object | yes |  |
| `content.summary` | string | yes | One paragraph restating what is being built and why. (1–20000 chars) |
| `content.functionalRequirements` | object[] | yes | (at least 1 item) |
| `content.functionalRequirements[].id` | string | yes | (pattern `^FR-[1-9]\d*$`) |
| `content.functionalRequirements[].statement` | string | yes | (1–2000 chars) |
| `content.functionalRequirements[].acceptanceCriterionRefs` | string[] | yes | Acceptance criteria (AC-n) this requirement covers. |
| `content.nonFunctionalRequirements` | object[] | yes |  |
| `content.nonFunctionalRequirements[].id` | string | yes | (pattern `^NFR-[1-9]\d*$`) |
| `content.nonFunctionalRequirements[].statement` | string | yes | (1–2000 chars) |
| `content.assumptions` | string[] | yes |  |
| `content.outOfScope` | string[] | yes |  |

When `kind="design"`:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string (uuid) | yes |  |
| `initiativeId` | string (uuid) | yes |  |
| `version` | integer | yes | 1-based; increases on every regeneration or human edit. (at least 1) |
| `markdown` | string | yes | The rendered file (requirements.md, design.md or tasks.md), always generated from `content`. (0–200000 chars) |
| `needsHumanMerge` | boolean | yes | True when a human edited the markdown and regenerating would overwrite it. Regeneration stops until a human merges. |
| `agentRunId` | string (uuid) | no | The agent run that produced this version. Absent for human edits. |
| `createdAt` | string (ISO 8601 UTC) | yes |  |
| `kind` | `"design"` | yes |  |
| `content` | object | yes |  |
| `content.overview` | string | yes | (1–20000 chars) |
| `content.sections` | object[] | yes | (at least 1 item) |
| `content.sections[].id` | string | yes | (pattern `^DS-[1-9]\d*$`) |
| `content.sections[].title` | string | yes | (1–200 chars) |
| `content.sections[].body` | string | yes | (1–20000 chars) |
| `content.sections[].referencedPaths` | string[] | yes | Repo-relative files or modules this section touches. In Case B each one must exist in the indexed repo. |
| `content.risks` | string[] | yes |  |
| `grounding` | object or null | yes | Null for Case A or before the check has run. |
| `grounding.checkedPaths` | string[] | yes | Every path named in design.md that was checked. |
| `grounding.missingPaths` | string[] | yes | Checked paths that do not exist in the indexed repo. Empty means fully grounded. |
| `grounding.checkedAt` | string (ISO 8601 UTC) | yes |  |

When `kind="tasks"`:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string (uuid) | yes |  |
| `initiativeId` | string (uuid) | yes |  |
| `version` | integer | yes | 1-based; increases on every regeneration or human edit. (at least 1) |
| `markdown` | string | yes | The rendered file (requirements.md, design.md or tasks.md), always generated from `content`. (0–200000 chars) |
| `needsHumanMerge` | boolean | yes | True when a human edited the markdown and regenerating would overwrite it. Regeneration stops until a human merges. |
| `agentRunId` | string (uuid) | no | The agent run that produced this version. Absent for human edits. |
| `createdAt` | string (ISO 8601 UTC) | yes |  |
| `kind` | `"tasks"` | yes |  |
| `content` | object | yes |  |
| `content.tasks` | object[] | yes | (at least 1 item) |
| `content.tasks[].id` | string | yes | Unique within the tasks artifact. (pattern `^T-[1-9]\d*$`) |
| `content.tasks[].title` | string | yes | (1–200 chars) |
| `content.tasks[].description` | string | yes | (1–20000 chars) |
| `content.tasks[].designSectionRef` | string | yes | The design section (DS-n) this task implements. (pattern `^DS-[1-9]\d*$`) |
| `content.tasks[].acceptanceCriterionRefs` | string[] | yes | Acceptance criteria (AC-n) this task helps satisfy. (at least 1 item) |
| `content.tasks[].dependsOn` | string[] | yes | Ids of tasks that must finish first. Never forms a cycle. |
| `content.tasks[].status` | `"todo"` \| `"in_progress"` \| `"done"` | yes |  |

```json
{
  "id": "d9f1b3c6-4a8e-4d27-b5e1-7c0a3f9d2e86",
  "initiativeId": "3f2b8c1e-5a7d-4e29-9c4b-1d6e8f0a2b34",
  "kind": "design",
  "version": 1,
  "markdown": "# Design: Invoice CSV export\n\nAdd a CSV export route next to the existing invoice controller.\n\n## DS-1 Export endpoint\n\nAdd `GET /invoices/export` to `src/billing/InvoiceController.java`, guarded by the finance role.\n\nFiles: `src/billing/InvoiceController.java`, `src/billing/InvoiceService.java`\n",
  "needsHumanMerge": false,
  "agentRunId": "2c7e1a3d-9f5b-4d6a-84e8-0b6a2f3d8e15",
  "createdAt": "2026-10-21T10:05:40.000Z",
  "content": {
    "overview": "Add a CSV export route next to the existing invoice controller.",
    "sections": [
      {
        "id": "DS-1",
        "title": "Export endpoint",
        "body": "Add `GET /invoices/export` to the invoice controller, guarded by the finance role.",
        "referencedPaths": [
          "src/billing/InvoiceController.java",
          "src/billing/InvoiceService.java"
        ]
      }
    ],
    "risks": [
      "A large month could exceed the 5 second target; stream rows instead of buffering."
    ]
  },
  "grounding": {
    "checkedPaths": [
      "src/billing/InvoiceController.java",
      "src/billing/InvoiceService.java"
    ],
    "missingPaths": [],
    "checkedAt": "2026-10-21T10:05:40.000Z"
  }
}
```

**Errors**

| Status | `error.code` | When |
| --- | --- | --- |
| 400 | `validation_error` | The path parameter is not a valid id. |
| 404 | `not_found` | No initiative with this id. |
| 404 | `not_found` | The artifact has not been generated yet, or that version does not exist. |
| 500 | `internal_error` | Unexpected server error. |

## Clarification

### List clarification questions

`GET /api/initiatives/:id/questions`

All questions raised by the agents for this initiative, oldest first. Filter with `stage` and `answered`.

Example request line: `GET /api/initiatives/3f2b8c1e-5a7d-4e29-9c4b-1d6e8f0a2b34/questions?stage=requirements&answered=false`

**Path parameters**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string (uuid) | yes | Initiative id. |

**Query parameters**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `stage` | `"requirements"` \| `"design"` | no |  |
| `answered` | `"true"` \| `"false"` | no | Filter to answered (`true`) or open (`false`) questions. |

**Response `200 OK`**: The questions.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `items` | object[] | yes |  |
| `items[].id` | string (uuid) | yes |  |
| `items[].initiativeId` | string (uuid) | yes |  |
| `items[].stage` | `"requirements"` \| `"design"` | yes | Which agent raised the question. |
| `items[].question` | string | yes | (1–2000 chars) |
| `items[].answer` | string or null | yes | Null until a human answers. (1–20000 chars) |
| `items[].createdAt` | string (ISO 8601 UTC) | yes |  |
| `items[].answeredAt` | string (ISO 8601 UTC) or null | yes | Null until a human answers. |

```json
{
  "items": [
    {
      "id": "b7d2f9a4-1c6e-4b83-8a15-9f3e2d6c0b47",
      "initiativeId": "3f2b8c1e-5a7d-4e29-9c4b-1d6e8f0a2b34",
      "stage": "requirements",
      "question": "Should voided invoices appear in the export?",
      "answer": "No, exclude voided invoices.",
      "createdAt": "2026-10-21T09:31:12.000Z",
      "answeredAt": "2026-10-21T10:05:40.000Z"
    },
    {
      "id": "a1c4e7b2-8d3f-4a56-b2c9-5e0f1a7d3c68",
      "initiativeId": "3f2b8c1e-5a7d-4e29-9c4b-1d6e8f0a2b34",
      "stage": "requirements",
      "question": "InvoiceService retries failed payments three times. Should the export include invoices still being retried?",
      "answer": null,
      "createdAt": "2026-10-21T09:31:12.000Z",
      "answeredAt": null
    }
  ]
}
```

**Errors**

| Status | `error.code` | When |
| --- | --- | --- |
| 400 | `validation_error` | The path parameter is not a valid id. |
| 404 | `not_found` | No initiative with this id. |
| 500 | `internal_error` | Unexpected server error. |

### Answer clarification questions

`POST /api/initiatives/:id/answers`

Stores the answers.

- Requirements stage (status `REQUIREMENT_REVIEW`): every open requirements question must be answered, in this request or an earlier one. The initiative then moves to `REQUIREMENT_GENERATING` and the Requirement Agent re-runs with the answers.
- Design stage (status `DESIGN_REVIEW`): the answers are stored and used by the Design Agent the next time Architecture requests changes. The status does not change.
- A question that already has an answer cannot be answered again.

Example request line: `POST /api/initiatives/3f2b8c1e-5a7d-4e29-9c4b-1d6e8f0a2b34/answers`

**Path parameters**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string (uuid) | yes | Initiative id. |

**Request body**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `answers` | object[] | yes | (at least 1 item) |
| `answers[].questionId` | string (uuid) | yes |  |
| `answers[].answer` | string | yes | (1–20000 chars) |

```json
{
  "answers": [
    {
      "questionId": "a1c4e7b2-8d3f-4a56-b2c9-5e0f1a7d3c68",
      "answer": "No, only invoices that are fully settled."
    }
  ]
}
```

**Response `200 OK`**: The answers were stored.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `initiative` | object | yes |  |
| `initiative.id` | string (uuid) | yes |  |
| `initiative.title` | string | yes | Short name shown in lists. (1–200 chars) |
| `initiative.businessRequirement` | string | yes | The source requirement, as written by Product. Treated as untrusted text by the agents. (1–20000 chars) |
| `initiative.acceptanceCriteria` | object[] | yes | (at least 1 item) |
| `initiative.acceptanceCriteria[].id` | string | yes | Reference id, unique within the initiative. Tasks and requirements cite it. (pattern `^AC-[1-9]\d*$`) |
| `initiative.acceptanceCriteria[].text` | string | yes | The criterion, in plain language. (1–2000 chars) |
| `initiative.caseType` | `"A"` \| `"B"` | yes | "A" builds something new with no repo context; "B" adds a feature to an existing, indexed repo. |
| `initiative.repoId` | string | no | Id of the registered repo. Always present for Case B; usually absent for Case A. (non-empty) |
| `initiative.status` | `"READY_FOR_SPEC"` \| `"REQUIREMENT_GENERATING"` \| `"REQUIREMENT_REVIEW"` \| `"REQUIREMENT_REVIEWED"` \| `"SPEC_APPROVED"` \| `"DESIGN_GENERATING"` \| `"DESIGN_REVIEW"` \| `"DESIGN_REVISION_REQUESTED"` \| `"DESIGN_APPROVED"` \| `"TASKS_GENERATING"` \| `"READY_FOR_DEVELOPMENT"` \| `"IN_DEVELOPMENT"` \| `"DONE"` | yes | Current workflow status. Only the orchestrator changes it. |
| `initiative.createdAt` | string (ISO 8601 UTC) | yes |  |
| `initiative.updatedAt` | string (ISO 8601 UTC) | yes |  |
| `questions` | object[] | yes | The questions that were answered by this request. |
| `questions[].id` | string (uuid) | yes |  |
| `questions[].initiativeId` | string (uuid) | yes |  |
| `questions[].stage` | `"requirements"` \| `"design"` | yes | Which agent raised the question. |
| `questions[].question` | string | yes | (1–2000 chars) |
| `questions[].answer` | string or null | yes | Null until a human answers. (1–20000 chars) |
| `questions[].createdAt` | string (ISO 8601 UTC) | yes |  |
| `questions[].answeredAt` | string (ISO 8601 UTC) or null | yes | Null until a human answers. |

```json
{
  "initiative": {
    "id": "3f2b8c1e-5a7d-4e29-9c4b-1d6e8f0a2b34",
    "title": "Invoice CSV export",
    "businessRequirement": "Finance needs to export a month of invoices as a CSV file so they can reconcile them in a spreadsheet.",
    "acceptanceCriteria": [
      {
        "id": "AC-1",
        "text": "A CSV with one row per invoice downloads in under 5 seconds for a month of data."
      },
      {
        "id": "AC-2",
        "text": "Only users with the finance role can export."
      }
    ],
    "caseType": "B",
    "repoId": "billing-service",
    "status": "REQUIREMENT_GENERATING",
    "createdAt": "2026-10-21T09:30:00.000Z",
    "updatedAt": "2026-10-21T09:31:12.000Z"
  },
  "questions": [
    {
      "id": "a1c4e7b2-8d3f-4a56-b2c9-5e0f1a7d3c68",
      "initiativeId": "3f2b8c1e-5a7d-4e29-9c4b-1d6e8f0a2b34",
      "stage": "requirements",
      "question": "InvoiceService retries failed payments three times. Should the export include invoices still being retried?",
      "answer": "No, only invoices that are fully settled.",
      "createdAt": "2026-10-21T09:31:12.000Z",
      "answeredAt": "2026-10-21T10:10:00.000Z"
    }
  ]
}
```

**Errors**

| Status | `error.code` | When |
| --- | --- | --- |
| 400 | `validation_error` | The request body, query or path parameter does not match the schema. `details` lists the Zod issues. |
| 400 | `validation_error` | A `questionId` does not belong to this initiative, or open requirements questions remain unanswered. |
| 404 | `not_found` | No initiative with this id. |
| 409 | `invalid_transition` | The initiative is not waiting for answers (status is not `REQUIREMENT_REVIEW` or `DESIGN_REVIEW`). |
| 409 | `conflict` | One of the questions already has an answer. |
| 500 | `internal_error` | Unexpected server error. |

## Approvals

### Approve the requirements or the design

`POST /api/initiatives/:id/approve`

Records an `approved` decision for the artifact version currently under review.

- `stage: "requirements"` is decided by Product and needs status `REQUIREMENT_REVIEWED`. The initiative moves to `SPEC_APPROVED`, then the orchestrator starts the Design Agent (`DESIGN_GENERATING`).
- `stage: "design"` is decided by Architecture and needs status `DESIGN_REVIEW`. The initiative moves to `DESIGN_APPROVED`, then the orchestrator starts the Task Agent (`TASKS_GENERATING`).

The response shows the status after these automatic steps, so it is usually already `DESIGN_GENERATING` or `TASKS_GENERATING`.
Agents never approve: only this call, made by a person, moves an initiative past a gate.

Example request line: `POST /api/initiatives/3f2b8c1e-5a7d-4e29-9c4b-1d6e8f0a2b34/approve`

**Path parameters**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string (uuid) | yes | Initiative id. |

**Request body**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `stage` | `"requirements"` \| `"design"` | yes |  |
| `reviewer` | string | yes | Who is approving. Free-form until real auth exists. (1–200 chars) |
| `comment` | string | no | Optional. (0–20000 chars, default `""`) |

```json
{
  "stage": "requirements",
  "reviewer": "priya.product",
  "comment": "Looks complete."
}
```

**Response `200 OK`**: The approval was recorded.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `initiative` | object | yes | The initiative after the status change. |
| `initiative.id` | string (uuid) | yes |  |
| `initiative.title` | string | yes | Short name shown in lists. (1–200 chars) |
| `initiative.businessRequirement` | string | yes | The source requirement, as written by Product. Treated as untrusted text by the agents. (1–20000 chars) |
| `initiative.acceptanceCriteria` | object[] | yes | (at least 1 item) |
| `initiative.acceptanceCriteria[].id` | string | yes | Reference id, unique within the initiative. Tasks and requirements cite it. (pattern `^AC-[1-9]\d*$`) |
| `initiative.acceptanceCriteria[].text` | string | yes | The criterion, in plain language. (1–2000 chars) |
| `initiative.caseType` | `"A"` \| `"B"` | yes | "A" builds something new with no repo context; "B" adds a feature to an existing, indexed repo. |
| `initiative.repoId` | string | no | Id of the registered repo. Always present for Case B; usually absent for Case A. (non-empty) |
| `initiative.status` | `"READY_FOR_SPEC"` \| `"REQUIREMENT_GENERATING"` \| `"REQUIREMENT_REVIEW"` \| `"REQUIREMENT_REVIEWED"` \| `"SPEC_APPROVED"` \| `"DESIGN_GENERATING"` \| `"DESIGN_REVIEW"` \| `"DESIGN_REVISION_REQUESTED"` \| `"DESIGN_APPROVED"` \| `"TASKS_GENERATING"` \| `"READY_FOR_DEVELOPMENT"` \| `"IN_DEVELOPMENT"` \| `"DONE"` | yes | Current workflow status. Only the orchestrator changes it. |
| `initiative.createdAt` | string (ISO 8601 UTC) | yes |  |
| `initiative.updatedAt` | string (ISO 8601 UTC) | yes |  |
| `approval` | object | yes | The decision that was recorded. |
| `approval.id` | string (uuid) | yes |  |
| `approval.initiativeId` | string (uuid) | yes |  |
| `approval.stage` | `"requirements"` \| `"design"` | yes | "requirements" is decided by Product, "design" by Architecture. |
| `approval.decision` | `"approved"` \| `"changes_requested"` | yes |  |
| `approval.reviewer` | string | yes | Who decided. A free-form identifier until real auth exists. (1–200 chars) |
| `approval.comment` | string | yes | Empty string when the reviewer gave no comment. (0–20000 chars) |
| `approval.artifactVersion` | integer | yes | The artifact version the decision applies to. (at least 1) |
| `approval.createdAt` | string (ISO 8601 UTC) | yes |  |

```json
{
  "initiative": {
    "id": "3f2b8c1e-5a7d-4e29-9c4b-1d6e8f0a2b34",
    "title": "Invoice CSV export",
    "businessRequirement": "Finance needs to export a month of invoices as a CSV file so they can reconcile them in a spreadsheet.",
    "acceptanceCriteria": [
      {
        "id": "AC-1",
        "text": "A CSV with one row per invoice downloads in under 5 seconds for a month of data."
      },
      {
        "id": "AC-2",
        "text": "Only users with the finance role can export."
      }
    ],
    "caseType": "B",
    "repoId": "billing-service",
    "status": "DESIGN_GENERATING",
    "createdAt": "2026-10-21T09:30:00.000Z",
    "updatedAt": "2026-10-21T09:31:12.000Z"
  },
  "approval": {
    "id": "f4b8d0a2-6c1e-4a35-8d9f-3e7a5c2b1f90",
    "initiativeId": "3f2b8c1e-5a7d-4e29-9c4b-1d6e8f0a2b34",
    "stage": "requirements",
    "decision": "approved",
    "reviewer": "priya.product",
    "comment": "Looks complete.",
    "artifactVersion": 1,
    "createdAt": "2026-10-21T10:05:40.000Z"
  }
}
```

**Errors**

| Status | `error.code` | When |
| --- | --- | --- |
| 400 | `validation_error` | The request body, query or path parameter does not match the schema. `details` lists the Zod issues. |
| 404 | `not_found` | No initiative with this id. |
| 409 | `invalid_transition` | The initiative is not waiting for a decision at this `stage` (wrong status). |
| 500 | `internal_error` | Unexpected server error. |

### Request changes to the requirements or the design

`POST /api/initiatives/:id/request-changes`

Records a `changes_requested` decision. `comment` is required and is passed to the agent as feedback.

- `stage: "requirements"` needs status `REQUIREMENT_REVIEWED`. The initiative moves back to `REQUIREMENT_GENERATING`.
- `stage: "design"` needs status `DESIGN_REVIEW`. The initiative moves to `DESIGN_REVISION_REQUESTED`, then the orchestrator re-runs the Design Agent (`DESIGN_GENERATING`).

Re-analysis only ever happens through an explicit call like this one, never because of a comment.

Example request line: `POST /api/initiatives/3f2b8c1e-5a7d-4e29-9c4b-1d6e8f0a2b34/request-changes`

**Path parameters**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string (uuid) | yes | Initiative id. |

**Request body**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `stage` | `"requirements"` \| `"design"` | yes |  |
| `reviewer` | string | yes | (1–200 chars) |
| `comment` | string | yes | Required: the agent revises using this feedback. (1–20000 chars) |

```json
{
  "stage": "design",
  "reviewer": "alex.architect",
  "comment": "Stream the rows instead of loading the whole month into memory."
}
```

**Response `200 OK`**: The decision was recorded.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `initiative` | object | yes | The initiative after the status change. |
| `initiative.id` | string (uuid) | yes |  |
| `initiative.title` | string | yes | Short name shown in lists. (1–200 chars) |
| `initiative.businessRequirement` | string | yes | The source requirement, as written by Product. Treated as untrusted text by the agents. (1–20000 chars) |
| `initiative.acceptanceCriteria` | object[] | yes | (at least 1 item) |
| `initiative.acceptanceCriteria[].id` | string | yes | Reference id, unique within the initiative. Tasks and requirements cite it. (pattern `^AC-[1-9]\d*$`) |
| `initiative.acceptanceCriteria[].text` | string | yes | The criterion, in plain language. (1–2000 chars) |
| `initiative.caseType` | `"A"` \| `"B"` | yes | "A" builds something new with no repo context; "B" adds a feature to an existing, indexed repo. |
| `initiative.repoId` | string | no | Id of the registered repo. Always present for Case B; usually absent for Case A. (non-empty) |
| `initiative.status` | `"READY_FOR_SPEC"` \| `"REQUIREMENT_GENERATING"` \| `"REQUIREMENT_REVIEW"` \| `"REQUIREMENT_REVIEWED"` \| `"SPEC_APPROVED"` \| `"DESIGN_GENERATING"` \| `"DESIGN_REVIEW"` \| `"DESIGN_REVISION_REQUESTED"` \| `"DESIGN_APPROVED"` \| `"TASKS_GENERATING"` \| `"READY_FOR_DEVELOPMENT"` \| `"IN_DEVELOPMENT"` \| `"DONE"` | yes | Current workflow status. Only the orchestrator changes it. |
| `initiative.createdAt` | string (ISO 8601 UTC) | yes |  |
| `initiative.updatedAt` | string (ISO 8601 UTC) | yes |  |
| `approval` | object | yes | The decision that was recorded. |
| `approval.id` | string (uuid) | yes |  |
| `approval.initiativeId` | string (uuid) | yes |  |
| `approval.stage` | `"requirements"` \| `"design"` | yes | "requirements" is decided by Product, "design" by Architecture. |
| `approval.decision` | `"approved"` \| `"changes_requested"` | yes |  |
| `approval.reviewer` | string | yes | Who decided. A free-form identifier until real auth exists. (1–200 chars) |
| `approval.comment` | string | yes | Empty string when the reviewer gave no comment. (0–20000 chars) |
| `approval.artifactVersion` | integer | yes | The artifact version the decision applies to. (at least 1) |
| `approval.createdAt` | string (ISO 8601 UTC) | yes |  |

```json
{
  "initiative": {
    "id": "3f2b8c1e-5a7d-4e29-9c4b-1d6e8f0a2b34",
    "title": "Invoice CSV export",
    "businessRequirement": "Finance needs to export a month of invoices as a CSV file so they can reconcile them in a spreadsheet.",
    "acceptanceCriteria": [
      {
        "id": "AC-1",
        "text": "A CSV with one row per invoice downloads in under 5 seconds for a month of data."
      },
      {
        "id": "AC-2",
        "text": "Only users with the finance role can export."
      }
    ],
    "caseType": "B",
    "repoId": "billing-service",
    "status": "DESIGN_GENERATING",
    "createdAt": "2026-10-21T09:30:00.000Z",
    "updatedAt": "2026-10-21T09:31:12.000Z"
  },
  "approval": {
    "id": "0a5c9e1b-7d3f-4b48-a2c6-8f4e0d1a6b73",
    "initiativeId": "3f2b8c1e-5a7d-4e29-9c4b-1d6e8f0a2b34",
    "stage": "design",
    "decision": "changes_requested",
    "reviewer": "alex.architect",
    "comment": "Stream the rows instead of loading the whole month into memory.",
    "artifactVersion": 1,
    "createdAt": "2026-10-21T10:05:40.000Z"
  }
}
```

**Errors**

| Status | `error.code` | When |
| --- | --- | --- |
| 400 | `validation_error` | The request body, query or path parameter does not match the schema. `details` lists the Zod issues. |
| 404 | `not_found` | No initiative with this id. |
| 409 | `invalid_transition` | The initiative is not waiting for a decision at this `stage` (wrong status). |
| 500 | `internal_error` | Unexpected server error. |

### List the decisions recorded for an initiative

`GET /api/initiatives/:id/approvals`

Oldest first. Includes approvals and change requests for both stages.

Example request line: `GET /api/initiatives/3f2b8c1e-5a7d-4e29-9c4b-1d6e8f0a2b34/approvals`

**Path parameters**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string (uuid) | yes | Initiative id. |

**Response `200 OK`**: The recorded decisions.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `items` | object[] | yes |  |
| `items[].id` | string (uuid) | yes |  |
| `items[].initiativeId` | string (uuid) | yes |  |
| `items[].stage` | `"requirements"` \| `"design"` | yes | "requirements" is decided by Product, "design" by Architecture. |
| `items[].decision` | `"approved"` \| `"changes_requested"` | yes |  |
| `items[].reviewer` | string | yes | Who decided. A free-form identifier until real auth exists. (1–200 chars) |
| `items[].comment` | string | yes | Empty string when the reviewer gave no comment. (0–20000 chars) |
| `items[].artifactVersion` | integer | yes | The artifact version the decision applies to. (at least 1) |
| `items[].createdAt` | string (ISO 8601 UTC) | yes |  |

```json
{
  "items": [
    {
      "id": "f4b8d0a2-6c1e-4a35-8d9f-3e7a5c2b1f90",
      "initiativeId": "3f2b8c1e-5a7d-4e29-9c4b-1d6e8f0a2b34",
      "stage": "requirements",
      "decision": "approved",
      "reviewer": "priya.product",
      "comment": "Looks complete.",
      "artifactVersion": 1,
      "createdAt": "2026-10-21T10:05:40.000Z"
    },
    {
      "id": "0a5c9e1b-7d3f-4b48-a2c6-8f4e0d1a6b73",
      "initiativeId": "3f2b8c1e-5a7d-4e29-9c4b-1d6e8f0a2b34",
      "stage": "design",
      "decision": "changes_requested",
      "reviewer": "alex.architect",
      "comment": "Stream the rows instead of loading the whole month into memory.",
      "artifactVersion": 1,
      "createdAt": "2026-10-21T10:05:40.000Z"
    }
  ]
}
```

**Errors**

| Status | `error.code` | When |
| --- | --- | --- |
| 400 | `validation_error` | The path parameter is not a valid id. |
| 404 | `not_found` | No initiative with this id. |
| 500 | `internal_error` | Unexpected server error. |

## Agent runs

### List agent runs and their cost

`GET /api/initiatives/:id/runs`

One row per model call (including critics), oldest first, with token and cost totals for the initiative.

Example request line: `GET /api/initiatives/3f2b8c1e-5a7d-4e29-9c4b-1d6e8f0a2b34/runs`

**Path parameters**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string (uuid) | yes | Initiative id. |

**Response `200 OK`**: The runs and their totals.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `items` | object[] | yes | Oldest first. |
| `items[].id` | string (uuid) | yes |  |
| `items[].initiativeId` | string (uuid) | no | Absent for runs not tied to an initiative, such as indexing a repo. |
| `items[].agent` | `"requirement"` \| `"requirement_critic"` \| `"design"` \| `"design_critic"` \| `"task"` \| `"context"` | yes |  |
| `items[].model` | string | yes | Model id the call was made with. (non-empty) |
| `items[].inputTokens` | integer | yes | (at least 0) |
| `items[].outputTokens` | integer | yes | (at least 0) |
| `items[].costUsd` | number | yes | Estimated cost in US dollars, from the versioned price table. (at least 0) |
| `items[].latencyMs` | integer | yes | (at least 0) |
| `items[].status` | `"succeeded"` \| `"failed"` | yes | The row is written after the call finishes, so there is no running state. |
| `items[].error` | string | no | Present when status is failed. (0–2000 chars) |
| `items[].createdAt` | string (ISO 8601 UTC) | yes |  |
| `totals` | object | yes |  |
| `totals.inputTokens` | integer | yes | (at least 0) |
| `totals.outputTokens` | integer | yes | (at least 0) |
| `totals.costUsd` | number | yes | (at least 0) |

```json
{
  "items": [
    {
      "id": "1b6d0f2c-8e4a-4c59-b3d7-9a5f1e2c7d04",
      "initiativeId": "3f2b8c1e-5a7d-4e29-9c4b-1d6e8f0a2b34",
      "agent": "requirement",
      "model": "claude-sonnet-5-5",
      "inputTokens": 5200,
      "outputTokens": 1400,
      "costUsd": 0.0366,
      "latencyMs": 9100,
      "status": "succeeded",
      "createdAt": "2026-10-21T09:31:12.000Z"
    },
    {
      "id": "3d8f2b4e-0a6c-4e7b-95f9-1c7b3a4e9f26",
      "initiativeId": "3f2b8c1e-5a7d-4e29-9c4b-1d6e8f0a2b34",
      "agent": "requirement_critic",
      "model": "claude-sonnet-5-5",
      "inputTokens": 2100,
      "outputTokens": 300,
      "costUsd": 0.0108,
      "latencyMs": 3400,
      "status": "succeeded",
      "createdAt": "2026-10-21T09:31:12.000Z"
    }
  ],
  "totals": {
    "inputTokens": 7300,
    "outputTokens": 1700,
    "costUsd": 0.0474
  }
}
```

**Errors**

| Status | `error.code` | When |
| --- | --- | --- |
| 400 | `validation_error` | The path parameter is not a valid id. |
| 404 | `not_found` | No initiative with this id. |
| 500 | `internal_error` | Unexpected server error. |

## Repos

### Register a repo and profile it

`POST /api/repos`

Registers a repo (cloning it first when `source.type` is `url`) and starts the profiler in the background. The response has status `profiling`; poll `GET /api/repos/:id` until it is `profiled`.
The profile recommends a strategy (`full` or `claude-md-only`, scope section 6.1). Indexing is a separate call.

**Request body**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | yes | Display name. The repo id is derived from it as a slug. (1–200 chars) |
| `source` | object (one of) | yes |  |
| `source{type="path"}.type` | `"path"` | yes |  |
| `source{type="path"}.value` | string | yes | Absolute path to a local checkout. For local development only. (non-empty) |
| `source{type="url"}.type` | `"url"` | yes |  |
| `source{type="url"}.value` | string (URL) | yes | Git clone URL. The repo is cloned into the server's cache directory. |

```json
{
  "name": "billing-service",
  "source": {
    "type": "url",
    "value": "https://github.com/example-org/billing-service.git"
  }
}
```

**Response `202 Accepted`**: The repo was registered and profiling has started.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | Slug derived from the name. This is the value initiatives use as `repoId`. (pattern `^[a-z0-9][a-z0-9._-]{0,62}$`) |
| `name` | string | yes | (1–200 chars) |
| `source` | object (one of) | yes |  |
| `source{type="path"}.type` | `"path"` | yes |  |
| `source{type="path"}.value` | string | yes | Absolute path to a local checkout. For local development only. (non-empty) |
| `source{type="url"}.type` | `"url"` | yes |  |
| `source{type="url"}.value` | string (URL) | yes | Git clone URL. The repo is cloned into the server's cache directory. |
| `status` | `"profiling"` \| `"profiled"` \| `"indexing"` \| `"indexed"` \| `"failed"` | yes | profiling: being analysed. profiled: ready to index. indexing: index running. indexed: ready for Case B. failed: see `error`. |
| `profile` | object or null | yes | Null until profiling finishes. |
| `profile.totalFiles` | integer | yes | (at least 0) |
| `profile.totalLoc` | integer | yes | (at least 0) |
| `profile.languages` | object[] | yes |  |
| `profile.languages[].language` | string | yes | (non-empty) |
| `profile.languages[].files` | integer | yes | (at least 0) |
| `profile.languages[].loc` | integer | yes | Non-empty lines of code. (at least 0) |
| `profile.recommendation` | `"full"` \| `"claude-md-only"` | yes |  |
| `profile.reason` | string | yes | Why this strategy was recommended, quoting the thresholds that applied. |
| `indexStrategy` | `"full"` \| `"claude-md-only"` or null | yes | The strategy the last index run used. Null before the first run. |
| `indexedCommitSha` | any | yes | Commit the current index was built from. Null before the first successful run. |
| `indexedAt` | string (ISO 8601 UTC) or null | yes |  |
| `error` | string | no | Present when status is failed. |
| `createdAt` | string (ISO 8601 UTC) | yes |  |
| `updatedAt` | string (ISO 8601 UTC) | yes |  |

```json
{
  "id": "billing-service",
  "name": "billing-service",
  "source": {
    "type": "url",
    "value": "https://github.com/example-org/billing-service.git"
  },
  "status": "profiling",
  "profile": null,
  "indexStrategy": null,
  "indexedCommitSha": null,
  "indexedAt": null,
  "createdAt": "2026-10-21T09:30:00.000Z",
  "updatedAt": "2026-10-21T10:05:40.000Z"
}
```

**Errors**

| Status | `error.code` | When |
| --- | --- | --- |
| 400 | `validation_error` | The request body, query or path parameter does not match the schema. `details` lists the Zod issues. |
| 409 | `conflict` | A repo with the same id (slug of the name) is already registered. |
| 500 | `internal_error` | Unexpected server error. |

### List registered repos

`GET /api/repos`

Newest first.

**Response `200 OK`**: The registered repos.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `items` | object[] | yes |  |
| `items[].id` | string | yes | Slug derived from the name. This is the value initiatives use as `repoId`. (pattern `^[a-z0-9][a-z0-9._-]{0,62}$`) |
| `items[].name` | string | yes | (1–200 chars) |
| `items[].source` | object (one of) | yes |  |
| `items[].source{type="path"}.type` | `"path"` | yes |  |
| `items[].source{type="path"}.value` | string | yes | Absolute path to a local checkout. For local development only. (non-empty) |
| `items[].source{type="url"}.type` | `"url"` | yes |  |
| `items[].source{type="url"}.value` | string (URL) | yes | Git clone URL. The repo is cloned into the server's cache directory. |
| `items[].status` | `"profiling"` \| `"profiled"` \| `"indexing"` \| `"indexed"` \| `"failed"` | yes | profiling: being analysed. profiled: ready to index. indexing: index running. indexed: ready for Case B. failed: see `error`. |
| `items[].profile` | object or null | yes | Null until profiling finishes. |
| `items[].profile.totalFiles` | integer | yes | (at least 0) |
| `items[].profile.totalLoc` | integer | yes | (at least 0) |
| `items[].profile.languages` | object[] | yes |  |
| `items[].profile.languages[].language` | string | yes | (non-empty) |
| `items[].profile.languages[].files` | integer | yes | (at least 0) |
| `items[].profile.languages[].loc` | integer | yes | Non-empty lines of code. (at least 0) |
| `items[].profile.recommendation` | `"full"` \| `"claude-md-only"` | yes |  |
| `items[].profile.reason` | string | yes | Why this strategy was recommended, quoting the thresholds that applied. |
| `items[].indexStrategy` | `"full"` \| `"claude-md-only"` or null | yes | The strategy the last index run used. Null before the first run. |
| `items[].indexedCommitSha` | any | yes | Commit the current index was built from. Null before the first successful run. |
| `items[].indexedAt` | string (ISO 8601 UTC) or null | yes |  |
| `items[].error` | string | no | Present when status is failed. |
| `items[].createdAt` | string (ISO 8601 UTC) | yes |  |
| `items[].updatedAt` | string (ISO 8601 UTC) | yes |  |

```json
{
  "items": [
    {
      "id": "billing-service",
      "name": "billing-service",
      "source": {
        "type": "url",
        "value": "https://github.com/example-org/billing-service.git"
      },
      "status": "indexed",
      "profile": {
        "totalFiles": 1240,
        "totalLoc": 96500,
        "languages": [
          {
            "language": "Java",
            "files": 830,
            "loc": 71000
          },
          {
            "language": "TypeScript",
            "files": 410,
            "loc": 25500
          }
        ],
        "recommendation": "full",
        "reason": "1240 source files is at or above the 1000 file threshold for the full pipeline."
      },
      "indexStrategy": "full",
      "indexedCommitSha": "9fceb02d0ae598e95dc970b74767f19372d61af8",
      "indexedAt": "2026-10-21T10:05:40.000Z",
      "createdAt": "2026-10-21T09:30:00.000Z",
      "updatedAt": "2026-10-21T10:05:40.000Z"
    }
  ]
}
```

**Errors**

| Status | `error.code` | When |
| --- | --- | --- |
| 500 | `internal_error` | Unexpected server error. |

### Get a repo

`GET /api/repos/:id`

Use this to poll while the status is `profiling` or `indexing`.

Example request line: `GET /api/repos/billing-service`

**Path parameters**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | Repo id (slug). (pattern `^[a-z0-9][a-z0-9._-]{0,62}$`) |

**Response `200 OK`**: The repo, with its profile and index state.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | Slug derived from the name. This is the value initiatives use as `repoId`. (pattern `^[a-z0-9][a-z0-9._-]{0,62}$`) |
| `name` | string | yes | (1–200 chars) |
| `source` | object (one of) | yes |  |
| `source{type="path"}.type` | `"path"` | yes |  |
| `source{type="path"}.value` | string | yes | Absolute path to a local checkout. For local development only. (non-empty) |
| `source{type="url"}.type` | `"url"` | yes |  |
| `source{type="url"}.value` | string (URL) | yes | Git clone URL. The repo is cloned into the server's cache directory. |
| `status` | `"profiling"` \| `"profiled"` \| `"indexing"` \| `"indexed"` \| `"failed"` | yes | profiling: being analysed. profiled: ready to index. indexing: index running. indexed: ready for Case B. failed: see `error`. |
| `profile` | object or null | yes | Null until profiling finishes. |
| `profile.totalFiles` | integer | yes | (at least 0) |
| `profile.totalLoc` | integer | yes | (at least 0) |
| `profile.languages` | object[] | yes |  |
| `profile.languages[].language` | string | yes | (non-empty) |
| `profile.languages[].files` | integer | yes | (at least 0) |
| `profile.languages[].loc` | integer | yes | Non-empty lines of code. (at least 0) |
| `profile.recommendation` | `"full"` \| `"claude-md-only"` | yes |  |
| `profile.reason` | string | yes | Why this strategy was recommended, quoting the thresholds that applied. |
| `indexStrategy` | `"full"` \| `"claude-md-only"` or null | yes | The strategy the last index run used. Null before the first run. |
| `indexedCommitSha` | any | yes | Commit the current index was built from. Null before the first successful run. |
| `indexedAt` | string (ISO 8601 UTC) or null | yes |  |
| `error` | string | no | Present when status is failed. |
| `createdAt` | string (ISO 8601 UTC) | yes |  |
| `updatedAt` | string (ISO 8601 UTC) | yes |  |

```json
{
  "id": "billing-service",
  "name": "billing-service",
  "source": {
    "type": "url",
    "value": "https://github.com/example-org/billing-service.git"
  },
  "status": "indexed",
  "profile": {
    "totalFiles": 1240,
    "totalLoc": 96500,
    "languages": [
      {
        "language": "Java",
        "files": 830,
        "loc": 71000
      },
      {
        "language": "TypeScript",
        "files": 410,
        "loc": 25500
      }
    ],
    "recommendation": "full",
    "reason": "1240 source files is at or above the 1000 file threshold for the full pipeline."
  },
  "indexStrategy": "full",
  "indexedCommitSha": "9fceb02d0ae598e95dc970b74767f19372d61af8",
  "indexedAt": "2026-10-21T10:05:40.000Z",
  "createdAt": "2026-10-21T09:30:00.000Z",
  "updatedAt": "2026-10-21T10:05:40.000Z"
}
```

**Errors**

| Status | `error.code` | When |
| --- | --- | --- |
| 400 | `validation_error` | The path parameter is not a valid id. |
| 404 | `not_found` | No repo with this id. |
| 500 | `internal_error` | Unexpected server error. |

### Index a repo

`POST /api/repos/:id/index`

Starts indexing in the background and returns status `indexing`; poll `GET /api/repos/:id` until it is `indexed`.
`strategy` defaults to the profile's recommendation. Allowed when the status is `profiled`, `indexed` or `failed`; a repo whose profiling failed is profiled again first. Re-indexing an `indexed` repo refreshes it (a repo registered by URL is pulled first); the previous index stays in place until the new one succeeds.

Example request line: `POST /api/repos/billing-service/index`

**Path parameters**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | Repo id (slug). (pattern `^[a-z0-9][a-z0-9._-]{0,62}$`) |

**Request body**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `strategy` | `"full"` \| `"claude-md-only"` | no | Defaults to the profile's recommendation. |

```json
{
  "strategy": "full"
}
```

**Response `202 Accepted`**: Indexing has started.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | Slug derived from the name. This is the value initiatives use as `repoId`. (pattern `^[a-z0-9][a-z0-9._-]{0,62}$`) |
| `name` | string | yes | (1–200 chars) |
| `source` | object (one of) | yes |  |
| `source{type="path"}.type` | `"path"` | yes |  |
| `source{type="path"}.value` | string | yes | Absolute path to a local checkout. For local development only. (non-empty) |
| `source{type="url"}.type` | `"url"` | yes |  |
| `source{type="url"}.value` | string (URL) | yes | Git clone URL. The repo is cloned into the server's cache directory. |
| `status` | `"profiling"` \| `"profiled"` \| `"indexing"` \| `"indexed"` \| `"failed"` | yes | profiling: being analysed. profiled: ready to index. indexing: index running. indexed: ready for Case B. failed: see `error`. |
| `profile` | object or null | yes | Null until profiling finishes. |
| `profile.totalFiles` | integer | yes | (at least 0) |
| `profile.totalLoc` | integer | yes | (at least 0) |
| `profile.languages` | object[] | yes |  |
| `profile.languages[].language` | string | yes | (non-empty) |
| `profile.languages[].files` | integer | yes | (at least 0) |
| `profile.languages[].loc` | integer | yes | Non-empty lines of code. (at least 0) |
| `profile.recommendation` | `"full"` \| `"claude-md-only"` | yes |  |
| `profile.reason` | string | yes | Why this strategy was recommended, quoting the thresholds that applied. |
| `indexStrategy` | `"full"` \| `"claude-md-only"` or null | yes | The strategy the last index run used. Null before the first run. |
| `indexedCommitSha` | any | yes | Commit the current index was built from. Null before the first successful run. |
| `indexedAt` | string (ISO 8601 UTC) or null | yes |  |
| `error` | string | no | Present when status is failed. |
| `createdAt` | string (ISO 8601 UTC) | yes |  |
| `updatedAt` | string (ISO 8601 UTC) | yes |  |

```json
{
  "id": "billing-service",
  "name": "billing-service",
  "source": {
    "type": "url",
    "value": "https://github.com/example-org/billing-service.git"
  },
  "status": "indexing",
  "profile": {
    "totalFiles": 1240,
    "totalLoc": 96500,
    "languages": [
      {
        "language": "Java",
        "files": 830,
        "loc": 71000
      },
      {
        "language": "TypeScript",
        "files": 410,
        "loc": 25500
      }
    ],
    "recommendation": "full",
    "reason": "1240 source files is at or above the 1000 file threshold for the full pipeline."
  },
  "indexStrategy": "full",
  "indexedCommitSha": null,
  "indexedAt": null,
  "createdAt": "2026-10-21T09:30:00.000Z",
  "updatedAt": "2026-10-21T10:05:40.000Z"
}
```

**Errors**

| Status | `error.code` | When |
| --- | --- | --- |
| 400 | `validation_error` | The request body, query or path parameter does not match the schema. `details` lists the Zod issues. |
| 404 | `not_found` | No repo with this id. |
| 409 | `conflict` | The repo is still being profiled or is already being indexed. |
| 500 | `internal_error` | Unexpected server error. |

