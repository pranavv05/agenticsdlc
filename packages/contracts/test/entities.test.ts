import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AgentRunSchema,
  ApprovalSchema,
  ArtifactSchema,
  ClarificationQuestionSchema,
  ContextBundleSchema,
  DesignSchema,
  EMPTY_CONTEXT_BUNDLE,
  InitiativeSchema,
  RequirementSchema,
  TaskSchema,
  TasksArtifactSchema,
  findTaskCycle,
} from "../src";

const ID = "550e8400-e29b-41d4-a716-446655440000";
const ID2 = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const NOW = "2026-10-20T10:00:00.000Z";

const initiative = {
  id: ID,
  title: "Invoice export",
  businessRequirement: "Finance needs to export invoices as CSV.",
  acceptanceCriteria: [{ id: "AC-1", text: "A CSV with one row per invoice downloads in under 5 seconds." }],
  caseType: "B",
  repoId: "billing-service",
  status: "READY_FOR_SPEC",
  createdAt: NOW,
  updatedAt: NOW,
};

const base = { id: ID, initiativeId: ID2, version: 1, needsHumanMerge: false, createdAt: NOW };

const requirement = {
  ...base,
  kind: "requirements",
  markdown: "# Requirements",
  content: {
    summary: "Export invoices.",
    functionalRequirements: [{ id: "FR-1", statement: "The system exports invoices as CSV.", acceptanceCriterionRefs: ["AC-1"] }],
    nonFunctionalRequirements: [{ id: "NFR-1", statement: "Export completes in 5 seconds." }],
    assumptions: [],
    outOfScope: ["PDF export"],
  },
};

const design = {
  ...base,
  kind: "design",
  markdown: "# Design",
  content: {
    overview: "Add an export endpoint.",
    sections: [{ id: "DS-1", title: "Export endpoint", body: "Add a route.", referencedPaths: ["src/billing/invoice.ts"] }],
    risks: [],
  },
  grounding: { checkedPaths: ["src/billing/invoice.ts"], missingPaths: [], checkedAt: NOW },
};

const task = (id: string, dependsOn: string[] = []) => ({
  id,
  title: `Task ${id}`,
  description: "Do the thing.",
  designSectionRef: "DS-1",
  acceptanceCriterionRefs: ["AC-1"],
  dependsOn,
  status: "todo",
});

const tasks = { ...base, kind: "tasks", markdown: "# Tasks", content: { tasks: [task("T-1"), task("T-2", ["T-1"])] } };

describe("Initiative", () => {
  it("accepts a valid Case B initiative", () => {
    expect(InitiativeSchema.parse(initiative)).toEqual(initiative);
  });

  it("accepts a Case A initiative without repoId", () => {
    const { repoId: _repoId, ...caseA } = { ...initiative, caseType: "A" };
    expect(InitiativeSchema.safeParse(caseA).success).toBe(true);
  });

  it.each([
    ["no acceptance criteria", { acceptanceCriteria: [] }],
    ["bad criterion id", { acceptanceCriteria: [{ id: "1", text: "x" }] }],
    ["unknown case type", { caseType: "C" }],
    ["unknown status", { status: "SPEC_REVIEW" }],
    ["empty title", { title: "" }],
    ["non-uuid id", { id: "abc" }],
    ["date without time", { createdAt: "2026-10-20" }],
    ["oversize requirement", { businessRequirement: "x".repeat(20_001) }],
  ])("rejects %s", (_name, patch) => {
    expect(InitiativeSchema.safeParse({ ...initiative, ...patch }).success).toBe(false);
  });
});

describe("artifacts", () => {
  it("parses a requirement, a design and a tasks artifact", () => {
    expect(RequirementSchema.safeParse(requirement).success).toBe(true);
    expect(DesignSchema.safeParse(design).success).toBe(true);
    expect(TasksArtifactSchema.safeParse(tasks).success).toBe(true);
  });

  it("discriminates the union on kind", () => {
    expect(ArtifactSchema.parse(design).kind).toBe("design");
    expect(ArtifactSchema.safeParse({ ...design, kind: "tasks" }).success).toBe(false);
    expect(ArtifactSchema.safeParse({ ...design, kind: "other" }).success).toBe(false);
  });

  it("allows a null grounding result (Case A) but requires the field", () => {
    expect(DesignSchema.safeParse({ ...design, grounding: null }).success).toBe(true);
    const { grounding: _g, ...noGrounding } = design;
    expect(DesignSchema.safeParse(noGrounding).success).toBe(false);
  });

  it("rejects a version below 1 and a bad reference id", () => {
    expect(RequirementSchema.safeParse({ ...requirement, version: 0 }).success).toBe(false);
    const bad = structuredClone(requirement);
    bad.content.functionalRequirements[0].acceptanceCriterionRefs = ["criterion-1"];
    expect(RequirementSchema.safeParse(bad).success).toBe(false);
  });
});

