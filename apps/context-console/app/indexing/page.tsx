"use client";

import { useCallback, useEffect, useState } from "react";

type Strategy = "full" | "claude-md-only";
type Counts = Record<string, number | string>;
interface Repo {
  id: string;
  name: string;
  source: { type: "path" | "url"; value: string };
  status: "profiling" | "profiled" | "indexing" | "indexed" | "failed";
  profile: {
    totalFiles: number;
    totalLoc: number;
    languages: { language: string; files: number; loc: number }[];
    recommendation: Strategy;
    reason: string;
  } | null;
  indexStrategy: Strategy | null;
  indexedCommitSha: string | null;
  indexedAt: string | null;
  error?: string;
}
interface Run {
  repoId: string;
  status: "running" | "done" | "error";
  mode: "full" | "incremental" | null;
  progress: Record<string, Counts>;
  error: string | null;
}

const STEPS: { key: string; label: string; detail: (c: Counts) => string }[] = [
  { key: "plan", label: "Plan", detail: (c) => `${c.kind}: ${c.reason}` },
  { key: "files", label: "Files found", detail: (c) => `${c.source} source / ${c.total} total` },
  { key: "chunks", label: "Chunks created", detail: (c) => `${c.chunks} chunks in ${c.files} files` },
  { key: "dependencies", label: "Dependencies", detail: (c) => `${c.edges} import edges` },
  { key: "embeddings", label: "Embeddings", detail: (c) => `${c.done}/${c.total}${c.reused ? ` (${c.reused} chunks reused)` : ""}` },
  {
    key: "claude_md",
    label: "CLAUDE.md files",
    detail: (c) => `${c.written ?? 0}/${c.rewriting ?? c.modules} module docs${c.root ? " + root" : ""}`,
  },
  { key: "mindmap", label: "Mindmap", detail: (c) => (c.diagrams ? "written" : "unchanged") },
];

const STATUS_STYLE: Record<Repo["status"], string> = {
  profiling: "bg-amber-100 text-amber-800",
  profiled: "bg-slate-100 text-slate-800",
  indexing: "bg-blue-100 text-blue-800",
  indexed: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message ?? res.statusText);
  return json as T;
}

function Progress({ run }: { run: Run }) {
  return (
    <ul className="mt-2">
      {STEPS.filter((s) => run.progress[s.key]).map((s) => {
        const counts = run.progress[s.key];
        const complete = counts.complete === 1;
        const failed = run.status === "error" && !complete;
        return (
          <li key={s.key} className="flex items-center gap-3 py-0.5 text-xs">
            <span className={`w-4 text-center font-bold ${complete ? "text-green-600" : failed ? "text-red-600" : "text-amber-600"}`}>
              {complete ? "✓" : failed ? "✗" : "…"}
            </span>
            <span className="w-28">{s.label}</span>
            <span className="text-slate-500">{s.detail(counts)}</span>
          </li>
        );
      })}
    </ul>
  );
}

