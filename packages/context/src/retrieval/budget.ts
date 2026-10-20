import type { ClaudeMdSection, ContextBundle, ContextChunk, RetrievalMode } from "@sdd/contracts";

export const DEFAULT_BUDGET_TOKENS = 12_000;
export const TRUNCATION_MARKER = "\n…(truncated)";

/** Share of the budget the documentation parts may use; the rest is left for code chunks. */
const SECTIONS_SHARE = 0.3;
const MINDMAP_SHARE = 0.1;
/** A chunk is only cut to fit if at least this many tokens are left; otherwise it is dropped. */
const MIN_PARTIAL_CHUNK_TOKENS = 150;

/** Rough token count used everywhere for budgeting (about four characters per token, as the gateway does). */
export const estimateTokens = (chars: number): number => Math.ceil(chars / 4);

/** What a chunk costs once it is part of a bundle: its code plus the path and symbol a reader sees with it. */
export const chunkTokens = (c: Pick<ContextChunk, "code" | "filePath" | "symbolName">): number =>
  estimateTokens(c.code.length + c.filePath.length + (c.symbolName?.length ?? 0) + 24);

export const sectionTokens = (s: Pick<ClaudeMdSection, "content" | "path">): number =>
  estimateTokens(s.content.length + s.path.length + 12);

const charsFor = (tokens: number) => Math.max(0, tokens * 4);

/** Cuts `text` to at most `maxTokens` and appends the marker (which is counted). Text that already fits is returned as is. */
export function truncateText(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (estimateTokens(text.length) <= maxTokens) return { text, truncated: false };
  const room = charsFor(maxTokens) - TRUNCATION_MARKER.length;
  return { text: room > 0 ? text.slice(0, room) + TRUNCATION_MARKER : "", truncated: true };
}

export interface BundleParts {
  mode: RetrievalMode | null;
  /** Best first. Primary hits, then dependency neighbours. */
  chunks: ContextChunk[];
  /** Most relevant first. */
  sections: ClaudeMdSection[];
  mindmap: string;
}

/**
 * Fits the parts into `budgetTokens`: the result's `tokenEstimate` never exceeds the budget.
 *  1. documentation is capped first (sections 30%, mind map 10% of the budget), most relevant section first;
 *  2. code chunks then take what is left, in rank order; the first chunk that does not fit is cut (with a marker) when
 *     enough room remains, otherwise dropped, and nothing after it is included, so rank order is never inverted.
 * `truncated` is true whenever anything was cut or left out.
 */
export function assembleBundle(parts: BundleParts, budgetTokens: number): ContextBundle {
  if (!Number.isInteger(budgetTokens) || budgetTokens < 1)
    throw new RangeError(`budgetTokens must be a positive integer, got ${budgetTokens}`);
  let truncated = false;

  // --- mind map ---
  const mapCap = Math.floor(budgetTokens * MINDMAP_SHARE);
  const map = parts.mindmap ? truncateText(parts.mindmap, mapCap) : { text: "", truncated: false };
  truncated ||= map.truncated;
  const mindmap = map.text;

  // --- documentation sections ---
  let sectionBudget = Math.floor(budgetTokens * SECTIONS_SHARE);
  const sections: ClaudeMdSection[] = [];
  for (const s of parts.sections) {
    if (sectionBudget <= 0) {
      truncated = true;
      break;
    }
    const cost = sectionTokens(s);
    if (cost <= sectionBudget) {
      sections.push(s);
      sectionBudget -= cost;
      continue;
    }
    const header = estimateTokens(s.path.length + 12);
    const room = sectionBudget - header;
    const cut = room > 0 ? truncateText(s.content, room) : { text: "", truncated: true };
    truncated = true;
    if (cut.text) {
      sections.push({ ...s, content: cut.text });
    }
    break;
  }
  if (sections.length < parts.sections.length) truncated = true;

  // --- code chunks ---
  let remaining = budgetTokens - estimateTokens(mindmap.length) - sections.reduce((n, s) => n + sectionTokens(s), 0);
  const chunks: ContextChunk[] = [];
  for (const c of parts.chunks) {
    const cost = chunkTokens(c);
    if (cost <= remaining) {
      chunks.push(c);
      remaining -= cost;
      continue;
    }
    truncated = true;
    if (remaining >= MIN_PARTIAL_CHUNK_TOKENS) {
      const overhead = chunkTokens({ ...c, code: "" });
      const cut = truncateText(c.code, remaining - overhead);
      if (cut.text) {
        chunks.push({ ...c, code: cut.text });
      }
    }
    break;
  }
  if (chunks.length < parts.chunks.length) truncated = true;

  const tokenEstimate =
    chunks.reduce((n, c) => n + chunkTokens(c), 0) + sections.reduce((n, s) => n + sectionTokens(s), 0) + estimateTokens(mindmap.length);
  return {
    mode: parts.mode,
    chunks,
    relevantClaudeMdSections: sections,
    relevantMindmapExcerpt: mindmap,
    tokenEstimate,
    truncated,
  };
}
