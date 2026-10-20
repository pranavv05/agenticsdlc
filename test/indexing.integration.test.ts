import { afterAll, beforeAll, describe, expect, it } from "vitest";
import dotenv from "dotenv";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

const haveLlm = process.env.LLM_PROVIDER === "bedrock" ? !!process.env.BEDROCK_API_KEY : !!process.env.ANTHROPIC_API_KEY;
const haveKeys = !!(haveLlm && process.env.VOYAGE_API_KEY && process.env.DATABASE_URL);
const REPO_NAME = "sdd-fixture-sample-repo";

// Real end-to-end run: needs Postgres (schema.sql applied), Voyage and Anthropic keys. Skipped otherwise.
describe.skipIf(!haveKeys)("indexAllRepos on the fixture repo", () => {
  let tmp: string;
  let repoPath: string;
  let outputDir: string;
  const repos = () => [{ name: REPO_NAME, path: repoPath, description: "Fixture with auth and billing modules" }];

  beforeAll(async () => {
    // Work on a copy so generated CLAUDE.md.generated.md files don't pollute the checked-in fixture.
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-fixture-"));
    repoPath = path.join(tmp, "sample-repo");
    outputDir = path.join(tmp, "output");
    fs.cpSync(path.join(process.cwd(), "test/fixtures/sample-repo"), repoPath, { recursive: true });

    const { indexAllRepos } = await import("../lib/context-agent/pipeline");
    const result = await indexAllRepos(() => {}, { repos: repos(), outputDir });
    expect(result.failedRepos).toEqual([]);
  });

  afterAll(async () => {
    const { getPool, closePool } = await import("../lib/db");
    if (haveKeys) {
      await getPool().query("DELETE FROM chunks WHERE repo_name = $1", [REPO_NAME]);
      await getPool().query("DELETE FROM dependencies WHERE repo_name = $1", [REPO_NAME]);
    }
    await closePool();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("creates chunks for both modules", async () => {
    const { getPool } = await import("../lib/db");
    const { rows } = await getPool().query("SELECT file_path FROM chunks WHERE repo_name = $1", [REPO_NAME]);
    expect(rows.some((r) => r.file_path.includes("auth/"))).toBe(true);
    expect(rows.some((r) => r.file_path.includes("billing/"))).toBe(true);
  });

  it("writes a root and at least two module CLAUDE.md.generated.md files", () => {
    expect(fs.existsSync(path.join(repoPath, "CLAUDE.md.generated.md"))).toBe(true);
    const moduleDocs = ["modules/auth", "modules/billing"].filter((d) => fs.existsSync(path.join(repoPath, d, "CLAUDE.md.generated.md")));
    expect(moduleDocs.length).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(path.join(repoPath, "CLAUDE.md"))).toBe(false); // never create/overwrite the real one
  });

  it("writes mindmap files", () => {
    expect(fs.existsSync(path.join(outputDir, `${REPO_NAME}.mmd`))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "system.mmd"))).toBe(true);
  });

  it("returns billing chunks, not auth, for a billing query", async () => {
    const { queryContext } = await import("../lib/context-agent/query");
    const bundle = await queryContext("charge a customer's card and refund part of an invoice payment", 6, {
      repos: repos(),
      outputDir,
      repoNames: [REPO_NAME], // keep the assertion independent of any other repos already indexed
    });
    const similar = bundle.chunks.filter((c) => c.via === "similarity");
    expect(similar.length).toBeGreaterThan(0);
    expect(similar[0].filePath).toContain("billing/");
    const top3 = similar.slice(0, 3);
    expect(top3.every((c) => c.filePath.includes("billing/"))).toBe(true);
    expect(top3.some((c) => c.filePath.includes("auth/"))).toBe(false);
  });
});
