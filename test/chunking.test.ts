import { describe, expect, it } from "vitest";
import path from "node:path";
import { chunkRepo } from "../lib/context-agent/chunk";
import { extractDependencies } from "../lib/context-agent/dependencies";
import { detectModules } from "../lib/context-agent/claudeMd";

const FIXTURE = path.join(process.cwd(), "test/fixtures/sample-repo");

// Needs no API keys or database: exercises tree-sitter chunking, import resolution and module detection.
describe("static analysis on the fixture repo", () => {
  it("chunks at function/route level in both modules", async () => {
    const chunks = await chunkRepo(FIXTURE, "fixture");
    const names = chunks.map((c) => `${c.filePath}::${c.symbolName}`);
    expect(names).toContain("modules/auth/tokens.ts::issueToken");
    expect(names).toContain("modules/billing/payments.ts::refundPayment");
    expect(chunks.some((c) => c.filePath.startsWith("modules/auth/"))).toBe(true);
    expect(chunks.some((c) => c.filePath.startsWith("modules/billing/"))).toBe(true);
    expect(chunks.find((c) => c.symbolName === "POST /billing/charge")?.chunkType).toBe("route");
    expect(chunks.find((c) => c.symbolName === "Invoice")?.chunkType).toBe("other");
  });

  it("resolves intra- and cross-module imports", async () => {
    const edges = await extractDependencies(FIXTURE, "fixture");
    const has = (a: string, b: string) => edges.some((e) => e.filePath === a && e.importsFilePath === b);
    expect(has("modules/auth/session.ts", "modules/auth/tokens.ts")).toBe(true);
    expect(has("modules/billing/payments.ts", "modules/billing/invoice.ts")).toBe(true);
    expect(has("modules/billing/guard.ts", "modules/auth/session.ts")).toBe(true);
  });

  it("detects auth and billing as modules", async () => {
    const dirs = (await detectModules(FIXTURE)).map((m) => m.dir);
    expect(dirs).toEqual(expect.arrayContaining(["modules/auth", "modules/billing"]));
    expect(dirs).not.toContain("modules");
  });
});

describe("java support", () => {
  const JAVA = path.join(process.cwd(), "test/fixtures/java-sample");

  it("chunks classes, methods and Spring routes", async () => {
    const chunks = await chunkRepo(JAVA, "java");
    const byName = new Map(chunks.map((c) => [c.symbolName, c]));
    expect(byName.get("InvoiceService")?.chunkType).toBe("class");
    expect(byName.get("InvoiceService.total")?.chunkType).toBe("function");
    expect(byName.get("InvoiceController.total")?.chunkType).toBe("route");
  });

  it("resolves imports (single-type and wildcard) via package declarations", async () => {
    const edges = await extractDependencies(JAVA, "java");
    const base = "src/main/java/com/acme";
    const has = (a: string, b: string) => edges.some((e) => e.filePath === `${base}/${a}` && e.importsFilePath === `${base}/${b}`);
    expect(has("billing/InvoiceService.java", "auth/AuthService.java")).toBe(true);
    expect(has("billing/InvoiceController.java", "auth/AuthService.java")).toBe(true);
  });
});
