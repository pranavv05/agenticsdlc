import { RETRIEVAL_MODES } from "@sdd/contracts";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadDataset, loadDatasets } from "../src/retrieval/dataset";
import { evaluateRetrieval } from "../src/retrieval/evaluate";
import { renderReport } from "../src/retrieval/report";

const CASES = path.resolve(import.meta.dirname, "../retrieval/cases");
const shop = () => loadDataset(path.join(CASES, "shop-api.json"));

// Everything here runs offline: "mock" mode means hashed-word embeddings and placeholder docs, so these tests check that the
// harness is wired and consistent, not how good any mode is.
describe("evaluateRetrieval (offline, mock mode)", () => {
  it("scores every mode on every task and summarises", async () => {
    const report = await evaluateRetrieval({ datasets: [shop()], llmMode: "mock" });

    expect(report.llmMode).toBe("mock");
    expect(report.ks).toEqual([1, 3, 5, 10]);
    expect(report.datasets).toHaveLength(1);
    const dataset = report.datasets[0];
    expect(dataset.modes.map((m) => m.mode)).toEqual([...RETRIEVAL_MODES]);
    for (const m of dataset.modes) {
      expect(m.cases).toHaveLength(14);
      expect(m.summary.cases).toBe(14);
      for (const c of m.cases) {
        expect(c.ranked.length).toBeGreaterThan(0);
        expect(c.tokens).toBeLessThanOrEqual(report.budgetTokens);
        for (const k of report.ks) {
          expect(c.recall[k]).toBeGreaterThanOrEqual(0);
          expect(c.recall[k]).toBeLessThanOrEqual(1);
          expect(c.precision[k]).toBeGreaterThanOrEqual(0);
          expect(c.precision[k]).toBeLessThanOrEqual(1);
        }
        // recall can only grow with k
        expect(c.recall[3]).toBeGreaterThanOrEqual(c.recall[1]);
        expect(c.recall[10]).toBeGreaterThanOrEqual(c.recall[5]);
      }
    }
    expect(report.overall.map((o) => o.mode)).toEqual([...RETRIEVAL_MODES]);
  }, 60_000);

  it("finds the obvious files: a task that names the code in plain words gets it near the top in every mode", async () => {
    const report = await evaluateRetrieval({ datasets: [shop()], llmMode: "mock", ks: [1, 3, 5] });
    const task = "Automatically reorder products from the supplier when stock gets low";
    for (const m of report.datasets[0].modes) {
      const c = m.cases.find((x) => x.task === task)!;
      expect(c.ranked.slice(0, 5), m.mode).toContain("src/modules/inventory/restock.ts");
    }
  }, 60_000);

  it("is deterministic", async () => {
    const run = async () => {
      const r = await evaluateRetrieval({ datasets: [shop()], llmMode: "mock", modes: ["claude-md", "hybrid"] });
      return { overall: r.overall, per: r.datasets[0].modes.map((m) => m.cases.map((c) => c.ranked)) };
    };
    expect(await run()).toEqual(await run());
  }, 120_000);

  it("a tighter token budget shrinks the bundles and never exceeds the budget", async () => {
    const big = await evaluateRetrieval({ datasets: [shop()], llmMode: "mock", modes: ["hybrid"], budgetTokens: 12_000 });
    const small = await evaluateRetrieval({ datasets: [shop()], llmMode: "mock", modes: ["hybrid"], budgetTokens: 600 });
    expect(small.overall[0].meanTokens).toBeLessThanOrEqual(600);
    expect(small.overall[0].meanTokens).toBeLessThan(big.overall[0].meanTokens);
    expect(small.overall[0].truncatedShare).toBeGreaterThan(big.overall[0].truncatedShare);
  }, 120_000);

  it("claude-md mode reports a bundle with fewer files than embeddings when it matches nothing else", async () => {
    // lexical search only returns chunks that share a word with the task, so on a vague task it returns less than the always-full vector search
    const report = await evaluateRetrieval({ datasets: [shop()], llmMode: "mock", modes: ["claude-md", "embeddings"], topK: 15 });
    const files = Object.fromEntries(report.overall.map((o) => [o.mode, o.meanFiles]));
    expect(files["claude-md"]).toBeLessThanOrEqual(files["embeddings"]);
  }, 120_000);

  it("runs several datasets, including the Java fixture, and reports each plus the overall mean", async () => {
    const report = await evaluateRetrieval({ datasets: loadDatasets(CASES), llmMode: "mock", modes: ["hybrid"] });
    expect(report.datasets.map((d) => d.dataset)).toEqual(["billing-auth", "java-invoices", "shop-api"]);
    const total = report.datasets.reduce((n, d) => n + d.modes[0].cases.length, 0);
    expect(report.overall[0].cases).toBe(total);
    expect(report.datasets.find((d) => d.dataset === "java-invoices")!.modes[0].summary.recall[5]).toBe(1); // 3 files: everything is in the top 5
  }, 120_000);

  it("never writes into the evaluated repo", async () => {
    const dataset = shop();
    const before = JSON.stringify(await listFiles(dataset.repoPath));
    await evaluateRetrieval({ datasets: [dataset], llmMode: "mock", modes: ["claude-md"] });
    expect(JSON.stringify(await listFiles(dataset.repoPath))).toBe(before);
  }, 60_000);

  it("refuses to report a comparison that would be invalid: a repo indexed without embeddings cannot answer embeddings mode", async () => {
    await expect(
      evaluateRetrieval({ datasets: [shop()], llmMode: "mock", strategy: "claude-md-only", modes: ["embeddings"] }),
    ).rejects.toThrow(/would be invalid/);
    // claude-md mode is fine without embeddings
    const report = await evaluateRetrieval({ datasets: [shop()], llmMode: "mock", strategy: "claude-md-only", modes: ["claude-md"] });
    expect(report.overall[0].mode).toBe("claude-md");
  }, 60_000);

  it("accounts for the cost of the run, marked as mocked offline", async () => {
    const report = await evaluateRetrieval({ datasets: [shop()], llmMode: "mock", modes: ["embeddings"] });
    expect(report.usage.mocked).toBe(true);
    expect(report.usage.calls).toBeGreaterThan(0);
    expect(report.usage.costUsd).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it("falls back to mock mode when nothing says otherwise, so a stray run never spends money", async () => {
    const saved = process.env.LLM_MODE;
    delete process.env.LLM_MODE;
    try {
      const report = await evaluateRetrieval({ datasets: [loadDataset(path.join(CASES, "java-invoices.json"))], modes: ["claude-md"] });
      expect(report.llmMode).toBe("mock");
    } finally {
      if (saved !== undefined) process.env.LLM_MODE = saved;
    }
  }, 60_000);
});

describe("renderReport", () => {
  it("renders the comparison table, the mock warning and the per-task breakdown", async () => {
    const report = await evaluateRetrieval({ datasets: [loadDataset(path.join(CASES, "billing-auth.json"))], llmMode: "mock" });
    const markdown = renderReport(report);
    expect(markdown).toContain("# Retrieval quality");
    expect(markdown).toContain("Mock run: not evidence about the modes");
    expect(markdown).toMatch(
      /\| Mode \| recall@1 \| recall@3 \| recall@5 \| recall@10 \| precision@3 \| precision@5 \| hit@5 \| MRR \| files \| tokens \|/,
    );
    for (const mode of RETRIEVAL_MODES) expect(markdown).toMatch(new RegExp(`\\| ${mode} \\|`));
    expect(markdown).toContain("## billing-auth (5 tasks)");
    expect(markdown).toContain("## Per task");
    expect(markdown).toContain("billing/payments.ts"); // per-task tables show the last two path segments
    // every table row has the same number of columns
    const tables = markdown.split("\n\n").filter((b) => b.startsWith("| Mode"));
    for (const t of tables) {
      const widths = new Set(t.split("\n").map((l) => l.split("|").length));
      expect(widths.size).toBe(1);
    }
  }, 60_000);

  it("does not show the mock warning for a live report", async () => {
    const report = await evaluateRetrieval({
      datasets: [loadDataset(path.join(CASES, "java-invoices.json"))],
      llmMode: "mock",
      modes: ["claude-md"],
    });
    expect(renderReport({ ...report, llmMode: "live" })).not.toContain("Mock run");
  }, 60_000);
});

async function listFiles(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const out: string[] = [];
  const visit = async (d: string, rel: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) await visit(path.join(d, e.name), `${rel}${e.name}/`);
      else out.push(`${rel}${e.name}`);
    }
  };
  await visit(dir, "");
  return out.sort();
}
