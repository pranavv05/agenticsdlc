import type { ModeSummary, RetrievalReport } from "./evaluate";

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
const num = (n: number, digits = 2) => n.toFixed(digits);
const round = (n: number) => Math.round(n).toLocaleString("en-US");

/** The columns of the comparison table: recall at every k, precision at the middle ks, hit rate, MRR and the bundle's size. */
function table(summaries: ModeSummary[], ks: number[]): string {
  const precisionKs = ks.filter((k) => k > 1).slice(0, 2);
  const hitK = ks.includes(5) ? 5 : ks[ks.length - 1];
  const header = [
    "Mode",
    ...ks.map((k) => `recall@${k}`),
    ...precisionKs.map((k) => `precision@${k}`),
    `hit@${hitK}`,
    "MRR",
    "files",
    "tokens",
  ];
  const rows = summaries.map((s) => [
    s.mode,
    ...ks.map((k) => pct(s.recall[k])),
    ...precisionKs.map((k) => pct(s.precision[k])),
    pct(s.hit[hitK]),
    num(s.mrr),
    num(s.meanFiles, 1),
    round(s.meanTokens),
  ]);
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map((_, i) => (i === 0 ? "---" : "---:"))), ...rows.map(line)].join("\n");
}

const shortTask = (t: string) => (t.length > 70 ? t.slice(0, 67) + "..." : t);

/** The report as Markdown: one comparison table per dataset, one over everything, and a per-task breakdown. */
export function renderReport(report: RetrievalReport): string {
  const { ks } = report;
  const lines: string[] = ["# Retrieval quality", ""];
  lines.push(
    `Run ${report.generatedAt} | LLM_MODE=${report.llmMode} | token budget ${round(report.budgetTokens)} | ${report.topK} primary hits per query`,
    "",
  );
  if (report.llmMode === "mock") {
    lines.push(
      "> **Mock run: not evidence about the modes.** Embeddings are hashed words and the CLAUDE.md files are placeholders, so `embeddings` behaves like keyword search and `claude-md` has no real docs to steer it. This run checks the harness. Run it live (`--live`) for the comparison the project reports.",
      "",
    );
  }
  lines.push(
    `Cost of building the indexes and answering the queries: $${report.usage.costUsd.toFixed(4)} (${report.usage.calls} calls${report.usage.mocked ? ", mocked" : ""}).`,
    "",
    "How to read it: *recall@k* is the share of the files a developer needs that are in the first k files of the bundle; *precision@k* is the share of those k files that are needed; *hit@k* is the share of tasks with at least one needed file in the first k; *MRR* rewards putting the first needed file early; *files* and *tokens* are the mean size of the bundle.",
    "",
  );

  for (const d of report.datasets) {
    lines.push(
      `## ${d.dataset} (${d.modes[0]?.cases.length ?? 0} tasks)`,
      "",
      d.description,
      "",
      table(
        d.modes.map((m) => m.summary),
        ks,
      ),
      "",
    );
  }
  if (report.datasets.length > 1) {
    lines.push("## All datasets", "", table(report.overall, ks), "");
  }

  lines.push("## Per task", "");
  for (const d of report.datasets) {
    lines.push(`### ${d.dataset}`, "");
    const recallK = ks.includes(5) ? 5 : ks[ks.length - 1];
    lines.push(
      `| Task | Needed files | ${d.modes.map((m) => `${m.mode} (recall@${recallK}) top 3`).join(" | ")} |`,
      `| --- | --- | ${d.modes.map(() => "---").join(" | ")} |`,
    );
    const first = d.modes[0];
    first.cases.forEach((c, i) => {
      const cells = d.modes.map((m) => {
        const r = m.cases[i];
        return `${pct(r.recall[recallK])}: ${
          r.ranked
            .slice(0, 3)
            .map((f) => `\`${f.split("/").slice(-2).join("/")}\``)
            .join(", ") || "(nothing)"
        }`;
      });
      lines.push(
        `| ${shortTask(c.task)} | ${c.expectedFiles.map((f) => `\`${f.split("/").slice(-2).join("/")}\``).join(", ")} | ${cells.join(" | ")} |`,
      );
    });
    lines.push("");
  }
  return lines.join("\n");
}
