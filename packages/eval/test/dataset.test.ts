import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkDataset, loadDataset, loadDatasets } from "../src/retrieval/dataset";

const CASES = path.resolve(import.meta.dirname, "../retrieval/cases");
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function tmp(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-eval-ds-"));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

describe("the datasets shipped with the harness", () => {
  const datasets = loadDatasets(CASES);

  it("are found, valid and have unique names", () => {
    expect(datasets.map((d) => d.name).sort()).toEqual(["billing-auth", "java-invoices", "shop-api"]);
    expect(new Set(datasets.map((d) => d.name)).size).toBe(datasets.length);
  });

  it.each(datasets.map((d) => [d.name, d] as const))("%s: every expected file exists in its repo, with no duplicates", (_name, dataset) => {
    expect(checkDataset(dataset)).toEqual([]);
  });

  it("shop-api has enough tasks to say something, each needing at least two modules' worth of care only where the code does", () => {
    const shop = datasets.find((d) => d.name === "shop-api")!;
    expect(shop.cases.length).toBeGreaterThanOrEqual(12);
    expect(new Set(shop.cases.map((c) => c.task)).size).toBe(shop.cases.length);
    // the expected files cover all five modules, so the set is not biased toward one area
    const modules = new Set(shop.cases.flatMap((c) => c.expectedFiles).map((f) => f.split("/")[2]));
    expect(modules).toEqual(new Set(["orders", "payments", "inventory", "shipping", "users"]));
  });
});

describe("loadDataset", () => {
  it("resolves the repo folder relative to the JSON file", () => {
    const dir = tmp({
      "cases/a.json": JSON.stringify({
        name: "a",
        description: "d",
        repo: "../repo",
        cases: [{ task: "do something useful", expectedFiles: ["x.ts"] }],
      }),
      "repo/x.ts": "export {};",
    });
    const loaded = loadDataset(path.join(dir, "cases/a.json"));
    expect(loaded.repoPath).toBe(path.join(dir, "repo"));
    expect(checkDataset(loaded)).toEqual([]);
  });

  it.each([
    ["a bad name", { name: "Bad Name", description: "d", repo: ".", cases: [{ task: "do something useful", expectedFiles: ["x"] }] }],
    ["no cases", { name: "a", description: "d", repo: ".", cases: [] }],
    [
      "a case without expected files",
      { name: "a", description: "d", repo: ".", cases: [{ task: "do something useful", expectedFiles: [] }] },
    ],
    ["a task that is too short", { name: "a", description: "d", repo: ".", cases: [{ task: "x", expectedFiles: ["x"] }] }],
  ])("rejects %s, naming the file", (_label, body) => {
    const dir = tmp({ "d.json": JSON.stringify(body) });
    expect(() => loadDataset(path.join(dir, "d.json"))).toThrow(/Invalid retrieval dataset .*d\.json/);
  });

  it("rejects malformed JSON and a missing repo folder", () => {
    const bad = tmp({ "d.json": "{not json" });
    expect(() => loadDataset(path.join(bad, "d.json"))).toThrow(/Invalid retrieval dataset/);
    const missing = tmp({
      "d.json": JSON.stringify({
        name: "a",
        description: "d",
        repo: "nope",
        cases: [{ task: "do something useful", expectedFiles: ["x"] }],
      }),
    });
    expect(() => loadDataset(path.join(missing, "d.json"))).toThrow(/does not exist/);
  });
});

describe("checkDataset", () => {
  it("reports expected files that do not exist and duplicates, by case number", () => {
    const dir = tmp({
      "d.json": JSON.stringify({
        name: "a",
        description: "d",
        repo: "repo",
        cases: [
          { task: "do something useful", expectedFiles: ["ok.ts", "missing.ts"] },
          { task: "do something else here", expectedFiles: ["ok.ts", "ok.ts"] },
        ],
      }),
      "repo/ok.ts": "x",
    });
    expect(checkDataset(loadDataset(path.join(dir, "d.json")))).toEqual([
      'case 1: expected file "missing.ts" does not exist in repo',
      "case 2: expectedFiles has duplicates",
    ]);
  });
});
