import { describe, expect, it } from "vitest";
import { hitAtK, mean, precisionAtK, rankedFiles, recallAtK, reciprocalRank } from "../src/retrieval/metrics";

const chunk = (filePath: string, via: "similarity" | "lexical" | "dependency" = "similarity") => ({
  repoId: "r",
  filePath,
  symbolName: null,
  chunkType: "function" as const,
  code: "",
  startLine: 1,
  endLine: 2,
  score: null,
  via,
});

describe("rankedFiles", () => {
  it("lists each file once, in the order the bundle presents them", () => {
    const bundle = { chunks: [chunk("a.ts"), chunk("b.ts"), chunk("a.ts"), chunk("c.ts", "dependency"), chunk("b.ts")] };
    expect(rankedFiles(bundle)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(rankedFiles({ chunks: [] })).toEqual([]);
  });
});

describe("recallAtK", () => {
  const ranked = ["a", "x", "b", "y", "z", "c"];
  it("is the share of expected files in the first k files", () => {
    expect(recallAtK(ranked, ["a", "b", "c"], 1)).toBeCloseTo(1 / 3);
    expect(recallAtK(ranked, ["a", "b", "c"], 3)).toBeCloseTo(2 / 3);
    expect(recallAtK(ranked, ["a", "b", "c"], 6)).toBe(1);
    expect(recallAtK(ranked, ["a", "b", "c"], 100)).toBe(1);
  });

  it("is 0 when nothing expected was returned, and when nothing was returned at all", () => {
    expect(recallAtK(ranked, ["q"], 6)).toBe(0);
    expect(recallAtK([], ["a"], 5)).toBe(0);
  });

  it("counts a repeated expected file once", () => {
    expect(recallAtK(["a", "b"], ["a", "a"], 2)).toBe(1);
  });
});

describe("precisionAtK", () => {
  const ranked = ["a", "x", "b", "y"];
  it("is the share of the first k files that are expected", () => {
    expect(precisionAtK(ranked, ["a", "b"], 1)).toBe(1);
    expect(precisionAtK(ranked, ["a", "b"], 2)).toBe(0.5);
    expect(precisionAtK(ranked, ["a", "b"], 4)).toBe(0.5);
  });

  it("divides by the number returned when fewer than k files came back, so a short accurate list is not punished", () => {
    expect(precisionAtK(["a", "b"], ["a", "b", "c"], 10)).toBe(1);
    expect(precisionAtK(["a"], ["a"], 5)).toBe(1);
  });

  it("is 0 for an empty result", () => {
    expect(precisionAtK([], ["a"], 3)).toBe(0);
  });
});

describe("hitAtK and reciprocalRank", () => {
  it("hit is 1 when any expected file is in the first k", () => {
    expect(hitAtK(["x", "y", "a"], ["a"], 2)).toBe(0);
    expect(hitAtK(["x", "y", "a"], ["a"], 3)).toBe(1);
  });

  it("reciprocal rank is 1 over the position of the first expected file", () => {
    expect(reciprocalRank(["a", "x"], ["a"])).toBe(1);
    expect(reciprocalRank(["x", "y", "b"], ["a", "b"])).toBeCloseTo(1 / 3);
    expect(reciprocalRank(["x"], ["a"])).toBe(0);
    expect(reciprocalRank([], ["a"])).toBe(0);
  });
});

describe("argument checks", () => {
  it("refuse a case without expected files and a bad k", () => {
    expect(() => recallAtK(["a"], [], 3)).toThrow(RangeError);
    expect(() => precisionAtK(["a"], [], 3)).toThrow(RangeError);
    expect(() => reciprocalRank(["a"], [])).toThrow(RangeError);
    for (const k of [0, -1, 1.5, Number.NaN]) expect(() => recallAtK(["a"], ["a"], k)).toThrow(RangeError);
  });
});

describe("mean", () => {
  it("averages, and is 0 for nothing", () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(mean([])).toBe(0);
  });
});
