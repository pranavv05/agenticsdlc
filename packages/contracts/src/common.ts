import { z } from "zod";

export const IdSchema = z.uuid();
export const TimestampSchema = z.iso.datetime();

/** Human-readable reference ids, unique within one initiative (for example AC-1, FR-2, DS-3, T-4). */
const refId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}-[1-9]\\d*$`), `must look like ${prefix}-1`);
export const AcceptanceCriterionIdSchema = refId("AC");
export const RequirementItemIdSchema = refId("FR");
export const NonFunctionalItemIdSchema = refId("NFR");
export const DesignSectionIdSchema = refId("DS");
export const TaskIdSchema = refId("T");

export const CaseTypeSchema = z.enum(["A", "B"]);
export type CaseType = z.infer<typeof CaseTypeSchema>;

/** Size limits shared by every schema that accepts free text from a user or model. */
export const LIMITS = {
  title: 200,
  shortText: 2_000,
  longText: 20_000,
  markdown: 200_000,
} as const;
