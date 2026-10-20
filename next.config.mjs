/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // keep wasm-loading / native-ish packages out of the webpack bundle
    serverComponentsExternalPackages: ["web-tree-sitter", "tree-sitter-typescript", "tree-sitter-python", "tree-sitter-java", "pg", "simple-git"],
  },
  async rewrites() {
    // A literal app/index/ segment collides with the root route in Next 14, so the page lives in app/indexing/.
    return [{ source: "/index", destination: "/indexing" }];
  },
};
export default nextConfig;
