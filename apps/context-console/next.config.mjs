import fs from "node:fs";
import path from "node:path";

// Load the monorepo-root .env (Next only reads .env from the app directory). Values already in the environment win.
const rootEnv = path.resolve(import.meta.dirname, "../../.env");
if (fs.existsSync(rootEnv)) {
  const keep = { ...process.env };
  process.loadEnvFile(rootEnv);
  Object.assign(process.env, keep);
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // workspace packages ship TypeScript source, so Next must compile them
  transpilePackages: ["@sdd/context", "@sdd/llm", "@sdd/contracts"],
  experimental: {
    // keep wasm-loading / native-ish packages out of the webpack bundle
    serverComponentsExternalPackages: [
      "web-tree-sitter",
      "tree-sitter-typescript",
      "tree-sitter-python",
      "tree-sitter-java",
      "pg",
      "simple-git",
    ],
  },
  async rewrites() {
    // A literal app/index/ segment collides with the root route in Next 14, so the page lives in app/indexing/.
    return [{ source: "/index", destination: "/indexing" }];
  },
};
export default nextConfig;
