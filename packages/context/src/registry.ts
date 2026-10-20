import {
  IndexRepoRequestSchema,
  RegisterRepoRequestSchema,
  RepoSchema,
  type IndexRepoRequest,
  type IndexStrategy,
  type RegisterRepoRequest,
  type Repo,
} from "@sdd/contracts";
import fs from "node:fs/promises";
import path from "node:path";
import { assertSafeCloneUrl, cloneRepo, originUrl, refreshClone, UnsafeRepoUrlError, type CloneOptions } from "./git";
import { indexRepo, type IndexOptions } from "./pipeline";
import { profileRepo } from "./profiler";
import { slugifyRepoId } from "./repoId";
import type { ContextStore, StoredRepo } from "./store/types";
import type { RepoTarget } from "./types";

export type RegistryErrorCode = "conflict" | "not_found" | "invalid";

export class RegistryError extends Error {
  constructor(
    readonly code: RegistryErrorCode,
    message: string,
    /** For `invalid`: which request field is wrong, as a path like ["source", "value"], so an API layer can build a validation error. */
    readonly path?: (string | number)[],
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

export interface RepoRegistryOptions {
  store: ContextStore;
  /** Where repos registered by URL are cloned. Default: CONTEXT_CACHE_DIR or ./.cache/repos. */
  cacheDir?: string;
  /**
   * May a repo be registered by local path? A path makes the server read that folder and send its code to the model and
   * embeddings providers, so turn this off for a shared server. Default: true unless CONTEXT_ALLOW_LOCAL_PATHS=false.
   */
  allowLocalPaths?: boolean;
  /** Clone options: allowed URL schemes and hosts (CONTEXT_ALLOWED_GIT_HOSTS, comma-separated, is the default host list). */
  clone?: CloneOptions;
  /** Passed to the indexing pipeline (output root, progress callback). */
  index?: Pick<IndexOptions, "outputRoot" | "onProgress" | "mode">;
  now?: () => Date;
}

export interface Started {
  /** The repo as it is right now (status `profiling` or `indexing`). */
  repo: Repo;
  /** Resolves with the final repo when the background work ends. It never rejects: failure is recorded on the repo. */
  completion: Promise<Repo>;
}

/**
 * True for a RegistryError. Checks the error's name instead of using `instanceof`: bundlers (Next.js gives each route its
 * own copy of a package) can load this module twice, and then `instanceof` is false for an error from the other copy.
 */
export function isRegistryError(error: unknown): error is RegistryError {
  return error instanceof Error && error.name === "RegistryError" && typeof (error as { code?: unknown }).code === "string";
}

const publicRepo = (stored: StoredRepo): Repo => RepoSchema.parse(stored); // strips localPath, and fails loudly if the shape ever drifts from the contract

/** Local-path validation that does not depend on the registry instance. */
async function requireDirectory(p: string): Promise<string> {
  const resolved = path.resolve(p);
  try {
    if (!(await fs.stat(resolved)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new RegistryError("invalid", `"${p}" is not a readable directory`, ["source", "value"]);
  }
  return resolved;
}

/**
 * Registering repos, profiling them, and starting indexing: the service the REST endpoints `POST /api/repos`,
 * `GET /api/repos`, `GET /api/repos/:id` and `POST /api/repos/:id/index` call. Long work (clone, profile, index) runs in
 * the background; the methods return at once with the repo in its `profiling` / `indexing` status.
 */
export class RepoRegistry {
  private readonly store: ContextStore;
  private readonly cacheDir: string;
  private readonly allowLocalPaths: boolean;
  private readonly clone: CloneOptions;
  private readonly indexOptions: RepoRegistryOptions["index"];
  private readonly now: () => Date;
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(options: RepoRegistryOptions) {
    this.store = options.store;
    this.cacheDir = path.resolve(options.cacheDir ?? process.env.CONTEXT_CACHE_DIR ?? path.join(process.cwd(), ".cache", "repos"));
    this.allowLocalPaths = options.allowLocalPaths ?? process.env.CONTEXT_ALLOW_LOCAL_PATHS !== "false";
    const envHosts = (process.env.CONTEXT_ALLOWED_GIT_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    this.clone = { allowedHosts: envHosts, ...options.clone };
    this.indexOptions = options.index;
    this.now = options.now ?? (() => new Date());
  }

  // ---- reads ----

  async list(): Promise<Repo[]> {
    return (await this.store.listRepos()).map(publicRepo);
  }

  async get(id: string): Promise<Repo> {
    return publicRepo(await this.require(id));
  }

  private async require(id: string): Promise<StoredRepo> {
    const repo = await this.store.getRepo(id);
    if (!repo) throw new RegistryError("not_found", `Repo "${id}" is not registered`);
    return repo;
  }

  /** Resolves when no background work is running. For tests and for a clean shutdown. */
  async idle(): Promise<void> {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight.values()]);
  }

  // ---- register + profile ----

  async register(input: RegisterRepoRequest): Promise<Started> {
    const request = RegisterRepoRequestSchema.parse(input);
    const id = slugifyRepoId(request.name);
    const end = this.begin(id); // claimed before any await, so two requests for the same name cannot both get through
    try {
      if (await this.store.getRepo(id)) throw new RegistryError("conflict", `A repo with id "${id}" is already registered`);

      let localPath: string | null = null;
      if (request.source.type === "path") {
        if (!this.allowLocalPaths)
          throw new RegistryError("invalid", "Registering a repo by local path is disabled on this server; use a URL", ["source", "type"]);
        localPath = await requireDirectory(request.source.value);
      } else {
        try {
          assertSafeCloneUrl(request.source.value, this.clone);
        } catch (error) {
          if (error instanceof UnsafeRepoUrlError) throw new RegistryError("invalid", error.message, ["source", "value"]);
          throw error;
        }
      }

      const stamp = this.now().toISOString();
      const stored: StoredRepo = {
        id,
        name: request.name,
        source: request.source,
        localPath,
        status: "profiling",
        profile: null,
        indexStrategy: null,
        indexedCommitSha: null,
        indexedAt: null,
        createdAt: stamp,
        updatedAt: stamp,
      };
      await this.store.saveRepo(stored);

      const completion = (async () => {
        try {
          return await this.acquireAndProfile(stored);
        } catch (error) {
          return await this.markFailed(stored.id, error);
        } finally {
          end();
        }
      })();
      return { repo: publicRepo(stored), completion };
    } catch (error) {
      end();
      throw error;
    }
  }

  /** Makes the working tree available (clone or check the path) and profiles it. Leaves the repo `profiled`. */
  private async acquireAndProfile(repo: StoredRepo): Promise<Repo> {
    const localPath = await this.acquire(repo, { refresh: false });
    const profile = await profileRepo(localPath);
    const done: StoredRepo = { ...repo, localPath, profile, status: "profiled", error: undefined, updatedAt: this.now().toISOString() };
    await this.store.saveRepo(done);
    return publicRepo(done);
  }

  /** Where the repo's working tree is. A URL repo is cloned on first use and brought up to date when `refresh` is set. */
  private async acquire(repo: StoredRepo, options: { refresh: boolean }): Promise<string> {
    if (repo.source.type === "path") return requireDirectory(repo.source.value);

    const dest = path.join(this.cacheDir, repo.id);
    const exists = await fs.stat(path.join(dest, ".git")).then(
      () => true,
      () => false,
    );
    if (!exists) {
      await fs.rm(dest, { recursive: true, force: true }); // an interrupted earlier clone leaves a half-made folder
      await cloneRepo(repo.source.value, dest, this.clone);
      return dest;
    }
    const origin = await originUrl(dest);
    if (!origin || new URL(origin).href !== new URL(repo.source.value).href) {
      throw new RegistryError("conflict", `The cache folder for "${repo.id}" belongs to a different remote (${origin ?? "none"})`);
    }
    if (options.refresh) await refreshClone(dest, this.clone);
    return dest;
  }

  // ---- index ----

  async startIndexing(id: string, input: IndexRepoRequest = {}): Promise<Started> {
    const request = IndexRepoRequestSchema.parse(input);
    const end = this.begin(id);
    try {
      const repo = await this.require(id);
      if (repo.status === "profiling" || repo.status === "indexing") {
        throw new RegistryError("conflict", `Repo "${id}" is still being ${repo.status === "profiling" ? "profiled" : "indexed"}`);
      }

      const starting: StoredRepo = { ...repo, status: "indexing", error: undefined, updatedAt: this.now().toISOString() };
      await this.store.saveRepo(starting);

      const completion = (async () => {
        try {
          return await this.runIndexing(starting, request);
        } catch (error) {
          return await this.markFailed(id, error);
        } finally {
          end();
        }
      })();
      return { repo: publicRepo(starting), completion };
    } catch (error) {
      end();
      throw error;
    }
  }

  private async runIndexing(starting: StoredRepo, request: IndexRepoRequest): Promise<Repo> {
    const id = starting.id;
    const localPath = await this.acquire(starting, { refresh: true });
    // a repo whose profiling failed is profiled now, so its strategy can be chosen
    const profile = starting.profile ?? (await profileRepo(localPath));
    await this.store.saveRepo({ ...starting, localPath, profile });

    const strategy: IndexStrategy = request.strategy ?? profile.recommendation;
    const result = await indexRepo(
      { id, name: starting.name, path: localPath },
      { store: this.store, strategy, allTargets: await this.targets(), ...this.indexOptions },
    );
    // The pipeline records its own outcome on the repo; make sure a failure that happened before it could is not lost.
    const final = await this.require(id);
    if (final.status === "indexing")
      return this.markFailed(id, new Error(result.failedRepos.length ? "Indexing failed" : "Indexing ended without a result"));
    return publicRepo(final);
  }

  /** Every registered repo with a working tree, for cross-repo links. */
  private async targets(): Promise<RepoTarget[]> {
    return (await this.store.listRepos()).filter((r) => r.localPath).map((r) => ({ id: r.id, name: r.name, path: r.localPath! }));
  }

  // ---- recovery ----

  /**
   * Call once at startup. Background work does not survive a restart, so a repo left in `profiling` or `indexing` (and a run
   * left `running`) is marked failed, which lets it be indexed again. Returns how many repos were fixed.
   */
  async recoverInterrupted(): Promise<number> {
    let fixed = 0;
    const runs = new Map((await this.store.listLatestRuns()).map((r) => [r.repoId, r]));
    for (const repo of await this.store.listRepos()) {
      if (this.inFlight.has(repo.id)) continue;
      const run = runs.get(repo.id);
      if (run?.status === "running")
        await this.store.updateRun(run.id, { status: "error", error: "Interrupted by a restart", finished: true });
      if (repo.status === "profiling" || repo.status === "indexing") {
        await this.store.saveRepo({ ...repo, status: "failed", error: "Interrupted by a restart", updatedAt: this.now().toISOString() });
        fixed++;
      }
    }
    return fixed;
  }

  // ---- helpers ----

  private async markFailed(id: string, error: unknown): Promise<Repo> {
    const repo = await this.require(id);
    const failed: StoredRepo = {
      ...repo,
      status: "failed",
      error: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
      updatedAt: this.now().toISOString(),
    };
    await this.store.saveRepo(failed);
    return publicRepo(failed);
  }

  /**
   * Claims the one piece of background work a repo may have. Throws `conflict` if it already has some, and does so
   * synchronously, so two concurrent requests cannot both pass. Call the returned function (safe to call twice) when done.
   */
  private begin(id: string): () => void {
    if (this.inFlight.has(id)) throw new RegistryError("conflict", `Repo "${id}" already has work in progress`);
    let finish!: () => void;
    this.inFlight.set(id, new Promise<void>((resolve) => (finish = resolve)));
    return () => {
      this.inFlight.delete(id);
      finish();
    };
  }
}
