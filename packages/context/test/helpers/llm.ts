import { FixtureStore, createEmbedder, createGateway, setEmbedder, setGateway, type Embedder, type UsageRecord } from "@sdd/llm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface MockLlm {
  usage: UsageRecord[];
  /** Number of texts sent for embedding, one entry per embed() call. */
  embedCalls: number[];
  /** The text prompts the documentation calls received, by call name. */
  prompts: { name: string; input: string }[];
  /** Make the next calls of this kind throw. */
  failEmbeddings(error?: Error): void;
  failDocs(error?: Error): void;
  /** Stop failing. */
  heal(): void;
  restore(): void;
}

const DOC_CALLS = ["module-claude-md", "root-claude-md", "repo-mindmap", "system-mindmap"];

/** Installs mock-mode gateway and embedder as the process defaults and records every call. Call `restore()` afterwards. */
export function installMockLlm(): MockLlm {
  const usage: UsageRecord[] = [];
  const prompts: MockLlm["prompts"] = [];
  const embedCalls: number[] = [];
  let embedFailure: Error | null = null;
  let docFailure: Error | null = null;

  const fixtures = new FixtureStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "sdd-fixtures-")) });
  for (const name of DOC_CALLS) {
    fixtures.respond("context", name, (input) => {
      if (docFailure) throw docFailure;
      prompts.push({ name, input });
      if (name.endsWith("mindmap")) return `\`\`\`mermaid\nflowchart LR\n  A["a"] --> B["b"]\n\`\`\`\nA short explanation of the diagram.`;
      return `# ${name}\nGenerated summary for ${name}.\n\n## Purpose\nTest.`;
    });
  }
  setGateway(createGateway({ mode: "mock", env: {}, fixtures, onUsage: (r) => void usage.push(r) }));

  const inner = createEmbedder({ mode: "mock", env: {}, onUsage: (r) => void usage.push(r) });
  const embedder: Embedder = {
    mode: "mock",
    async embed(texts, inputType) {
      if (embedFailure) throw embedFailure;
      embedCalls.push(texts.length);
      return inner.embed(texts, inputType);
    },
  };
  setEmbedder(embedder);

  return {
    usage,
    embedCalls,
    prompts,
    failEmbeddings: (error = new Error("embedding service unavailable")) => (embedFailure = error),
    failDocs: (error = new Error("documentation model unavailable")) => (docFailure = error),
    heal() {
      embedFailure = null;
      docFailure = null;
    },
    restore() {
      setGateway(undefined);
      setEmbedder(undefined);
    },
  };
}
