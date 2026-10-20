const MAX_FALLBACK_CHARS = 1_500;
const MAX_PROSE_CHARS = 600;

const NODE = /([A-Za-z0-9_]+)\["([^"]*)"\]/g;
const EDGE = /([A-Za-z0-9_]+)(?:\["[^"]*"\])?\s*-->(?:\|[^|]*\|)?\s*([A-Za-z0-9_]+)/;

/**
 * Cuts a per-repo mind map (the generated `.md` with a mermaid block and a short explanation) down to the modules a task
 * touches: the diagram keeps only the nodes that match those directories and the edges around them. When no node matches,
 * the (small) whole map is returned, truncated.
 */
export function excerptMindmap(markdown: string, touchedDirs: string[]): string {
  const fence = /```mermaid\s*\n([\s\S]*?)```/.exec(markdown);
  if (!fence || touchedDirs.length === 0) return fallback(markdown);

  const lines = fence[1].split("\n");
  const labels = new Map<string, string>();
  for (const line of lines) for (const m of line.matchAll(NODE)) labels.set(m[1], m[2]);

  const touched = new Set<string>();
  for (const [id, label] of labels) {
    if (touchedDirs.some((d) => label === d || label === d.split("/").pop() || d.endsWith("/" + label) || label.endsWith("/" + d)))
      touched.add(id);
  }
  if (touched.size === 0) return fallback(markdown);

  const keep = new Set<number>();
  const neighbours = new Set<string>();
  lines.forEach((line, i) => {
    if (/^\s*(flowchart|graph)\b/.test(line)) {
      keep.add(i);
      return;
    }
    const edge = EDGE.exec(line);
    if (edge && (touched.has(edge[1]) || touched.has(edge[2]))) {
      keep.add(i);
      neighbours.add(edge[1]).add(edge[2]);
      return;
    }
    const defined = [...line.matchAll(NODE)].map((m) => m[1]);
    if (defined.some((id) => touched.has(id)) && !edge) keep.add(i);
  });
  // node definitions of the neighbours of kept edges, so every id in the excerpt is declared
  lines.forEach((line, i) => {
    if (keep.has(i) || EDGE.test(line)) return;
    if ([...line.matchAll(NODE)].some((m) => neighbours.has(m[1]))) keep.add(i);
  });

  const diagram = lines.filter((_, i) => keep.has(i)).join("\n");
  const title = /^#\s+.*$/m.exec(markdown)?.[0] ?? "# Module structure";
  const prose = markdown.slice(markdown.indexOf("```", fence.index + fence[0].length - 3) + 3).trim();
  return `${title} (excerpt)\n\n\`\`\`mermaid\n${diagram}\n\`\`\`\n\n${prose.slice(0, MAX_PROSE_CHARS)}`.trim();
}

function fallback(markdown: string): string {
  return markdown.length > MAX_FALLBACK_CHARS ? markdown.slice(0, MAX_FALLBACK_CHARS) : markdown;
}
