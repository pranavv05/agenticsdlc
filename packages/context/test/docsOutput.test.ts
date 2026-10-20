import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DocsOutput, defaultOutputRoot, safeName } from "../src/docsOutput";
import { GENERATED_CLAUDE_MD } from "../src/walk";
import { rmrf, tmpDir, write } from "./helpers/repos";

const dirs: string[] = [];
const fresh = () => {
  const d = tmpDir();
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach(rmrf));

const walkFiles = (root: string, rel = ""): string[] =>
  fs
    .readdirSync(path.join(root, rel), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walkFiles(root, `${rel}${e.name}/`) : [`${rel}${e.name}`]))
    .sort();

describe("layout", () => {
  it("keeps docs and mind maps under <root>/<repoId>, mirroring the repo tree", () => {
    const out = new DocsOutput("/out");
    expect(out.docPath("billing", "modules/auth/CLAUDE.md.generated.md")).toBe(
      path.join("/out", "billing", "docs", "modules", "auth", "CLAUDE.md.generated.md"),
    );
    expect(out.mindmapBase("billing")).toBe(path.join("/out", "billing", "mindmap"));
    expect(out.systemBase()).toBe(path.join("/out", "system"));
  });

  it("makes repo ids safe for the filesystem", () => {
    expect(safeName("../../etc")).toBe(".._.._etc");
    expect(new DocsOutput("/out").repoDir("../evil")).toBe(path.join("/out", ".._evil"));
    for (const name of ["..", ".", "", "..."]) {
      const dir = new DocsOutput("/out").repoDir(name);
      expect(path.dirname(path.resolve(dir))).toBe(path.resolve("/out"));
      expect(path.basename(dir)).not.toMatch(/^\.*$/);
    }
  });

  it("defaults to ./output and honours CONTEXT_OUTPUT_DIR", () => {
    expect(defaultOutputRoot({})).toBe(path.join(process.cwd(), "output"));
    expect(defaultOutputRoot({ CONTEXT_OUTPUT_DIR: "/data/ctx" })).toBe(path.resolve("/data/ctx"));
    expect(defaultOutputRoot({ CONTEXT_OUTPUT_DIR: "  " })).toBe(path.join(process.cwd(), "output"));
  });
});

