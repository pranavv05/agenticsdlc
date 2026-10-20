import fs from "node:fs/promises";
import path from "node:path";
import ignore, { type Ignore } from "ignore";

export interface WalkedFile {
  abs: string;
  rel: string; // forward slashes
  size: number;
}

const ALWAYS_IGNORED_DIRS = new Set([
  ".git", "node_modules", ".next", "dist", "build", "out", "coverage", "__pycache__",
  ".venv", "venv", ".idea", ".vscode", ".turbo", "target", ".pytest_cache", ".mypy_cache",
]);

export const GENERATED_CLAUDE_MD = "CLAUDE.md.generated.md";

interface Frame {
  base: string; // rel dir the .gitignore lives in ("" for root)
  ig: Ignore;
}

function ignored(frames: Frame[], rel: string, isDir: boolean): boolean {
  for (const f of frames) {
    if (f.base && !rel.startsWith(f.base + "/")) continue;
    const sub = f.base ? rel.slice(f.base.length + 1) : rel;
    if (f.ig.ignores(isDir ? sub + "/" : sub)) return true;
  }
  return false;
}

/** Walk a repo respecting .gitignore files (root and nested). */
export async function walkRepo(root: string): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];

  async function visit(dirAbs: string, dirRel: string, frames: Frame[]): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    let active = frames;
    if (entries.some((e) => e.isFile() && e.name === ".gitignore")) {
      try {
        const text = await fs.readFile(path.join(dirAbs, ".gitignore"), "utf8");
        active = [...frames, { base: dirRel, ig: ignore().add(text) }];
      } catch {
        /* unreadable .gitignore: carry on */
      }
    }
    for (const e of entries) {
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
      const abs = path.join(dirAbs, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (ALWAYS_IGNORED_DIRS.has(e.name) || ignored(active, rel, true)) continue;
        await visit(abs, rel, active);
      } else if (e.isFile()) {
        if (e.name === GENERATED_CLAUDE_MD || ignored(active, rel, false)) continue;
        const st = await fs.stat(abs);
        out.push({ abs, rel, size: st.size });
      }
    }
  }

  await visit(root, "", []);
  return out;
}