describe("Task", () => {
  it("requires a design section ref and at least one acceptance criterion ref", () => {
    expect(TaskSchema.safeParse(task("T-1")).success).toBe(true);
    expect(TaskSchema.safeParse({ ...task("T-1"), acceptanceCriterionRefs: [] }).success).toBe(false);
    expect(TaskSchema.safeParse({ ...task("T-1"), designSectionRef: "section 1" }).success).toBe(false);
    const { designSectionRef: _d, ...missing } = task("T-1");
    expect(TaskSchema.safeParse(missing).success).toBe(false);
  });

  it("finds dependency cycles", () => {
    expect(findTaskCycle([task("T-1"), task("T-2", ["T-1"]), task("T-3", ["T-1", "T-2"])])).toBeNull();
    expect(findTaskCycle([task("T-1", ["T-2"]), task("T-2", ["T-1"])])).toEqual(["T-1", "T-2", "T-1"]);
    expect(findTaskCycle([task("T-1", ["T-1"])])).toEqual(["T-1", "T-1"]);
    expect(findTaskCycle([task("T-1"), task("T-2", ["T-3"]), task("T-3", ["T-4"]), task("T-4", ["T-2"])])).toEqual([
      "T-2",
      "T-3",
      "T-4",
      "T-2",
    ]);
  });
});

describe("ClarificationQuestion, Approval, AgentRun", () => {
  it("parses an open and an answered question", () => {
    const open = {
      id: ID,
      initiativeId: ID2,
      stage: "requirements",
      question: "Which CSV dialect?",
      answer: null,
      createdAt: NOW,
      answeredAt: null,
    };
    expect(ClarificationQuestionSchema.safeParse(open).success).toBe(true);
    expect(ClarificationQuestionSchema.safeParse({ ...open, answer: "RFC 4180", answeredAt: NOW }).success).toBe(true);
    expect(ClarificationQuestionSchema.safeParse({ ...open, answer: "" }).success).toBe(false);
  });

  it("parses approvals and rejects unknown decisions", () => {
    const approval = {
      id: ID,
      initiativeId: ID2,
      stage: "design",
      decision: "approved",
      reviewer: "architect@example.com",
      comment: "",
      artifactVersion: 2,
      createdAt: NOW,
    };
    expect(ApprovalSchema.safeParse(approval).success).toBe(true);
    expect(ApprovalSchema.safeParse({ ...approval, decision: "maybe" }).success).toBe(false);
    expect(ApprovalSchema.safeParse({ ...approval, stage: "tasks" }).success).toBe(false);
  });

  it("parses agent runs and rejects negative usage", () => {
    const run = {
      id: ID,
      initiativeId: ID2,
      agent: "requirement",
      model: "claude-sonnet-5-5",
      inputTokens: 1200,
      outputTokens: 800,
      costUsd: 0.0156,
      latencyMs: 4200,
      status: "succeeded",
      createdAt: NOW,
    };
    expect(AgentRunSchema.safeParse(run).success).toBe(true);
    expect(AgentRunSchema.safeParse({ ...run, agent: "review" }).success).toBe(false);
    expect(AgentRunSchema.safeParse({ ...run, costUsd: -1 }).success).toBe(false);
    expect(AgentRunSchema.safeParse({ ...run, inputTokens: 1.5 }).success).toBe(false);
  });
});

describe("ContextBundle", () => {
  it("accepts the empty bundle used for Case A", () => {
    expect(ContextBundleSchema.parse(EMPTY_CONTEXT_BUNDLE)).toEqual(EMPTY_CONTEXT_BUNDLE);
    expect(Object.isFrozen(EMPTY_CONTEXT_BUNDLE)).toBe(true);
  });

  it("accepts a populated bundle and rejects an unknown mode", () => {
    const bundle = {
      mode: "hybrid",
      chunks: [
        {
          repoId: "r",
          filePath: "a/b.ts",
          symbolName: "f",
          chunkType: "function",
          code: "x",
          startLine: 1,
          endLine: 2,
          score: 0.9,
          via: "similarity",
        },
      ],
      relevantClaudeMdSections: [{ repoId: "r", path: "a/CLAUDE.md.generated.md", content: "..." }],
      relevantMindmapExcerpt: "",
      tokenEstimate: 10,
      truncated: false,
    };
    expect(ContextBundleSchema.safeParse(bundle).success).toBe(true);
    expect(ContextBundleSchema.safeParse({ ...bundle, mode: "grep" }).success).toBe(false);
  });
});

describe("JSON Schema export", () => {
  it("converts every entity schema (used for tool calls and docs/API.md)", () => {
    for (const schema of [
      InitiativeSchema,
      ArtifactSchema,
      TaskSchema,
      ClarificationQuestionSchema,
      ApprovalSchema,
      AgentRunSchema,
      ContextBundleSchema,
    ]) {
      expect(() => z.toJSONSchema(schema)).not.toThrow();
    }
  });
});
