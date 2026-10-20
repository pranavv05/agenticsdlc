import { z } from "zod";
import {
  AcceptanceCriterionIdSchema,
  DesignSectionIdSchema,
  IdSchema,
  LIMITS,
  NonFunctionalItemIdSchema,
  RequirementItemIdSchema,
  TaskIdSchema,
  TimestampSchema,
} from "./common";

/** Fields shared by every stored artifact version. */
const artifactBase = {
  id: IdSchema,
  initiativeId: IdSchema,
  /** 1-based, increments on every regeneration or human edit. */
  version: z.number().int().min(1).describe("1-based; increases on every regeneration or human edit."),
  /** The rendered markdown file (requirements.md, design.md or tasks.md), generated deterministically from `content`. */
  markdown: z
    .string()
    .max(LIMITS.markdown)
    .describe("The rendered file (requirements.md, design.md or tasks.md), always generated from `content`."),
  /** True when a human edited the markdown and a regeneration would conflict: the artifact waits for a human merge. */
  needsHumanMerge: z
    .boolean()
    .describe("True when a human edited the markdown and regenerating would overwrite it. Regeneration stops until a human merges."),
  /** The agent run that produced this version; absent for human edits. */
  agentRunId: IdSchema.optional().describe("The agent run that produced this version. Absent for human edits."),
  createdAt: TimestampSchema,
};

// ---- requirements.md ----

export const RequirementContentSchema = z.object({
  summary: z.string().min(1).max(LIMITS.longText).describe("One paragraph restating what is being built and why."),
  functionalRequirements: z
    .array(
      z.object({
        id: RequirementItemIdSchema,
        statement: z.string().min(1).max(LIMITS.shortText),
        acceptanceCriterionRefs: z.array(AcceptanceCriterionIdSchema).describe("Acceptance criteria (AC-n) this requirement covers."),
      }),
    )
    .min(1),
  nonFunctionalRequirements: z.array(z.object({ id: NonFunctionalItemIdSchema, statement: z.string().min(1).max(LIMITS.shortText) })),
  assumptions: z.array(z.string().min(1).max(LIMITS.shortText)),
  outOfScope: z.array(z.string().min(1).max(LIMITS.shortText)),
});
export type RequirementContent = z.infer<typeof RequirementContentSchema>;

export const RequirementSchema = z.object({ ...artifactBase, kind: z.literal("requirements"), content: RequirementContentSchema });
export type Requirement = z.infer<typeof RequirementSchema>;

// ---- design.md ----

export const DesignSectionSchema = z.object({
  id: DesignSectionIdSchema,
  title: z.string().min(1).max(LIMITS.title),
  body: z.string().min(1).max(LIMITS.longText),
  /** Files or modules this section touches. In Case B each must exist in the indexed repo (see `grounding`). */
  referencedPaths: z
    .array(z.string().min(1))
    .describe("Repo-relative files or modules this section touches. In Case B each one must exist in the indexed repo."),
});
export type DesignSection = z.infer<typeof DesignSectionSchema>;

export const DesignContentSchema = z.object({
  overview: z.string().min(1).max(LIMITS.longText),
  sections: z.array(DesignSectionSchema).min(1),
  risks: z.array(z.string().min(1).max(LIMITS.shortText)),
});
export type DesignContent = z.infer<typeof DesignContentSchema>;

/** Result of verifying that every path named in design.md exists in the indexed repo. */
export const GroundingResultSchema = z.object({
  checkedPaths: z.array(z.string()).describe("Every path named in design.md that was checked."),
  missingPaths: z.array(z.string()).describe("Checked paths that do not exist in the indexed repo. Empty means fully grounded."),
  checkedAt: TimestampSchema,
});
export type GroundingResult = z.infer<typeof GroundingResultSchema>;

export const DesignSchema = z.object({
  ...artifactBase,
  kind: z.literal("design"),
  content: DesignContentSchema,
  /** Null for Case A (nothing to ground against) or before the check has run. */
  grounding: GroundingResultSchema.nullable().describe("Null for Case A or before the check has run."),
});
export type Design = z.infer<typeof DesignSchema>;

// ---- tasks.md ----

export const TaskStatusSchema = z.enum(["todo", "in_progress", "done"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSchema = z.object({
  /** Unique within the tasks artifact (T-1, T-2, ...). */
  id: TaskIdSchema.describe("Unique within the tasks artifact."),
  title: z.string().min(1).max(LIMITS.title),
  description: z.string().min(1).max(LIMITS.longText),
  designSectionRef: DesignSectionIdSchema.describe("The design section (DS-n) this task implements."),
  acceptanceCriterionRefs: z.array(AcceptanceCriterionIdSchema).min(1).describe("Acceptance criteria (AC-n) this task helps satisfy."),
  /** Ids of tasks that must finish first. Must not contain cycles. */
  dependsOn: z.array(TaskIdSchema).describe("Ids of tasks that must finish first. Never forms a cycle."),
  status: TaskStatusSchema,
});
export type Task = z.infer<typeof TaskSchema>;

export const TasksContentSchema = z.object({ tasks: z.array(TaskSchema).min(1) });
export type TasksContent = z.infer<typeof TasksContentSchema>;

export const TasksArtifactSchema = z.object({ ...artifactBase, kind: z.literal("tasks"), content: TasksContentSchema });
export type TasksArtifact = z.infer<typeof TasksArtifactSchema>;

// ---- union ----

export const ARTIFACT_KINDS = ["requirements", "design", "tasks"] as const;
export const ArtifactKindSchema = z.enum(ARTIFACT_KINDS);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const ArtifactSchema = z.discriminatedUnion("kind", [RequirementSchema, DesignSchema, TasksArtifactSchema]);
export type Artifact = z.infer<typeof ArtifactSchema>;

/** Returns the first dependency cycle found as a list of task ids, or null when the graph is acyclic. */
export function findTaskCycle(tasks: readonly Pick<Task, "id" | "dependsOn">[]): string[] | null {
  const deps = new Map(tasks.map((t) => [t.id, t.dependsOn]));
  const state = new Map<string, 1 | 2>(); // 1 = on the current path, 2 = fully explored
  const path: string[] = [];

  const visit = (id: string): string[] | null => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return [...path.slice(path.indexOf(id)), id];
    state.set(id, 1);
    path.push(id);
    for (const next of deps.get(id) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(id, 2);
    return null;
  };

  for (const t of tasks) {
    const cycle = visit(t.id);
    if (cycle) return cycle;
  }
  return null;
}
