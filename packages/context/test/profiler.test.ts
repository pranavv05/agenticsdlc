import { RepoProfileSchema } from "@sdd/contracts";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { languageOfFile } from "../src/languages";
import { FULL_PIPELINE_MIN_SOURCE_FILES, MAX_COUNTED_FILE_BYTES, profileRepo, recommendStrategy } from "../src/profiler";
import { FIXTURES, rmrf, tmpDir, write } from "./helpers/repos";

const dirs: string[] = [];
const fresh = () => {
  const d = tmpDir("sdd-profile-");
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach(rmrf));

describe("profileRepo on two different real repos", () => {
  it("TypeScript fixture: counts files and non-empty lines per language", async () => {
    const profile = await profileRepo(path.join(FIXTURES, "sample-repo"));
    expect(profile).toMatchObject({
      totalFiles: 8, // 6 source files + package.json + README.md
      totalLoc: 63,
      languages: [{ language: "TypeScript", files: 6, loc: 63 }],
      recommendation: "claude-md-only",
    });
    expect(profile.reason).toContain("6 source files");
    expect(profile.reason).toContain("under 200");
  });

  it("Java fixture: a different language, a different count", async () => {
    const profile = await profileRepo(path.join(FIXTURES, "java-sample"));
    expect(profile).toMatchObject({
      totalFiles: 3,
      totalLoc: 23,
      languages: [{ language: "Java", files: 3, loc: 23 }],
      recommendation: "claude-md-only",
    });
  });

  it("the output is valid for the shared RepoProfile contract", async () => {
    for (const name of ["sample-repo", "java-sample"]) {
      const profile = await profileRepo(path.join(FIXTURES, name));
      expect(RepoProfileSchema.parse(profile)).toEqual(profile);
      expect(JSON.parse(JSON.stringify(profile))).toEqual(profile); // plain JSON
    }
  });
});

describe("profileRepo: what is counted", () => {
  it("excludes dependency folders, build output, and everything .gitignore covers (root and nested)", async () => {
    const dir = fresh();
    write(dir, "src/app.ts", "export const a = 1;\nexport const b = 2;\n");
    write(dir, "node_modules/dep/index.js", "module.exports = 1;\n".repeat(50));
    write(dir, "dist/bundle.js", "var x;\n".repeat(50));
    write(dir, "build/out.js", "var x;\n".repeat(50));
    write(dir, ".git/hooks/pre-commit.sh", "#!/bin/sh\n");
    write(dir, "generated/api.ts", "export const gen = 1;\n".repeat(30));
    write(dir, "debug.log", "noise\n");
    write(dir, "pkg/keep.ts", "export const keep = 1;\n");
    write(dir, "pkg/local.ts", "export const local = 1;\n".repeat(30));
    write(dir, ".gitignore", "generated/\n*.log\n");
    write(dir, "pkg/.gitignore", "local.ts\n");

    const profile = await profileRepo(dir);
    expect(profile.languages).toEqual([{ language: "TypeScript", files: 2, loc: 3 }]);
    expect(profile.totalFiles).toBe(4); // src/app.ts, pkg/keep.ts and the two .gitignore files
  });

  it("counts only non-empty lines, whatever the line endings", async () => {
    const dir = fresh();
    write(dir, "a.py", "import os\r\n\r\n\r\ndef f():\r\n    return 1\r\n\r\n");
    write(dir, "b.py", "\n\n   \n\t\n");
    const profile = await profileRepo(dir);
    expect(profile.languages).toEqual([{ language: "Python", files: 2, loc: 3 }]);
  });

  it("detects many languages, sorted by lines of code (then files)", async () => {
    const dir = fresh();
    write(dir, "a.go", "package main\nfunc main() {}\nfunc other() {}\n");
    write(dir, "b.rs", "fn main() {}\n");
    write(dir, "c.ts", "export const x = 1;\n");
    write(dir, "d.ts", "export const y = 2;\n");
    write(dir, "e.cpp", "int main() { return 0; }\n");
    write(dir, "f.sh", "echo hi\n");
    const profile = await profileRepo(dir);
    expect(profile.languages.map((l) => l.language)).toEqual(["Go", "TypeScript", "C++", "Rust", "Shell"]);
    expect(profile.languages[0]).toEqual({ language: "Go", files: 1, loc: 3 });
    expect(profile.languages[1]).toEqual({ language: "TypeScript", files: 2, loc: 2 });
  });

  it("counts markup, data and prose in totalFiles but not as languages", async () => {
    const dir = fresh();
    write(dir, "page.html", "<p>hi</p>");
    write(dir, "style.css", "a{}");
    write(dir, "data.json", "{}");
    write(dir, "README.md", "# hi");
    write(dir, "logo.png", "not really a png");
    write(dir, "a.ts", "export {};\n");
    const profile = await profileRepo(dir);
    expect(profile.totalFiles).toBe(6);
    expect(profile.languages).toEqual([{ language: "TypeScript", files: 1, loc: 1 }]);
    expect(profile.totalLoc).toBe(1);
  });

  it("counts a very large file as a file but does not read its lines", async () => {
    const dir = fresh();
    write(dir, "bundle.js", "x".repeat(MAX_COUNTED_FILE_BYTES + 1));
    write(dir, "small.js", "var a;\n");
    const profile = await profileRepo(dir);
    expect(profile.languages).toEqual([{ language: "JavaScript", files: 2, loc: 1 }]);
  });

  it("handles an empty repo and a missing folder", async () => {
    const empty = await profileRepo(fresh());
    expect(empty).toMatchObject({ totalFiles: 0, totalLoc: 0, languages: [], recommendation: "claude-md-only" });
    expect(empty.reason).toMatch(/no source files/i);
    expect(await profileRepo(path.join(fresh(), "missing"))).toMatchObject({ totalFiles: 0 }); // walking a missing folder finds nothing
  });

  it("recognises file types by extension, case-insensitively", () => {
    expect(languageOfFile("src/App.TSX")).toBe("TypeScript");
    expect(languageOfFile("a/b/c.PY")).toBe("Python");
    expect(languageOfFile("Makefile")).toBeNull();
    expect(languageOfFile("notes.txt")).toBeNull();
    expect(languageOfFile("archive.tar.gz")).toBeNull();
  });
});

