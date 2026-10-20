import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cloneRepo } from "../src/git";
import { profileRepo } from "../src/profiler";

// Usage: pnpm --filter @sdd/context repo:profile <folder | https-or-ssh-url>
// Prints the repo profile as JSON: file count, lines of code per language and the recommended indexing strategy.
const target = process.argv[2];
if (!target) {
  console.error("Usage: pnpm --filter @sdd/context repo:profile <folder | git url>");
  process.exit(2);
}

const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(target);
let folder = path.resolve(target);
let temp: string | null = null;

try {
  if (isUrl) {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-profile-"));
    folder = path.join(temp, "repo");
    await cloneRepo(target, folder);
  } else if (!fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`"${target}" is not a folder`);
  }
  console.log(JSON.stringify(await profileRepo(folder), null, 2));
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  if (temp) fs.rmSync(temp, { recursive: true, force: true });
}
