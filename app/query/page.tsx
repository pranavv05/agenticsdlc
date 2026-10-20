"use client";

import { useState } from "react";

interface QueryChunk {
  id: number;
  repoName: string;
  filePath: string;
  symbolName: string | null;
  chunkType: string;
  code: string;
  startLine: number;
  endLine: number;
  score: number | null;
  via: "similarity" | "dependency";
}
interface Bundle {
  chunks: QueryChunk[];
  relevantClaudeMdSections: { repoName: string; path: string; content: string }[];
  relevantMindmapExcerpt: string;
}

export default function QueryPage() {
  const [text, setText] = useState("");
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featureDescription: text, topK: 15 }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? res.statusText);
      setBundle(json);
    } catch (e) {
      setError((e as Error).message);
      setBundle(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold">Query</h1>
      <p className="mt-1 text-sm text-slate-600">Describe a feature; see what context retrieval returns.</p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder="e.g. Add support for refunding a partially paid invoice"
        className="mt-4 w-full rounded border p-3 text-sm"
      />
      <button
        onClick={search}
        disabled={loading || !text.trim()}
        className="mt-2 rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {loading ? "Searching…" : "Search"}
      </button>

      {error && <div className="mt-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">{error}</div>}

      {bundle && (
        <div className="mt-8 space-y-8">
          <section>
            <h2 className="mb-3 text-lg font-medium">Chunks ({bundle.chunks.length})</h2>
            <div className="space-y-3">
              {bundle.chunks.map((c) => (
                <article key={c.id} className="rounded-lg border bg-white shadow-sm">
                  <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs">
                    <span className="rounded bg-slate-100 px-1.5 py-0.5">{c.repoName}</span>
                    <span className="font-mono">{c.filePath}:{c.startLine}-{c.endLine}</span>
                    <span className="text-slate-500">{c.chunkType} {c.symbolName}</span>
                    <span className={`ml-auto rounded px-1.5 py-0.5 ${c.via === "similarity" ? "bg-blue-100 text-blue-800" : "bg-purple-100 text-purple-800"}`}>
                      {c.via === "similarity" ? `score ${c.score?.toFixed(3)}` : "via dependency"}
                    </span>
                  </header>
                  <pre className="max-h-60 overflow-auto p-3 text-xs">{c.code.split("\n").slice(0, 25).join("\n")}</pre>
                </article>
              ))}
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-medium">CLAUDE.md excerpts</h2>
            {bundle.relevantClaudeMdSections.length === 0 && <p className="text-sm text-slate-500">None found (has indexing generated CLAUDE.md.generated.md files?).</p>}
            {bundle.relevantClaudeMdSections.map((s) => (
              <details key={`${s.repoName}:${s.path}`} className="mb-2 rounded border bg-white p-3">
                <summary className="cursor-pointer text-sm font-medium">{s.repoName} / {s.path}</summary>
                <pre className="mt-2 whitespace-pre-wrap text-xs">{s.content}</pre>
              </details>
            ))}
          </section>

          <section>
            <h2 className="mb-3 text-lg font-medium">Mindmap excerpt</h2>
            {bundle.relevantMindmapExcerpt ? (
              <pre className="whitespace-pre-wrap rounded border bg-white p-3 text-xs">{bundle.relevantMindmapExcerpt}</pre>
            ) : (
              <p className="text-sm text-slate-500">No mindmap files found in output/.</p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
