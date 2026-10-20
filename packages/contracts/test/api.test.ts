import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  API,
  ApproveRequestSchema,
  CreateInitiativeRequestSchema,
  ENDPOINTS,
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  ErrorResponseSchema,
  IndexRepoRequestSchema,
  ListInitiativesQuerySchema,
  RegisterRepoRequestSchema,
  RepoSchema,
  RequestChangesRequestSchema,
  REPO_STATUSES,
  SubmitAnswersRequestSchema,
  assertExamplesValid,
  exampleRepo,
  renderApiDocs,
  type EndpointDef,
} from "../src";

const DOC = path.resolve(import.meta.dirname, "../../../docs/API.md");

describe("endpoint registry", () => {
  it("is keyed by endpoint id", () => {
    for (const [key, def] of Object.entries(API)) expect(def.id).toBe(key);
    expect(ENDPOINTS).toHaveLength(Object.keys(API).length);
  });

  it("has unique method + path pairs", () => {
    const keys = ENDPOINTS.map((e) => `${e.method} ${e.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("covers every endpoint the project needs", () => {
    const have = new Set(ENDPOINTS.map((e) => `${e.method} ${e.path}`));
    for (const needed of [
      "GET /api/health",
      "POST /api/initiatives",
      "GET /api/initiatives",
      "GET /api/initiatives/:id",
      "GET /api/initiatives/:id/artifacts",
      "GET /api/initiatives/:id/artifacts/:kind",
      "GET /api/initiatives/:id/questions",
      "POST /api/initiatives/:id/answers",
      "POST /api/initiatives/:id/approve",
      "POST /api/initiatives/:id/request-changes",
      "GET /api/initiatives/:id/runs",
      "POST /api/repos",
      "POST /api/repos/:id/index",
    ]) {
      expect(have, needed).toContain(needed);
    }
  });

  it.each(ENDPOINTS.map((e) => [e.id, e] as const))("%s is well formed", (_id, e: EndpointDef) => {
    expect(e.path.startsWith("/api/")).toBe(true);
    expect(e.responses.length).toBeGreaterThan(0);
    for (const r of e.responses) expect(r.status).toBeGreaterThanOrEqual(200);
    for (const r of e.responses) expect(r.status).toBeLessThan(300);
    if (e.method === "GET") expect(e.body, "GET must not have a body").toBeUndefined();

    // path placeholders and the params schema describe exactly the same names
    const placeholders = [...e.path.matchAll(/:(\w+)/g)].map((m) => m[1]).sort();
    const declared = Object.keys((e.params?.example ?? {}) as object).sort();
    expect(declared).toEqual(placeholders);

    // every error row uses the HTTP status that belongs to its code
    for (const err of e.errors) expect(err.status).toBe(ERROR_HTTP_STATUS[err.code]);

    // anything that parses input must document the 400
    if (e.params || e.query || e.body) expect(e.errors.some((x) => x.code === "validation_error")).toBe(true);
    // anything that looks an initiative or repo up documents the 404
    if (e.path.includes(":id")) expect(e.errors.some((x) => x.code === "not_found")).toBe(true);
  });

  it("has examples that parse against their own schemas", () => {
    expect(() => assertExamplesValid()).not.toThrow();
  });

  it("rejects an example that does not match its schema", () => {
    const broken: EndpointDef = { ...API.getInitiative, responses: [{ ...API.getInitiative.responses[0], example: { id: "not-a-uuid" } }] };
    expect(() => assertExamplesValid([broken])).toThrow(/Invalid example for getInitiative response 200/);
  });
});

describe("request schemas", () => {
  const base = {
    title: "T",
    businessRequirement: "R",
    acceptanceCriteria: ["one"],
    caseType: "A" as const,
  };

  it("create initiative: Case A needs no repo, Case B does", () => {
    expect(CreateInitiativeRequestSchema.safeParse(base).success).toBe(true);
    expect(CreateInitiativeRequestSchema.safeParse({ ...base, caseType: "B" }).success).toBe(false);
    const withRepo = CreateInitiativeRequestSchema.safeParse({ ...base, caseType: "B", repoId: "billing-service" });
    expect(withRepo.success).toBe(true);
  });

  it("create initiative: reports the missing repoId on the right path", () => {
    const result = CreateInitiativeRequestSchema.safeParse({ ...base, caseType: "B" });
    expect(result.success ? [] : result.error.issues.map((i) => i.path.join("."))).toEqual(["repoId"]);
  });

  it.each([
    ["no criteria", { acceptanceCriteria: [] }],
    ["blank criterion", { acceptanceCriteria: [""] }],
    ["empty title", { title: "" }],
    ["unknown case", { caseType: "C" }],
    ["uppercase repo id", { repoId: "Billing" }],
    ["oversize requirement", { businessRequirement: "x".repeat(20_001) }],
  ])("create initiative rejects %s", (_n, patch) => {
    expect(CreateInitiativeRequestSchema.safeParse({ ...base, ...patch }).success).toBe(false);
  });

  it("list query: applies defaults, coerces numbers and caps the page size", () => {
    expect(ListInitiativesQuerySchema.parse({})).toEqual({ limit: 50, offset: 0 });
    expect(ListInitiativesQuerySchema.parse({ limit: "20", offset: "40", status: "DONE" })).toEqual({
      limit: 20,
      offset: 40,
      status: "DONE",
    });
    expect(ListInitiativesQuerySchema.safeParse({ limit: "500" }).success).toBe(false);
    expect(ListInitiativesQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(ListInitiativesQuerySchema.safeParse({ status: "SPEC_REVIEW" }).success).toBe(false);
  });

  it("answers: at least one answer, each non-empty with a uuid", () => {
    const id = "a1c4e7b2-8d3f-4a56-b2c9-5e0f1a7d3c68";
    expect(SubmitAnswersRequestSchema.safeParse({ answers: [{ questionId: id, answer: "yes" }] }).success).toBe(true);
    expect(SubmitAnswersRequestSchema.safeParse({ answers: [] }).success).toBe(false);
    expect(SubmitAnswersRequestSchema.safeParse({ answers: [{ questionId: id, answer: "" }] }).success).toBe(false);
    expect(SubmitAnswersRequestSchema.safeParse({ answers: [{ questionId: "1", answer: "yes" }] }).success).toBe(false);
  });

  it("approve: comment is optional and defaults to empty", () => {
    expect(ApproveRequestSchema.parse({ stage: "design", reviewer: "a" })).toEqual({ stage: "design", reviewer: "a", comment: "" });
    expect(ApproveRequestSchema.safeParse({ stage: "tasks", reviewer: "a" }).success).toBe(false);
    expect(ApproveRequestSchema.safeParse({ stage: "design", reviewer: "" }).success).toBe(false);
  });

  it("request changes: a comment is required", () => {
    expect(RequestChangesRequestSchema.safeParse({ stage: "design", reviewer: "a" }).success).toBe(false);
    expect(RequestChangesRequestSchema.safeParse({ stage: "design", reviewer: "a", comment: "" }).success).toBe(false);
    expect(RequestChangesRequestSchema.safeParse({ stage: "design", reviewer: "a", comment: "fix" }).success).toBe(true);
  });

  it("register repo: accepts a path or a URL source, rejects anything else", () => {
    expect(RegisterRepoRequestSchema.safeParse({ name: "r", source: { type: "path", value: "/work/r" } }).success).toBe(true);
    expect(RegisterRepoRequestSchema.safeParse({ name: "r", source: { type: "url", value: "https://example.com/r.git" } }).success).toBe(
      true,
    );
    expect(RegisterRepoRequestSchema.safeParse({ name: "r", source: { type: "url", value: "not a url" } }).success).toBe(false);
    expect(RegisterRepoRequestSchema.safeParse({ name: "r", source: { type: "ftp", value: "x" } }).success).toBe(false);
  });

  it("index repo: the body may be empty, strategy must be a known value", () => {
    expect(IndexRepoRequestSchema.safeParse({}).success).toBe(true);
    expect(IndexRepoRequestSchema.safeParse({ strategy: "claude-md-only" }).success).toBe(true);
    expect(IndexRepoRequestSchema.safeParse({ strategy: "everything" }).success).toBe(false);
  });
});

describe("responses and shared shapes", () => {
  it("the error envelope accepts every code and rejects an unknown one", () => {
    for (const code of ERROR_CODES) expect(ErrorResponseSchema.safeParse({ error: { code, message: "x" } }).success).toBe(true);
    expect(ErrorResponseSchema.safeParse({ error: { code: "teapot", message: "x" } }).success).toBe(false);
    expect(ErrorResponseSchema.safeParse({ error: { code: "not_found" } }).success).toBe(false);
  });

  it("a repo example is valid in every status", () => {
    for (const status of REPO_STATUSES) expect(RepoSchema.safeParse(exampleRepo(status)).success, status).toBe(true);
  });

  it("an unprofiled repo has no profile and an unindexed repo has no commit", () => {
    expect(exampleRepo("profiling").profile).toBeNull();
    expect(exampleRepo("profiled").indexedCommitSha).toBeNull();
  });
});

describe("docs/API.md", () => {
  const rendered = renderApiDocs();

  it("is up to date with the schemas (run `pnpm docs:api` after changing them)", () => {
    const onDisk = fs.readFileSync(DOC, "utf8").replace(/\r\n/g, "\n");
    expect(onDisk).toBe(rendered);
  });

  it("is deterministic", () => {
    expect(renderApiDocs()).toBe(rendered);
  });

  it("detects drift: changing a schema description changes the output", () => {
    const changed: EndpointDef[] = ENDPOINTS.map((e) => (e.id === "health" ? { ...e, summary: "A different summary" } : e));
    expect(renderApiDocs(changed)).not.toBe(rendered);
  });

  it("documents every endpoint with its example JSON and error table", () => {
    for (const e of ENDPOINTS) {
      expect(rendered, e.id).toContain(`\`${e.method} ${e.path}\``);
      for (const r of e.responses) expect(rendered).toContain(JSON.stringify(r.example, null, 2).split("\n")[1]);
    }
    expect(rendered.match(/\*\*Errors\*\*/g)).toHaveLength(ENDPOINTS.length);
  });

  it("lists every legal transition in the status model", () => {
    expect(rendered).toContain("`REQUIREMENT_REVIEWED` | `SPEC_APPROVED` | product");
    expect(rendered).toContain("`DESIGN_REVIEW` | `DESIGN_APPROVED` | architecture");
  });

  it("has well-formed tables: every row of a table has the same number of columns", () => {
    const lines = rendered.split("\n");
    let width: number | null = null;
    let inFence = false;
    for (const line of lines) {
      if (line.startsWith("```")) inFence = !inFence;
      if (inFence) continue;
      if (line.startsWith("|")) {
        const cells = line.replace(/\\\|/g, "").split("|").length - 2;
        if (width === null) width = cells;
        expect(cells, line).toBe(width);
      } else {
        width = null;
      }
    }
  });

  it("never leaks the safe-integer bound or a doubled period into the notes", () => {
    expect(rendered).not.toContain("9007199254740991");
    expect(rendered).not.toMatch(/\w\.\.(?!\.)/);
  });
});
