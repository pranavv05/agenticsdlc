import path from "node:path";
import { isSourceFile } from "./parse";

export interface Language {
  name: string;
  extensions: readonly string[];
}

/** Programming languages the profiler counts. Markup, data and prose (HTML, CSS, JSON, YAML, Markdown) are deliberately not here. */
export const LANGUAGES: readonly Language[] = [
  { name: "TypeScript", extensions: [".ts", ".tsx", ".mts", ".cts"] },
  { name: "JavaScript", extensions: [".js", ".jsx", ".mjs", ".cjs"] },
  { name: "Python", extensions: [".py", ".pyi"] },
  { name: "Java", extensions: [".java"] },
  { name: "Kotlin", extensions: [".kt", ".kts"] },
  { name: "Go", extensions: [".go"] },
  { name: "Rust", extensions: [".rs"] },
  { name: "C", extensions: [".c", ".h"] },
  { name: "C++", extensions: [".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"] },
  { name: "C#", extensions: [".cs"] },
  { name: "Ruby", extensions: [".rb"] },
  { name: "PHP", extensions: [".php"] },
  { name: "Swift", extensions: [".swift"] },
  { name: "Scala", extensions: [".scala"] },
  { name: "Shell", extensions: [".sh", ".bash"] },
  { name: "SQL", extensions: [".sql"] },
];

const BY_EXTENSION = new Map(LANGUAGES.flatMap((l) => l.extensions.map((e) => [e, l.name] as const)));

/** The programming language of a file by its extension, or null for anything else. */
export function languageOfFile(rel: string): string | null {
  return BY_EXTENSION.get(path.extname(rel).toLowerCase()) ?? null;
}

/** Languages the chunker can parse (and therefore the full pipeline can index): see parse.ts. */
export const CHUNKABLE_LANGUAGES = ["TypeScript", "JavaScript", "Python", "Java"] as const;

/** True when the Context Agent can chunk and embed this file, not merely count it. */
export const isChunkable = (rel: string): boolean => isSourceFile(rel);
