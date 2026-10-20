import { RETRIEVAL_MODES, type RetrievalMode } from "@sdd/contracts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkDataset, loadDatasets } from "../src/retrieval/dataset";
import { DEFAULT_KS, evaluateRetrieval } from "../src/retrieval/evaluate";
import { renderReport } from "../src/retrieval/report";

const HELP = `Retrieval quality: recall@k, precision@k and tokens for claude-md, embeddings and hybrid retrieval.

Usage: pnpm --filter @sdd/eval retrieval [options]

  --live              use the real Voyage and Claude APIs (needs VOYAGE_API_KEY and ANTHROPIC_API_KEY; costs money).
                      Without it everything runs offline in mock mode, which only checks the harness.
  --dataset <name>    only this dataset (default: all in retrieval/cases). Repeatable.
  --mode <mode>       only this mode: ${RETRIEVAL_MODES.join(", ")} (default: all). Repeatable.
  --k <list>          cut-offs, comma separated (default ${DEFAULT_KS.join(",")})
  --budget <tokens>   token budget of every bundle (default 12000)
  --top-k <n>         primary hits gathered per query (default 15)
  --out <file>        also write the Markdown report to this file
  --json <file>       also write the full results as JSON
  --help
`;

const here = path.dirname(fileURLToPath(import.meta.url));

const { values } = parseArgs({
  options: {
    live: { type: "boolean", default: false },
    dataset: { type: "string", multiple: true },
    mode: { type: "string", multiple: true },
    k: { type: "string" },
    budget: { type: "string" },
    "top-k": { type: "string" },
    out: { type: "string" },
    json: { type: "string" },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const positive = (name: string, raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer, got "${raw}"`);
  return n;
};

try {
  const modes = (values.mode ?? [...RETRIEVAL_MODES]) as RetrievalMode[];
  for (const m of modes) if (!RETRIEVAL_MODES.includes(m)) throw new Error(`Unknown mode "${m}". Use ${RETRIEVAL_MODES.join(", ")}`);
  const ks = values.k ? values.k.split(",").map((k) => positive("k", k.trim(), 0)) : [...DEFAULT_KS];

  if (values.live) {
    const root = path.resolve(here, "../../..");
    for (const file of [".env.local", ".env"]) {
      const f = path.join(root, file);
      if (fs.existsSync(f)) process.loadEnvFile(f);
    }
    process.env.LLM_MODE = "live";
    for (const key of ["ANTHROPIC_API_KEY", "VOYAGE_API_KEY"]) {
      if (!process.env[key]) throw new Error(`--live needs ${key} (set it in .env)`);
    }
  } else {
    process.env.LLM_MODE = "mock";
  }

  let datasets = loadDatasets(path.join(here, "cases"));
  if (values.dataset?.length) {
    datasets = datasets.filter((d) => values.dataset!.includes(d.name));
    if (!datasets.length) throw new Error(`No dataset named ${values.dataset.join(", ")}`);
  }
  for (const d of datasets) {
    const problems = checkDataset(d);
    if (problems.length) throw new Error(`Dataset ${d.name} has problems:\n  ${problems.join("\n  ")}`);
  }

  console.error(
    values.live
      ? "LIVE run: real APIs, this costs money."
      : "Mock run: offline, checks the harness only (numbers are not evidence about the modes).",
  );
  // The indexing pipeline logs with console.log; send that to stderr so stdout carries only the report and can be redirected.
  const stdoutLog = console.log;
  console.log = (...args: unknown[]) => console.error(...args);
  let report;
  try {
    report = await evaluateRetrieval({
      datasets,
      modes,
      ks,
      budgetTokens: positive("budget", values.budget, 12_000),
      topK: positive("top-k", values["top-k"], 15),
      onProgress: (m) => console.error(m),
    });
  } finally {
    console.log = stdoutLog;
  }

  const markdown = renderReport(report);
  console.log(markdown);
  if (values.out) fs.writeFileSync(values.out, markdown + "\n");
  if (values.json) fs.writeFileSync(values.json, JSON.stringify(report, null, 2) + "\n");
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
