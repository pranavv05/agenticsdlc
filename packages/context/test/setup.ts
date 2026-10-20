import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

// Tests are offline and keyless. The only thing taken from the repo-root .env is DATABASE_URL, which switches on the
// Postgres tests. API keys and LLM_MODE are deliberately NOT loaded, so a test can never make a real model call by accident.
const envFile = path.resolve(import.meta.dirname, "../../../.env");
if (!process.env.DATABASE_URL && fs.existsSync(envFile)) {
  const url = dotenv.parse(fs.readFileSync(envFile))["DATABASE_URL"];
  if (url) process.env.DATABASE_URL = url;
}
