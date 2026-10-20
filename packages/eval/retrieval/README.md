# Retrieval-quality harness

Evidence for the project's research question: **does grounding in generated CLAUDE.md files (`claude-md`), embeddings, or both (`hybrid`) find the files a developer needs?** For each task in a dataset it asks every retrieval mode for the context bundle and scores the files returned against hand-labelled expected files.

```bash
pnpm --filter @sdd/eval retrieval                       # offline, mock mode: checks the harness
pnpm --filter @sdd/eval retrieval --live --out report.md  # real Voyage + Claude (needs keys in .env; costs money)
pnpm --filter @sdd/eval retrieval --dataset shop-api --mode hybrid --k 1,3,5 --budget 8000
```

**A mock run is not evidence.** Mock embeddings are hashed words (so `embeddings` behaves like keyword search) and the generated CLAUDE.md files are placeholders. The report says so. The comparison to quote is a `--live` run. That path has not been run yet (no API keys were available when it was built).

## What is measured

All metrics are over the files of the bundle in reading order (primary hits first, then dependency neighbours), each file once.

| Metric        | Meaning                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| recall@k      | share of the expected files that are in the first k files                                                              |
| precision@k   | share of the first k files that are expected; when fewer than k files come back the denominator is the number returned |
| hit@k         | share of tasks with at least one expected file in the first k                                                          |
| MRR           | mean of 1 / (position of the first expected file)                                                                      |
| files, tokens | mean size of the bundle, with the token budget applied (default 12,000)                                                |

Every repo is indexed with the **full** strategy, because without embeddings the modes cannot be told apart. If a mode ever answers as a different mode the run aborts instead of reporting a misleading row.

## Datasets (`cases/*.json`)

| File                 | Repo                                              | Tasks | Notes                                                                             |
| -------------------- | ------------------------------------------------- | ----- | --------------------------------------------------------------------------------- |
| `shop-api.json`      | `repos/shop-api` (28 files, 5 modules)            | 14    | Tasks 11 and 12 use different words than the code on purpose (reimburse, expire). |
| `billing-auth.json`  | the TypeScript fixture of the Context Agent tests | 5     | Tiny; keeps the harness honest.                                                   |
| `java-invoices.json` | the Java fixture of the Context Agent tests       | 2     | Second language.                                                                  |

## Adding a repo (for the real open-source repo)

1. Put the repo in a folder (a clone is fine; it is only read) and note its path relative to `cases/`.
2. Create `cases/<name>.json`:

   ```json
   {
     "name": "my-repo",
     "description": "What it is and why it was chosen.",
     "repo": "../repos/my-repo",
     "cases": [{ "task": "A feature request in a product owner's words", "expectedFiles": ["src/a.ts", "src/b.ts"] }]
   }
   ```

3. Label `expectedFiles` as the files a developer would **need to touch or read** to build the feature, with forward slashes. Label before looking at any retrieval output, so the labels are not tuned to the system. Aim for 15 or more tasks that span the repo's modules, and include some that do not share words with the code.
4. `pnpm --filter @sdd/eval test` checks that every expected file exists. Then run the harness.

Repos with 1,000 or more files are slow to index live (every chunk is embedded and every module documented by Claude): start with `--dataset <name>` and watch the cost line in the report.
