# Decisions

One line each: decision, why.

- One pnpm monorepo instead of the 11 repos in scope §4: four people, one shared contracts package, simpler CI and reviews.
- Packages are named `@sdd/<name>` and export their TypeScript source (`exports: ./src/index.ts`) with no build step: fastest feedback for a small team; Vitest and Next (`transpilePackages`) compile it directly.
- Dependency versions are pinned exactly (`.npmrc: save-exact=true`): reproducible installs, no surprise upgrades before the demo.
- TypeScript is pinned to 5.9.3, the version the prototype was built and tested on: 7.x resolved by default but is unverified with the rest of the toolchain.
- Tree-sitter native build scripts are disabled (`allowBuilds: false` in `pnpm-workspace.yaml`): the code loads the `.wasm` grammars through `web-tree-sitter`, so the native addons are never used.
- The tree-sitter `.wasm` files are located with `require.resolve` from the package instead of `process.cwd()/node_modules`: the old path breaks as soon as the code runs from another directory or under pnpm's layout.
- Tests locate fixtures with `import.meta.dirname` instead of `process.cwd()`: tests then pass from the repo root and from the package directory.
- `.gitattributes` forces LF line endings: the team uses mixed platforms and Prettier expects LF.
- The Next.js console loads the repo-root `.env` in `next.config.mjs`: one `.env` for the whole repo; variables already in the environment still win.
- `repos.config.json` and `output/` stay relative to the console app's working directory for now: Phase 4 replaces the hand-edited config with the repo profiler.
- Prettier uses `printWidth: 140`: it matches the prototype's existing style and keeps the formatting diff small.
- `llm`, `orchestrator`, `agents`, `mcp-server`, `ui` and `eval` are empty placeholder packages so teammates can start against stable names; each is filled by its owner (see `docs/TEAM.md`).
