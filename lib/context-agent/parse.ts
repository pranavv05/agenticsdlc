import path from "node:path";
import { Parser, Language, type Node } from "web-tree-sitter";

export type LangId = "typescript" | "tsx" | "python" | "java";

const EXT_TO_LANG: Record<string, LangId> = {
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".tsx": "tsx", ".jsx": "tsx",
  ".js": "typescript", ".mjs": "typescript", ".cjs": "typescript",
  ".py": "python",
  ".java": "java",
};

const WASM: Record<LangId, [pkg: string, file: string]> = {
  typescript: ["tree-sitter-typescript", "tree-sitter-typescript.wasm"],
  tsx: ["tree-sitter-typescript", "tree-sitter-tsx.wasm"],
  python: ["tree-sitter-python", "tree-sitter-python.wasm"],
  java: ["tree-sitter-java", "tree-sitter-java.wasm"],
};

export function langForFile(rel: string): LangId | null {
  return EXT_TO_LANG[path.extname(rel).toLowerCase()] ?? null;
}

export function isSourceFile(rel: string): boolean {
  return langForFile(rel) !== null;
}

let initPromise: Promise<void> | null = null;
const languages = new Map<LangId, Promise<Language>>();

function loadLanguage(id: LangId): Promise<Language> {
  let p = languages.get(id);
  if (!p) {
    const [pkg, file] = WASM[id];
    p = Language.load(path.join(process.cwd(), "node_modules", pkg, file));
    languages.set(id, p);
  }
  return p;
}

/** Parse `code` and run `fn` on the root node; the tree is freed afterwards. */
export async function withTree<T>(code: string, lang: LangId, fn: (root: Node) => T): Promise<T> {
  initPromise ??= Parser.init();
  await initPromise;
  const language = await loadLanguage(lang);
  const parser = new Parser();
  try {
    parser.setLanguage(language);
    const tree = parser.parse(code);
    if (!tree) throw new Error("tree-sitter returned no tree");
    try {
      return fn(tree.rootNode);
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}