describe("writing", () => {
  it("writes files with a trailing newline and leaves no temp files behind", async () => {
    const root = fresh();
    const out = new DocsOutput(root);
    await out.writeDocs(
      "r",
      new Map([
        ["modules/a/CLAUDE.md.generated.md", "# A"],
        [GENERATED_CLAUDE_MD, "# Root\n"],
      ]),
    );
    expect(fs.readFileSync(out.docPath("r", "modules/a/CLAUDE.md.generated.md"), "utf8")).toBe("# A\n");
    expect(fs.readFileSync(out.docPath("r", GENERATED_CLAUDE_MD), "utf8")).toBe("# Root\n");
    expect(walkFiles(root).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("reads back, truncates with a marker, and reports a missing file as null", async () => {
    const out = new DocsOutput(fresh());
    await out.writeDocs("r", new Map([["x/CLAUDE.md.generated.md", "a".repeat(100)]]));
    expect(await out.read("r", "x/CLAUDE.md.generated.md", 10)).toBe("a".repeat(10) + "\n…(truncated)");
    expect(await out.read("r", "missing.md")).toBeNull();
    expect(await out.hasDocs("r")).toBe(false);
    await out.writeDocs("r", new Map([[GENERATED_CLAUDE_MD, "# root"]]));
    expect(await out.hasDocs("r")).toBe(true);
  });

  it("writeDocs keeps files it was not given; replaceDocs removes them", async () => {
    const root = fresh();
    const out = new DocsOutput(root);
    await out.writeDocs(
      "r",
      new Map([
        ["old/CLAUDE.md.generated.md", "old"],
        [GENERATED_CLAUDE_MD, "root v1"],
      ]),
    );
    await out.writeDocs("r", new Map([[GENERATED_CLAUDE_MD, "root v2"]]));
    expect(walkFiles(out.docsDir("r"))).toEqual(["CLAUDE.md.generated.md", "old/CLAUDE.md.generated.md"]);

    await out.replaceDocs(
      "r",
      new Map([
        [GENERATED_CLAUDE_MD, "root v3"],
        ["new/CLAUDE.md.generated.md", "new"],
      ]),
    );
    expect(walkFiles(out.docsDir("r"))).toEqual(["CLAUDE.md.generated.md", "new/CLAUDE.md.generated.md"]);
    expect(await out.read("r", GENERATED_CLAUDE_MD)).toBe("root v3\n");
    expect(fs.readdirSync(out.repoDir("r")).filter((n) => n.includes(".next"))).toEqual([]);
  });

  it("replaceDocs with nothing to write leaves an empty docs folder", async () => {
    const out = new DocsOutput(fresh());
    await out.writeDocs("r", new Map([[GENERATED_CLAUDE_MD, "x"]]));
    await out.replaceDocs("r", new Map());
    expect(fs.existsSync(out.docsDir("r"))).toBe(true);
    expect(await out.hasDocs("r")).toBe(false);
  });

  it("writes a mind map as .mmd and .md", async () => {
    const out = new DocsOutput(fresh());
    await out.writeMindmap(out.mindmapBase("r"), "R — structure", "flowchart LR\n  A --> B", "Explanation.");
    expect(fs.readFileSync(`${out.mindmapBase("r")}.mmd`, "utf8")).toBe("flowchart LR\n  A --> B\n");
    const md = await out.readMindmap(out.mindmapBase("r"));
    expect(md).toContain("# R — structure");
    expect(md).toContain("```mermaid\nflowchart LR\n  A --> B\n```");
    expect(md).toContain("Explanation.");
  });
});

describe("publishToRepo (opt-in copy into the working tree)", () => {
  const generate = async (out: DocsOutput) =>
    out.writeDocs(
      "r",
      new Map([
        [GENERATED_CLAUDE_MD, "# root"],
        ["modules/auth/CLAUDE.md.generated.md", "# auth"],
        ["notes.txt", "not a generated doc"],
      ]),
    );

  it("copies the generated docs to the same relative paths", async () => {
    const out = new DocsOutput(fresh());
    await generate(out);
    const repo = fresh();
    const result = await out.publishToRepo("r", repo);
    expect(result).toEqual({ written: ["CLAUDE.md.generated.md", "modules/auth/CLAUDE.md.generated.md"], skipped: [] });
    expect(fs.readFileSync(path.join(repo, "modules/auth/CLAUDE.md.generated.md"), "utf8")).toBe("# auth\n");
    expect(fs.existsSync(path.join(repo, "notes.txt"))).toBe(false); // only generated docs are copied
  });

  it("never creates or touches a real CLAUDE.md", async () => {
    const out = new DocsOutput(fresh());
    await generate(out);
    const repo = fresh();
    write(repo, "CLAUDE.md", "human written, hands off");
    write(repo, "modules/auth/CLAUDE.md", "also human written");
    await out.publishToRepo("r", repo, { overwrite: true });
    expect(fs.readFileSync(path.join(repo, "CLAUDE.md"), "utf8")).toBe("human written, hands off");
    expect(fs.readFileSync(path.join(repo, "modules/auth/CLAUDE.md"), "utf8")).toBe("also human written");
    expect(
      walkFiles(repo)
        .filter((f) => f.endsWith("/CLAUDE.md") || f === "CLAUDE.md")
        .sort(),
    ).toEqual(["CLAUDE.md", "modules/auth/CLAUDE.md"]);
  });

  it("keeps an existing CLAUDE.md.generated.md unless overwrite is set", async () => {
    const out = new DocsOutput(fresh());
    await generate(out);
    const repo = fresh();
    write(repo, GENERATED_CLAUDE_MD, "a human edited this");
    const first = await out.publishToRepo("r", repo);
    expect(first).toEqual({ written: ["modules/auth/CLAUDE.md.generated.md"], skipped: ["CLAUDE.md.generated.md"] });
    expect(fs.readFileSync(path.join(repo, GENERATED_CLAUDE_MD), "utf8")).toBe("a human edited this");

    const second = await out.publishToRepo("r", repo, { overwrite: true });
    expect(second.skipped).toEqual([]);
    expect(fs.readFileSync(path.join(repo, GENERATED_CLAUDE_MD), "utf8")).toBe("# root\n");
  });

  it("does nothing when there are no docs", async () => {
    const out = new DocsOutput(fresh());
    expect(await out.publishToRepo("none", fresh())).toEqual({ written: [], skipped: [] });
  });
});
