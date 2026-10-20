import { describe, expect, it } from "vitest";
import {
  ACTORS,
  INITIAL_STATUS,
  IllegalTransitionError,
  STATUSES,
  TERMINAL_STATUS,
  TRANSITIONS,
  TRANSITION_RULES,
  actorsFor,
  assertTransition,
  canTransition,
  type Actor,
  type Status,
} from "../src";

const legal = TRANSITION_RULES.map((r) => `${r.from}->${r.to}`);
const pairs = STATUSES.flatMap((from) => STATUSES.map((to) => ({ from, to, key: `${from}->${to}` })));

describe("status enum", () => {
  it("has the 13 statuses we implement, without duplicates", () => {
    expect(STATUSES).toHaveLength(13);
    expect(new Set(STATUSES).size).toBe(STATUSES.length);
  });
});

describe("transition rules", () => {
  it("only mention known statuses and actors", () => {
    for (const r of TRANSITION_RULES) {
      expect(STATUSES).toContain(r.from);
      expect(STATUSES).toContain(r.to);
      expect(r.actors.length).toBeGreaterThan(0);
      for (const a of r.actors) expect(ACTORS).toContain(a);
    }
  });

  it("contain no duplicate from/to pair", () => {
    expect(new Set(legal).size).toBe(legal.length);
  });

  it("are exposed as TRANSITIONS, derived from the rules", () => {
    for (const s of STATUSES) {
      expect([...TRANSITIONS[s]].sort()).toEqual(
        TRANSITION_RULES.filter((r) => r.from === s)
          .map((r) => r.to)
          .sort(),
      );
    }
  });
});

describe("full transition matrix (13 x 13)", () => {
  it("covers every pair", () => {
    expect(pairs).toHaveLength(STATUSES.length ** 2);
  });

  describe.each(pairs)("$key", ({ from, to, key }) => {
    if (legal.includes(key)) {
      it("is legal and passes for every permitted actor", () => {
        expect(canTransition(from, to)).toBe(true);
        for (const actor of actorsFor(from, to)) {
          expect(canTransition(from, to, actor)).toBe(true);
          expect(() => assertTransition(from, to, actor)).not.toThrow();
        }
      });

      it("throws actor_not_permitted for every other actor", () => {
        const allowed = actorsFor(from, to);
        for (const actor of ACTORS.filter((a) => !allowed.includes(a))) {
          expect(canTransition(from, to, actor)).toBe(false);
          expect(() => assertTransition(from, to, actor)).toThrowError(IllegalTransitionError);
          try {
            assertTransition(from, to, actor);
          } catch (e) {
            expect((e as IllegalTransitionError).reason).toBe("actor_not_permitted");
          }
        }
      });
    } else {
      it("is illegal for every actor", () => {
        expect(canTransition(from, to)).toBe(false);
        for (const actor of ACTORS) {
          expect(canTransition(from, to, actor)).toBe(false);
          expect(() => assertTransition(from, to, actor)).toThrowError(IllegalTransitionError);
          try {
            assertTransition(from, to, actor);
          } catch (e) {
            expect((e as IllegalTransitionError).reason).toBe("no_such_transition");
          }
        }
      });
    }
  });
});

describe("shape of the state machine", () => {
  const reachable = (start: Status, edges: (s: Status) => readonly Status[]): Set<Status> => {
    const seen = new Set<Status>([start]);
    const queue: Status[] = [start];
    while (queue.length) {
      for (const next of edges(queue.shift()!)) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return seen;
  };

  it("reaches every status from the initial status", () => {
    const seen = reachable(INITIAL_STATUS, (s) => TRANSITIONS[s]);
    expect([...STATUSES].filter((s) => !seen.has(s))).toEqual([]);
  });

  it("has no dead end except DONE", () => {
    for (const s of STATUSES) {
      if (s === TERMINAL_STATUS) expect(TRANSITIONS[s]).toEqual([]);
      else expect(TRANSITIONS[s].length, `${s} must have an outgoing transition`).toBeGreaterThan(0);
    }
  });

  it("can reach DONE from every status (no trap loops)", () => {
    const incoming = (s: Status) => TRANSITION_RULES.filter((r) => r.to === s).map((r) => r.from);
    const canFinish = reachable(TERMINAL_STATUS, incoming);
    expect([...STATUSES].filter((s) => !canFinish.has(s))).toEqual([]);
  });

  it("has no transition into the initial status (an initiative never goes back to the start)", () => {
    expect(TRANSITION_RULES.filter((r) => r.to === INITIAL_STATUS)).toEqual([]);
  });
});

describe("governance (scope section 11)", () => {
  it("rejects an agent actor everywhere", () => {
    for (const { from, to } of pairs) {
      expect(canTransition(from, to, "agent" as Actor)).toBe(false);
      expect(() => assertTransition(from, to, "agent" as Actor)).toThrowError(IllegalTransitionError);
    }
  });

  it("rejects a missing actor at runtime", () => {
    expect(() => assertTransition("READY_FOR_SPEC", "REQUIREMENT_GENERATING", undefined as unknown as Actor)).toThrowError(
      IllegalTransitionError,
    );
  });

  it("lets only Product approve requirements", () => {
    expect(actorsFor("REQUIREMENT_REVIEWED", "SPEC_APPROVED")).toEqual(["product"]);
  });

  it("lets only Architecture approve or send back a design", () => {
    expect(actorsFor("DESIGN_REVIEW", "DESIGN_APPROVED")).toEqual(["architecture"]);
    expect(actorsFor("DESIGN_REVIEW", "DESIGN_REVISION_REQUESTED")).toEqual(["architecture"]);
  });

  it("never lets the orchestrator or a developer approve anything", () => {
    for (const [from, to] of [
      ["REQUIREMENT_REVIEWED", "SPEC_APPROVED"],
      ["DESIGN_REVIEW", "DESIGN_APPROVED"],
    ] as const) {
      for (const actor of ["orchestrator", "developer"] as const) {
        expect(canTransition(from, to, actor)).toBe(false);
      }
    }
  });

  it("generates tasks only from DESIGN_APPROVED, by the orchestrator", () => {
    const intoTasks = TRANSITION_RULES.filter((r) => r.to === "TASKS_GENERATING");
    expect(intoTasks.map((r) => r.from)).toEqual(["DESIGN_APPROVED"]);
    expect(intoTasks[0].actors).toEqual(["orchestrator"]);
  });

  it("cannot skip a gate: design generation needs SPEC_APPROVED, tasks need DESIGN_APPROVED", () => {
    expect(
      TRANSITION_RULES.filter((r) => r.to === "DESIGN_GENERATING")
        .map((r) => r.from)
        .sort(),
    ).toEqual(["DESIGN_REVISION_REQUESTED", "SPEC_APPROVED"]);
    expect(canTransition("REQUIREMENT_REVIEWED", "DESIGN_GENERATING")).toBe(false);
    expect(canTransition("DESIGN_REVIEW", "TASKS_GENERATING")).toBe(false);
  });

  it("reports unknown statuses distinctly", () => {
    try {
      assertTransition("NOPE" as Status, "DONE", "orchestrator");
      expect.unreachable();
    } catch (e) {
      expect((e as IllegalTransitionError).reason).toBe("unknown_status");
    }
  });
});