describe("recommendStrategy (scope section 6.1)", () => {
  it("recommends claude-md-only below 200 source files and full from 200 up", () => {
    expect(FULL_PIPELINE_MIN_SOURCE_FILES).toBe(200);
    expect(recommendStrategy({ sourceFiles: 199, chunkableFiles: 199 }).recommendation).toBe("claude-md-only");
    expect(recommendStrategy({ sourceFiles: 200, chunkableFiles: 200 }).recommendation).toBe("full");
    expect(recommendStrategy({ sourceFiles: 999, chunkableFiles: 999 }).recommendation).toBe("full");
    expect(recommendStrategy({ sourceFiles: 1, chunkableFiles: 1 }).recommendation).toBe("claude-md-only");
  });

  it("explains itself with the numbers and the rule, and flags monorepo scale", () => {
    expect(recommendStrategy({ sourceFiles: 199, chunkableFiles: 199 }).reason).toMatch(/199 source files is under 200/);
    expect(recommendStrategy({ sourceFiles: 250, chunkableFiles: 250 }).reason).toMatch(/250 source files is at least 200/);
    expect(recommendStrategy({ sourceFiles: 250, chunkableFiles: 250 }).reason).not.toMatch(/monorepo/);
    expect(recommendStrategy({ sourceFiles: 1200, chunkableFiles: 1200 }).reason).toMatch(/monorepo scale/);
  });

  it("falls back to claude-md-only when nothing can be chunked, however big the repo", () => {
    const go = recommendStrategy({ sourceFiles: 5000, chunkableFiles: 0 });
    expect(go.recommendation).toBe("claude-md-only");
    expect(go.reason).toMatch(/5000 source files is in a language the chunker supports|None of its 5000 source files/);
    expect(go.reason).toContain("TypeScript, JavaScript, Python, Java");
    expect(recommendStrategy({ sourceFiles: 0, chunkableFiles: 0 }).reason).toMatch(/no source files/i);
  });

  it("recommends full for a large repo that is mostly unsupported languages but has some supported files", () => {
    expect(recommendStrategy({ sourceFiles: 900, chunkableFiles: 40 }).recommendation).toBe("full");
  });

  it("a big real-shaped repo is recommended full end to end", async () => {
    const dir = fresh();
    for (let i = 0; i < 200; i++) write(dir, `src/m${i % 10}/f${i}.ts`, `export const v${i} = ${i};\n`);
    const profile = await profileRepo(dir);
    expect(profile.languages).toEqual([{ language: "TypeScript", files: 200, loc: 200 }]);
    expect(profile.recommendation).toBe("full");
    expect(fs.readdirSync(dir).length).toBe(1);
  });
});
