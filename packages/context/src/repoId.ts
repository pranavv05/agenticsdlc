import { RepoIdSchema } from "@sdd/contracts";

/** Turns a display name into a registry slug: lowercase, `[a-z0-9._-]`, starts with a letter or digit, at most 63 characters. */
export function slugifyRepoId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 63)
    .replace(/[-._]+$/, "");
  const id = slug || "repo";
  return RepoIdSchema.parse(id);
}