export default function IndexingPage() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [sourceType, setSourceType] = useState<"path" | "url">("path");
  const [sourceValue, setSourceValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [strategy, setStrategy] = useState<Record<string, Strategy | "auto">>({});

  const refresh = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([api<{ items: Repo[] }>("/api/repos"), api<{ items: Run[] }>("/api/index/status")]);
      setRepos(r.items);
      setRuns(s.items);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // poll while anything is running
  const working = repos.some((r) => r.status === "profiling" || r.status === "indexing");
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  }, [working, refresh]);

  async function register() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, source: { type: sourceType, value: sourceValue } }),
      });
      setName("");
      setSourceValue("");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function index(repo: Repo) {
    setError(null);
    try {
      const chosen = strategy[repo.id];
      await api(`/api/repos/${repo.id}/index`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(chosen && chosen !== "auto" ? { strategy: chosen } : {}),
      });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold">Indexing</h1>
      <p className="mt-1 text-sm text-slate-600">
        Register a repo (a local folder or a Git URL), see its profile, then index it. Generated docs go to the output folder, never into
        the repo.
      </p>

      {error && <div className="mt-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">{error}</div>}

      <section className="mt-6 rounded-lg border bg-white p-4 shadow-sm">
        <h2 className="font-medium">Register a repo</h2>
        <div className="mt-3 flex flex-wrap items-end gap-3 text-sm">
          <label className="flex flex-col gap-1">
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="billing-service"
              className="rounded border px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1">
            Source
            <select
              value={sourceType}
              onChange={(e) => setSourceType(e.target.value as "path" | "url")}
              className="rounded border px-2 py-1"
            >
              <option value="path">Local folder</option>
              <option value="url">Git URL</option>
            </select>
          </label>
          <label className="flex min-w-72 flex-1 flex-col gap-1">
            {sourceType === "path" ? "Absolute path" : "Clone URL (https or ssh)"}
            <input
              value={sourceValue}
              onChange={(e) => setSourceValue(e.target.value)}
              placeholder={sourceType === "path" ? "/work/billing-service" : "https://github.com/org/billing-service.git"}
              className="rounded border px-2 py-1"
            />
          </label>
          <button
            onClick={register}
            disabled={busy || !name.trim() || !sourceValue.trim()}
            className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Register
          </button>
        </div>
      </section>

      <div className="mt-6 space-y-4">
        {repos.length === 0 && <p className="text-sm text-slate-500">No repos yet. Register one above.</p>}
        {repos.map((repo) => {
          const run = runs.find((r) => r.repoId === repo.id);
          const busyNow = repo.status === "profiling" || repo.status === "indexing";
          return (
            <section key={repo.id} className="rounded-lg border bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="font-medium">{repo.name}</h2>
                <span className="font-mono text-xs text-slate-500">{repo.id}</span>
                <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_STYLE[repo.status]}`}>{repo.status}</span>
                {repo.indexedCommitSha && <span className="font-mono text-xs text-slate-500">@ {repo.indexedCommitSha.slice(0, 8)}</span>}
                <div className="ml-auto flex items-center gap-2 text-sm">
                  <select
                    value={strategy[repo.id] ?? "auto"}
                    onChange={(e) => setStrategy((s) => ({ ...s, [repo.id]: e.target.value as Strategy | "auto" }))}
                    disabled={busyNow}
                    className="rounded border px-2 py-1"
                    title="Which pipeline to run"
                  >
                    <option value="auto">Recommended{repo.profile ? ` (${repo.profile.recommendation})` : ""}</option>
                    <option value="full">Full (embeddings)</option>
                    <option value="claude-md-only">CLAUDE.md only</option>
                  </select>
                  <button
                    onClick={() => void index(repo)}
                    disabled={busyNow}
                    className="rounded bg-slate-900 px-3 py-1.5 text-white disabled:opacity-50"
                  >
                    {repo.status === "indexing" ? "Indexing…" : repo.indexedAt ? "Re-index" : "Index"}
                  </button>
                </div>
              </div>
              <p className="mt-1 break-all text-xs text-slate-500">
                {repo.source.type === "url" ? "Git URL" : "Folder"}: {repo.source.value}
              </p>
              {repo.error && <p className="mt-2 text-sm text-red-700">{repo.error}</p>}
              {repo.profile && (
                <div className="mt-3 text-sm">
                  <p>
                    {repo.profile.totalFiles} files, {repo.profile.totalLoc.toLocaleString()} lines of code:{" "}
                    {repo.profile.languages.map((l) => `${l.language} ${l.files} files / ${l.loc.toLocaleString()} lines`).join(" · ") ||
                      "no source code"}
                  </p>
                  <p className="mt-1 text-slate-600">
                    Recommended: <b>{repo.profile.recommendation}</b>. {repo.profile.reason}
                  </p>
                </div>
              )}
              {run && <Progress run={run} />}
            </section>
          );
        })}
      </div>
    </div>
  );
}
