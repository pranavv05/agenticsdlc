import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Stable key for a call: the first 16 hex characters of sha256 over (agent, schema name, input). */
export function fixtureKey(agent: string, name: string, input: string): string {
  return createHash("sha256")
    .update(JSON.stringify([agent, name, input]))
    .digest("hex")
    .slice(0, 16);
}

export interface FixtureEntry {
  /** Structured data for generateStructured, or a string for generateText. */
  data: unknown;
  /** Token counts to report. Estimated from the input and output size when absent. */
  usage?: { inputTokens: number; outputTokens: number };
}

/** The file format stored in the fixtures directory. */
export interface FixtureFile extends FixtureEntry {
  agent: string;
  name: string;
  key: string;
  /** First characters of the input, to help a human recognise the fixture. Not used for lookup. */
  inputPreview: string;
  recordedWith?: string;
}

/** Builds a response for calls it recognises; return undefined to let the next source try. */
export type Responder = (input: string) => FixtureEntry["data"] | undefined;

export function defaultFixturesDir(): string {
  try {
    // path.resolve on a plain string, not `new URL("../fixtures", import.meta.url)`: bundlers treat that form as an asset import.
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures");
  } catch {
    return path.join(process.cwd(), "fixtures");
  }
}

/**
 * Where mock mode finds its answers. Lookup order:
 *   1. entries added in memory with `put` (tests),
 *   2. recorded files `<dir>/<agent>/<name>/<key>.json`,
 *   3. responders registered with `respond(agent, name, fn)`.
 */
export class FixtureStore {
  private readonly memory = new Map<string, FixtureEntry>();
  private readonly responders = new Map<string, Responder>();
  readonly dir: string;

  constructor(options: { dir?: string } = {}) {
    this.dir = options.dir ?? defaultFixturesDir();
  }

  private filePath(agent: string, name: string, key: string): string {
    return path.join(this.dir, safeSegment(agent), safeSegment(name), `${key}.json`);
  }

  put(agent: string, name: string, input: string, entry: FixtureEntry): void {
    this.memory.set(fixtureKey(agent, name, input), entry);
  }

  respond(agent: string, name: string, responder: Responder): void {
    this.responders.set(`${agent}/${name}`, responder);
  }

  get(agent: string, name: string, input: string): FixtureEntry | undefined {
    const key = fixtureKey(agent, name, input);
    const inMemory = this.memory.get(key);
    if (inMemory) return inMemory;

    const file = this.filePath(agent, name, key);
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as FixtureFile;
      return { data: parsed.data, usage: parsed.usage };
    }

    const data = this.responders.get(`${agent}/${name}`)?.(input);
    return data === undefined ? undefined : { data };
  }

  /** Writes a fixture file (record mode). */
  record(agent: string, name: string, input: string, entry: FixtureEntry, recordedWith: string): string {
    const key = fixtureKey(agent, name, input);
    const file = this.filePath(agent, name, key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body: FixtureFile = { agent, name, key, inputPreview: input.slice(0, 200), recordedWith, ...entry };
    fs.writeFileSync(file, JSON.stringify(body, null, 2) + "\n");
    return file;
  }
}

function safeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_");
}
