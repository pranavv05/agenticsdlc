import { z } from "zod";
import { STATUSES, StatusSchema, type Status } from "./status";

/**
 * Who may trigger a transition (scope §11): agents propose, the orchestrator transitions, humans approve.
 * There is deliberately no "agent" actor: an agent can never move an initiative between statuses.
 */
export const ACTORS = ["orchestrator", "product", "architecture", "developer"] as const;
export const ActorSchema = z.enum(ACTORS);
export type Actor = z.infer<typeof ActorSchema>;

export interface TransitionRule {
  from: Status;
  to: Status;
  /** Actors allowed to trigger this transition. */
  actors: readonly Actor[];
  description: string;
}

/** Single source of truth for the state machine. Everything else is derived from this list. */
export const TRANSITION_RULES: readonly TransitionRule[] = [
  {
    from: "READY_FOR_SPEC",
    to: "REQUIREMENT_GENERATING",
    actors: ["product", "orchestrator"],
    description: "Product confirms the requirement is ready; the Requirement Agent starts.",
  },
  {
    from: "REQUIREMENT_GENERATING",
    to: "REQUIREMENT_REVIEW",
    actors: ["orchestrator"],
    description: "Draft produced with open clarification questions (or a failed critique escalated to a human).",
  },
  {
    from: "REQUIREMENT_GENERATING",
    to: "REQUIREMENT_REVIEWED",
    actors: ["orchestrator"],
    description: "Draft produced with no gaps remaining; waiting for Product's final approval.",
  },
  {
    from: "REQUIREMENT_REVIEW",
    to: "REQUIREMENT_GENERATING",
    actors: ["product"],
    description: "Product submitted answers; the agent re-runs.",
  },
  { from: "REQUIREMENT_REVIEWED", to: "SPEC_APPROVED", actors: ["product"], description: "Product approves the requirements." },
  {
    from: "REQUIREMENT_REVIEWED",
    to: "REQUIREMENT_GENERATING",
    actors: ["product"],
    description: "Product requests changes; the agent re-runs.",
  },
  {
    from: "SPEC_APPROVED",
    to: "DESIGN_GENERATING",
    actors: ["orchestrator"],
    description: "Design Agent starts from the approved requirements.",
  },
  {
    from: "DESIGN_GENERATING",
    to: "DESIGN_REVIEW",
    actors: ["orchestrator"],
    description: "Design drafted; waiting for architecture review.",
  },
  { from: "DESIGN_REVIEW", to: "DESIGN_APPROVED", actors: ["architecture"], description: "Architecture approves the design." },
  { from: "DESIGN_REVIEW", to: "DESIGN_REVISION_REQUESTED", actors: ["architecture"], description: "Architecture requests changes." },
  {
    from: "DESIGN_REVISION_REQUESTED",
    to: "DESIGN_GENERATING",
    actors: ["orchestrator"],
    description: "Design Agent re-runs with the review feedback.",
  },
  {
    from: "DESIGN_APPROVED",
    to: "TASKS_GENERATING",
    actors: ["orchestrator"],
    description: "Both approvals are recorded; the Task Agent starts.",
  },
  { from: "TASKS_GENERATING", to: "READY_FOR_DEVELOPMENT", actors: ["orchestrator"], description: "tasks.md produced." },
  {
    from: "READY_FOR_DEVELOPMENT",
    to: "IN_DEVELOPMENT",
    actors: ["developer", "orchestrator"],
    description: "A developer picks up the work (for example through the MCP server).",
  },
  { from: "IN_DEVELOPMENT", to: "DONE", actors: ["developer", "orchestrator"], description: "Implementation finished (or the PR merged)." },
];

/** Allowed target statuses per status. Derived from TRANSITION_RULES. */
export const TRANSITIONS: Readonly<Record<Status, readonly Status[]>> = Object.freeze(
  Object.fromEntries(STATUSES.map((s) => [s, TRANSITION_RULES.filter((r) => r.from === s).map((r) => r.to)])) as unknown as Record<
    Status,
    readonly Status[]
  >,
);

export type TransitionFailure = "unknown_status" | "no_such_transition" | "actor_not_permitted";

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
    readonly actor: string | undefined,
    readonly reason: TransitionFailure,
  ) {
    super(
      reason === "actor_not_permitted"
        ? `Actor "${actor}" may not move an initiative from ${from} to ${to}`
        : reason === "unknown_status"
          ? `Unknown status in transition ${from} -> ${to}`
          : `Illegal transition ${from} -> ${to}`,
    );
    this.name = "IllegalTransitionError";
  }
}

function findRule(from: Status, to: Status): TransitionRule | undefined {
  return TRANSITION_RULES.find((r) => r.from === from && r.to === to);
}

function check(from: string, to: string, actor?: string): TransitionFailure | null {
  if (!StatusSchema.safeParse(from).success || !StatusSchema.safeParse(to).success) return "unknown_status";
  const rule = findRule(from as Status, to as Status);
  if (!rule) return "no_such_transition";
  if (actor !== undefined && !(rule.actors as readonly string[]).includes(actor)) return "actor_not_permitted";
  return null;
}

/**
 * True when `from -> to` is a legal transition. When `actor` is given it must also be allowed to trigger it;
 * without an actor only the shape of the state machine is checked.
 */
export function canTransition(from: Status, to: Status, actor?: Actor): boolean {
  return check(from, to, actor) === null;
}

/** Throws IllegalTransitionError unless `actor` may move an initiative from `from` to `to`. The actor is mandatory. */
export function assertTransition(from: Status, to: Status, actor: Actor): void {
  const failure = check(from, to, actor ?? "");
  if (failure) throw new IllegalTransitionError(from, to, actor, failure);
}

/** Actors allowed to trigger `from -> to` (empty when the transition does not exist). */
export function actorsFor(from: Status, to: Status): readonly Actor[] {
  return findRule(from, to)?.actors ?? [];
}
