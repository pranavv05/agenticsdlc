"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Counts = Record<string, number | string>;
type RepoProgress = { stage: string; stages: Record<string, Counts>; error?: string };
type Run = { id: number; status: "running" | "done" | "error"; startedAt: string; finishedAt: string | null; perRepoProgress: Record<string, RepoProgress> };

const STEPS: { key: string; label: string; detail: (c: Counts) => string }[] = [
  { key: "files", label: "Files found", detail: (c) => `${c.source} source / ${c.total} total` },
  { key: "chunks", label: "Chunks created", detail: (c) => `${c.chunks} chunks in ${c.files} files` },
  { key: "embeddings", label: "Embeddings done", detail: (c) => `${c.done}/${c.total}` },
  { key: "dependencies", label: "Dependencies", detail: (c) => `${c.edges} import edges` },
  { key: "claude_md", label: "CLAUDE.md generated", detail: (c) => `${c.written ?? 0}/${c.modules} modules${c.root ? " + root" : ""}` },
  { key: "mindmap", label: "Mindmap generated", detail: () => "written to output/" },
];

function StepRow({ step, p }: { step: (typeof STEPS)[number]; p: RepoProgress }) {
  const counts = p.stages[step.key];
  const complete = counts?.complete === 1;
  const failed = p.stage === "error" && !complete && !!counts;
  const icon = complete ? "✓" : failed ? "✗" : counts ? "…" : "○";
  const color = complete ? "text-green-600" : failed ? "text-red-600" : counts ? "text-amber-600" : "text-slate-300";
  return (
    <li className="flex items-center gap-3 py-1 text-sm">
      <span className={`w-4 text-center font-bold ${color}`}>{icon}</span>
      <span className="w-44">{step.label}</span>
      <span className="text-slate-500">{counts ? step.detail(counts) : "waiting"}</span>
    </li>
  );
}

export default function IndexPage() {
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async (runId?: number) => {
    try {
      const res = await fetch(`/api/index/status${runId ? `?runId=${runId}` : ""}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? res.statusText);
      setRun(json.run);
      return json.run as Run | null;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }, []);

  // Load the latest run on mount so progress survives a page refresh.
  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  // Poll every 2s while a run is in flight.
  useEffect(() => {
    if (run?.status !== "running") return;
    timer.current = setInterval(() => void fetchStatus(run.id), 2000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [run?.status, run?.id, fetchStatus]);

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const res = await fetch("/api/index", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? res.statusText);
      await fetchStatus(json.runId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  const repos = run ? Object.entries(run.perRepoProgress) : [];
  const running = run?.status === "running";

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Indexing</h1>
        <button
          onClick={start}
          disabled={starting || running}
          className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {running ? "Indexing…" : "Start Indexing"}
        </button>
      </div>

      {error && <div className="mt-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">{error}</div>}

      {run && (
        <p className="mt-3 text-sm text-slate-500">
          Run #{run.id} · {run.status} · started {new Date(run.startedAt).toLocaleTimeString()}
          {run.finishedAt && ` · finished ${new Date(run.finishedAt).toLocaleTimeString()}`}
        </p>
      )}

      {run?.status === "done" && (
        <div className="mt-4 rounded border border-green-300 bg-green-50 p-4 text-green-900">
          Indexing complete. All repos are chunked, embedded, documented and mapped — head to the Query page to check retrieval.
        </div>
      )}
      {run?.status === "error" && (
        <div className="mt-4 rounded border border-red-300 bg-red-50 p-4 text-red-900">Indexing finished with errors — see the failed repos below and the server log.</div>
      )}

      <div className="mt-6 space-y-4">
        {repos.map(([name, p]) => (
          <section key={name} className="rounded-lg border bg-white p-4 shadow-sm">
            <h2 className="font-medium">{name}</h2>
            {p.error && <p className="mt-1 text-sm text-red-700">{p.error}</p>}
            <ul className="mt-2">
              {STEPS.filter((s) => name !== "(system)" || p.stages[s.key]).map((s) => (
                <StepRow key={s.key} step={s} p={p} />
              ))}
              {name === "(system)" && p.stages.cross_repo_links && (
                <li className="flex items-center gap-3 py-1 text-sm">
                  <span className="w-4 text-center font-bold text-green-600">✓</span>
                  <span className="w-44">Cross-repo links</span>
                  <span className="text-slate-500">{p.stages.cross_repo_links.links} links</span>
                </li>
              )}
            </ul>
          </section>
        ))}
        {run && repos.length === 0 && <p className="text-sm text-slate-500">Waiting for the first progress event…</p>}
        {!run && <p className="text-sm text-slate-500">No runs yet. Fill in repos.config.json, then press Start Indexing.</p>}
      </div>
    </div>
  );
}
