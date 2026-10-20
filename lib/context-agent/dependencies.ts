import fs from "node:fs/promises";
import path from "node:path";
import type { Node } from "web-tree-sitter";
import type { DependencyEdge } from "./types";
import { langForFile, withTree } from "./parse";
import { walkRepo, type WalkedFile } from "./walk";

const TS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

function stripQuotes(s: string): string {
  return s.replace(/^['"`]|['"`]$/g, "");
}

function resolveTs(from: string, spec: string, files: Set<string>): string | null {
  let base: string;
  if (spec.startsWith(".")) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  else if (spec.startsWith("@/") || spec.startsWith("~/")) base = spec.slice(2);
  else return null; // bare package import (external)

  const noJsExt = base.replace(/\.(m|c)?jsx?$/, ""); // ESM-style "./x.js" pointing at x.ts
  const candidates = [base, ...TS_EXTS.map((e) => base + e), ...TS_EXTS.map((e) => `${base}/index${e}`)];
  if (noJsExt !== base) candidates.push(...TS_EXTS.map((e) => noJsExt + e));
  return candidates.find((c) => files.has(c)) ?? null;
}

function tsSpecifiers(root: Node): string[] {
  const specs: string[] = [];
  for (const n of root.descendantsOfType(["import_statement", "export_statement", "call_expression"])) {
    if (n.type === "call_expression") {
      const fn = n.childForFieldName("function");
      if (fn && (fn.text === "require" || fn.type === "import")) {
        const arg = n.childForFieldName("arguments")?.namedChildren[0];
        if (arg?.type === "string") specs.push(stripQuotes(arg.text));
      }
    } else {
      const src = n.childForFieldName("source");
      if (src) specs.push(stripQuotes(src.text));
    }
  }
  return specs;
}

function resolvePythonModule(from: string, dotted: string, files: Set<string>): string[] {
  // returns candidate base paths (without extension) for a possibly-relative dotted module
  let base: string[];
  const m = /^(\.*)(.*)$/.exec(dotted)!;
  const dots = m[1].length;
  const rest = m[2] ? m[2].split(".") : [];
  if (dots > 0) {
    let dir = path.posix.dirname(from);
    for (let i = 1; i < dots; i++) dir = path.posix.dirname(dir);
    base = [dir === "." ? "" : dir, ...rest].filter(Boolean);
    return [base.join("/")];
  }
  const joined = rest.join("/");
  return [joined, `src/${joined}`];
}

function pyFileFor(base: string, files: Set<string>): string | null {
  if (!base) return files.has("__init__.py") ? "__init__.py" : null;
  if (files.has(`${base}.py`)) return `${base}.py`;
  if (files.has(`${base}/__init__.py`)) return `${base}/__init__.py`;
  return null;
}

function pySpecifiers(root: Node, from: string, files: Set<string>): string[] {
  const out: string[] = [];
  for (const n of root.descendantsOfType(["import_statement", "import_from_statement"])) {
    if (n.type === "import_statement") {
      for (const c of n.namedChildren) {
        const dotted = c.type === "aliased_import" ? c.childForFieldName("name")?.text : c.type === "dotted_name" ? c.text : null;
        if (!dotted) continue;
        for (const b of resolvePythonModule(from, dotted, files)) {
          const hit = pyFileFor(b, files);
          if (hit) out.push(hit);
        }
      }
    } else {
      const mod = n.childForFieldName("module_name")?.text;
      if (!mod) continue;
      const bases = resolvePythonModule(from, mod, files);
      const names = n.childrenForFieldName("name").map((c) => (c.type === "aliased_import" ? c.childForFieldName("name")?.text : c.text)).filter(Boolean) as string[];
      for (const b of bases) {
        const hit = pyFileFor(b, files);
        if (hit) out.push(hit);
        for (const name of names) {
          const sub = pyFileFor(b ? `${b}/${name}` : name, files);
          if (sub) out.push(sub);
        }
      }
    }
  }
  return out;
}

/** Map "com.acme.Foo" -> file and "com.acme" -> files, from each Java file's package declaration. */
async function buildJavaIndex(files: WalkedFile[]): Promise<{ byFqn: Map<string, string>; byPackage: Map<string, string[]> }> {
  const byFqn = new Map<string, string>();
  const byPackage = new Map<string, string[]>();
  for (const f of files) {
    if (!f.rel.endsWith(".java") || f.size > 500_000) continue;
    const head = (await fs.readFile(f.abs, "utf8")).slice(0, 4000);
    const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(head)?.[1] ?? "";
    const cls = path.posix.basename(f.rel, ".java");
    byFqn.set(pkg ? `${pkg}.${cls}` : cls, f.rel);
    byPackage.set(pkg, [...(byPackage.get(pkg) ?? []), f.rel]);
  }
  return { byFqn, byPackage };
}

function javaImports(root: Node, idx: { byFqn: Map<string, string>; byPackage: Map<string, string[]> }): string[] {
  const out: string[] = [];
  for (const n of root.descendantsOfType("import_declaration")) {
    const m = /import\s+(?:static\s+)?([\w.]+?)(\.\*)?\s*;/.exec(n.text);
    if (!m) continue;
    if (m[2]) {
      out.push(...(idx.byPackage.get(m[1]) ?? []));
      continue;
    }
    // strip trailing segments to handle nested types and static member imports
    const parts = m[1].split(".");
    for (let i = parts.length; i > 0; i--) {
      const hit = idx.byFqn.get(parts.slice(0, i).join("."));
      if (hit) {
        out.push(hit);
        break;
      }
    }
  }
  return out;
}

/** Parse import/require/from-import statements and return resolved intra-repo file edges. */
export async function extractDependencies(repoPath: string, repoName: string, walked?: WalkedFile[]): Promise<DependencyEdge[]> {
  void repoName;
  const all = walked ?? (await walkRepo(repoPath));
  const sources = all.filter((f) => langForFile(f.rel));
  const fileSet = new Set(sources.map((f) => f.rel));
  const edges = new Map<string, DependencyEdge>();
  const javaIdx = await buildJavaIndex(sources);

  for (const f of sources) {
    if (f.size > 500_000) continue;
    const lang = langForFile(f.rel)!;
    const code = await fs.readFile(f.abs, "utf8");
    let targets: string[] = [];
    try {
      targets = await withTree(code, lang, (root) => {
        if (lang === "python") return pySpecifiers(root, f.rel, fileSet);
        if (lang === "java") return javaImports(root, javaIdx);
        return tsSpecifiers(root).map((s) => resolveTs(f.rel, s, fileSet)).filter((x): x is string => !!x);
      });
    } catch {
      continue;
    }
    for (const t of targets) {
      if (t === f.rel) continue;
      edges.set(`${f.rel}->${t}`, { filePath: f.rel, importsFilePath: t });
    }
  }
  return [...edges.values()];
}
