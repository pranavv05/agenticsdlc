import { defineConfig } from "vitest/config";

// Workspace-level entry: `pnpm vitest` from the root runs every package's tests.
// CI and `pnpm test` use `pnpm -r test`, which runs each package's own script.
export default defineConfig({
  test: { passWithNoTests: true, projects: ["packages/*", "apps/*"] },
});
