import fs from "node:fs/promises";
import path from "node:path";
import type { Node } from "web-tree-sitter";
import type { ChunkRecord, ChunkType } from "./types";
import { isSourceFile, langForFile, withTree, type LangId } from "./parse";
import { walkRepo, type WalkedFile } from "./walk";
import { log } from "./log";

const MAX_FILE_BYTES = 500_000;
const MAX_CODE_CHARS = 20_000;
const HTTP_VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const ROUTE_CALL = /\.(get|post|put|patch|delete|all|use)$/;
const PY_ROUTE_DECORATOR = /^@\s*[\w.]+\.(route|get|post|put|patch|delete|api_route)\s*\(/m;

interface Raw {
  name: string | null;
  type: ChunkType;
  node: Node;
}

/** Raw match with text/positions copied out so it outlives the tree. */
interface Materialised {
  name: string | null;
  type: ChunkType;
  text: string;
  start: number;
  end: number;
}

function nameOf(n: Node): string | null {
  return n.childForFieldName("name")?.text ?? null;
}

function isNextRouteFile(rel: string): boolean {
  return /(^|\/)route\.(ts|tsx|js|jsx|mjs)$/.test(rel);
}

function extractTs(root: Node, rel: string): Raw[] {
  const out: Raw[] = [];
  const nextRoute = isNextRouteFile(rel);

  for (const top of root.namedChildren) {
    let decl: Node | null = top;
    if (top.type === "export_statement") {
      decl = top.childForFieldName("declaration") ?? top.childForFieldName("value");
      if (!decl) continue;
    }

    switch (decl.type) {
      case "function_declaration":
      case "generator_function_declaration": {
        const name = nameOf(decl);
        out.push({ name, type: nextRoute && name && HTTP_VERBS.has(name) ? "route" : "function", node: top });
        break;
      }
      case "class_declaration":
      case "abstract_class_declaration":
        out.push({ name: nameOf(decl), type: "class", node: top });
        break;
      case "lexical_declaration":
      case "variable_declaration":
        for (const d of decl.namedChildren) {
          if (d.type !== "variable_declarator") continue;
          const value = d.childForFieldName("value");
          const name = nameOf(d);
          if (value && ["arrow_function", "function_expression", "function"].includes(value.type)) {
            out.push({ name, type: nextRoute && name && HTTP_VERBS.has(name) ? "route" : "function", node: top });
          }
        }
        break;
      case "interface_declaration":
      case "type_alias_declaration":
      case "enum_declaration":
        out.push({ name: nameOf(decl), type: "other", node: top });
        break;
      case "expression_statement": {
        // Express/Fastify-style: app.get("/path", handler)
        const call = decl.namedChildren[0];
        if (call?.type !== "call_expression") break;
        const callee = call.childForFieldName("function")?.text ?? "";
        const args = call.childForFieldName("arguments")?.namedChildren ?? [];
        const first = args[0];
        if (ROUTE_CALL.test(callee) && first && (first.type === "string" || first.type === "template_string")) {
          const method = callee.split(".").pop()!.toUpperCase();
          out.push({ name: `${method} ${first.text.slice(1, -1)}`, type: "route", node: top });
        }
        break;
      }
    }
  }
  return out;
}

const JAVA_ROUTE_ANNOTATION = /@(Get|Post|Put|Patch|Delete|Request)Mapping\b|@(GET|POST|PUT|PATCH|DELETE)\b/;
const JAVA_TYPES = new Set(["class_declaration", "interface_declaration", "enum_declaration", "record_declaration", "annotation_type_declaration"]);

/** Class-level chunk = signature + field declarations (methods get their own chunks). */
function javaClassChunk(decl: Node, name: string | null): Materialised {
  const body = decl.childForFieldName("body");
  const full = decl.text;
  let text = full;
  if (body) {
    const header = full.slice(0, full.length - body.text.length).trimEnd();
    const fields = body.namedChildren.filter((c) => c.type === "field_declaration" || c.type === "enum_constant").map((c) => "  " + c.text);
    text = `${header} {\n${fields.join("\n")}\n  // ... methods are indexed separately\n}`;
  }
  return { name, type: "class", text, start: decl.startPosition.row + 1, end: decl.endPosition.row + 1 };
}

function extractJava(root: Node): Materialised[] {
  const out: Materialised[] = [];
  const visit = (container: Node, owner: string) => {
    for (const n of container.namedChildren) {
      if (JAVA_TYPES.has(n.type)) {
        const name = nameOf(n);
        const qualified = owner ? `${owner}.${name}` : name ?? "";
        out.push(javaClassChunk(n, qualified));
        const body = n.childForFieldName("body");
        if (body) visit(body, qualified);
      } else if (n.type === "method_declaration" || n.type === "constructor_declaration") {
        const mods = n.namedChildren.find((c) => c.type === "modifiers")?.text ?? "";
        out.push({
          name: `${owner}.${nameOf(n) ?? "?"}`,
          type: JAVA_ROUTE_ANNOTATION.test(mods) ? "route" : "function",
          text: n.text,
          start: n.startPosition.row + 1,
          end: n.endPosition.row + 1,
        });
      }
    }
  };
  visit(root, "");
  return out;
}

function extractPython(root: Node): Raw[] {
  const out: Raw[] = [];
  for (const top of root.namedChildren) {
    if (top.type === "function_definition") out.push({ name: nameOf(top), type: "function", node: top });
    else if (top.type === "class_definition") out.push({ name: nameOf(top), type: "class", node: top });
    else if (top.type === "decorated_definition") {
      const def = top.childForFieldName("definition");
      if (!def) continue;
      const decorators = top.namedChildren.filter((c) => c.type === "decorator").map((c) => c.text).join("\n");
      const isRoute = PY_ROUTE_DECORATOR.test(decorators);
      const type: ChunkType = isRoute ? "route" : def.type === "class_definition" ? "class" : "function";
      out.push({ name: nameOf(def), type, node: top });
    }
  }
  return out;
}

/**
 * Walk a repo (respecting .gitignore), parse every supported source file with
 * tree-sitter and return function / class / route-level chunks.
 * Files that parse to no symbols become a single "other" chunk.
 */
export async function chunkRepo(repoPath: string, repoName: string, files?: WalkedFile[]): Promise<ChunkRecord[]> {
  const all = files ?? (await walkRepo(repoPath));
  const chunks: ChunkRecord[] = [];

  for (const f of all) {
    const lang = langForFile(f.rel);
    if (!lang || f.size > MAX_FILE_BYTES || f.size === 0) continue;
    const source = await fs.readFile(f.abs, "utf8");

    let raws: Materialised[] = [];
    try {
      raws = await withTree(source, lang as LangId, (root): Materialised[] => {
        if (lang === "java") return extractJava(root);
        const found = lang === "python" ? extractPython(root) : extractTs(root, f.rel);
        // materialise text/positions while the tree is alive
        return found.map((r) => ({
          name: r.name,
          type: r.type,
          text: r.node.text,
          start: r.node.startPosition.row + 1,
          end: r.node.endPosition.row + 1,
        }));
      });
    } catch (err) {
      log(repoName, "chunks", `parse failed for ${f.rel} (${(err as Error).message}); using whole-file chunk`);
    }

    if (raws.length === 0) {
      chunks.push({
        repoName,
        filePath: f.rel,
        symbolName: path.basename(f.rel),
        chunkType: "other",
        code: source.slice(0, MAX_CODE_CHARS),
        startLine: 1,
        endLine: source.split("\n").length,
      });
      continue;
    }
    for (const r of raws) {
      chunks.push({
        repoName,
        filePath: f.rel,
        symbolName: r.name,
        chunkType: r.type,
        code: r.text.slice(0, MAX_CODE_CHARS),
        startLine: r.start,
        endLine: r.end,
      });
    }
  }
  return chunks;
}

export { isSourceFile };
