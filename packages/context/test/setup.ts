import dotenv from "dotenv";
import { vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Tests are offline and keyless. The only thing taken from the repo-root .env is DATABASE_URL, which switches on the
// Postgres tests. API keys and LLM_MODE are deliberately NOT loaded, so a test can never make a real model call by accident.
const envFile = path.resolve(import.meta.dirname, "../../../.env");
if (!process.env.DATABASE_URL && fs.existsSync(envFile)) {
  const url = dotenv.parse(fs.readFileSync(envFile))["DATABASE_URL"];
  if (url) process.env.DATABASE_URL = url;
}

// The pipeline logs every stage; keep test output readable. Set SDD_TEST_LOGS=1 to see it.
if (!process.env.SDD_TEST_LOGS) vi.spyOn(console, "log").mockImplementation(() => {});
