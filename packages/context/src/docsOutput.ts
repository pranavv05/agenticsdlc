import fs from "node:fs/promises";
import path from "node:path";
import { GENERATED_CLAUDE_MD } from "./walk";

/** Where generated documentation goes unless told otherwise: ./output, or CONTEXT_OUTPUT_DIR. */
export function defaultOutputRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.CONTEXT_OUTPUT_DIR?.trim() ? path.resolve(env.CONTEXT_OUTPUT_DIR) : path.join(process.cwd(), "output");
}

/** Filesystem-safe form of a repo id or name. */
export function safeName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]+/g, "_");
  // "." and ".." would point at the current or parent directory once joined to a path
  return /^\.*$/.test(safe) ? `_${safe}` : safe;
}

export const SYSTEM_MINDMAP_BASE = "system";

/**
 * Generated documentation lives OUTSIDE the target repo:
 *
 *   <root>/<repoId>/docs/<module dir>/CLAUDE.md.generated.md   per-module docs, mirroring the repo tree
 *   <root>/<repoId>/docs/CLAUDE.md.generated.md                root doc
 *   <root>/<repoId>/mindmap.md, mindmap.mmd                    per-repo mind map
 *   <root>/system.md, system.mmd                               system-level mind map
 *
 * Writing into a working tree dirties it (which breaks incremental indexing) and risks clobbering a human's files.
 * `publishToRepo` copies the docs into the repo, only when explicitly asked.
 */
export class DocsOutput {
  constructor(readonly root: string) {}

  repoDir(repoId: string): string {
    return path.join(this.root, safeName(repoId));
  }

  docsDir(repoId: string): string {
    return path.join(this.repoDir(repoId), "docs");
  }

  docPath(repoId: string, relPath: string): string {
    return path.join(this.docsDir(repoId), ...relPath.split("/"));
  }

  mindmapBase(repoId: string): string {
    return path.join(this.repoDir(repoId), "mindmap");
  }

  systemBase(): string {
    return path.join(this.root, SYSTEM_MINDMAP_BASE);
  }

  /** Writes files (path relative to `dir`, content). Each file lands atomically: a crash never leaves a half-written doc. */
  async writeAll(dir: string, files: Map<string, string>): Promise<void> {
    for (const [rel, content] of files) {
      const target = path.join(dir, ...rel.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      const tmp = `${target}.${process.pid}.tmp`;
      await fs.writeFile(tmp, content.endsWith("\n") ? content : content + "\n", "utf8");
      await fs.rename(tmp, target);
    }
  }

  async writeDocs(repoId: string, files: Map<string, string>): Promise<void> {
    await this.writeAll(this.docsDir(repoId), files);
  }

  /**
   * Replaces the repo's whole docs folder (so docs of modules that no longer exist disappear). The new tree is built
   * next to the old one and swapped in, so the old docs stay in place until the new ones are completely written.
   */
  async replaceDocs(repoId: string, files: Map<string, string>): Promise<void> {
    const target = this.docsDir(repoId);
    const staging = `${target}.next-${process.pid}`;
    await fs.rm(staging, { recursive: true, force: true });
    await this.writeAll(staging, files);
    await fs.mkdir(staging, { recursive: true }); // an empty file set still produces an (empty) docs folder
    await fs.rm(target, { recursive: true, force: true });
    await fs.rename(staging, target);
  }

  async read(repoId: string, relPath: string, maxChars = Infinity): Promise<string | null> {
    return readTruncated(this.docPath(repoId, relPath), maxChars);
  }

  /** True when the repo's root doc exists, which means a docs run completed. */
  async hasDocs(repoId: string): Promise<boolean> {
    try {
      await fs.access(this.docPath(repoId, GENERATED_CLAUDE_MD));
      return true;
    } catch {
      return false;
    }
  }

  /** Repo-relative paths of every generated CLAUDE.md under the repo's docs folder (the root one is `CLAUDE.md.generated.md`), sorted. */
  async listDocs(repoId: string): Promise<string[]> {
    const root = this.docsDir(repoId);
    const found: string[] = [];
    const visit = async (dir: string, rel: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await visit(path.join(dir, e.name), childRel);
        else if (e.isFile() && e.name === GENERATED_CLAUDE_MD) found.push(childRel);
      }
    };
    await visit(root, "");
    return found.sort();
  }

  /** Writes `<base>.mmd` and `<base>.md` for a mind map. */
  async writeMindmap(base: string, title: string, mermaid: string, prose: string): Promise<void> {
    const dir = path.dirname(base);
    const name = path.basename(base);
    await this.writeAll(
      dir,
      new Map([
        [`${name}.mmd`, mermaid],
        [`${name}.md`, `# ${title}\n\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n\n${prose}`],
      ]),
    );
  }

  async readMindmap(base: string, maxChars = Infinity): Promise<string | null> {
    return readTruncated(`${base}.md`, maxChars);
  }

  /**
   * Copies the generated docs into the repo's working tree. Opt-in only.
   * Never creates or overwrites a file called CLAUDE.md; an existing CLAUDE.md.generated.md is kept unless `overwrite` is set.
   */
  async publishToRepo(
    repoId: string,
    repoPath: string,
    options: { overwrite?: boolean } = {},
  ): Promise<{ written: string[]; skipped: string[] }> {
    const written: string[] = [];
    const skipped: string[] = [];
    const docs = this.docsDir(repoId);

    const visit = async (dir: string, rel: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await visit(path.join(dir, e.name), childRel);
        else if (e.isFile() && e.name === GENERATED_CLAUDE_MD) {
          const dest = path.join(repoPath, ...childRel.split("/"));
          const exists = await fs.access(dest).then(
            () => true,
            () => false,
          );
          if (exists && !options.overwrite) {
            skipped.push(childRel);
            continue;
          }
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.copyFile(path.join(dir, e.name), dest);
          written.push(childRel);
        }
      }
    };
    await visit(docs, "");
    return { written: written.sort(), skipped: skipped.sort() };
  }
}

async function readTruncated(file: string, maxChars: number): Promise<string | null> {
  try {
    const text = await fs.readFile(file, "utf8");
    return text.length > maxChars ? text.slice(0, maxChars) + "\n…(truncated)" : text;
  } catch {
    return null;
  }
}
