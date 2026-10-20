import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/.next/**", "**/dist/**", "**/output/**", "**/next-env.d.ts", "packages/context/test/fixtures/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  { files: ["**/*.config.js"], languageOptions: { sourceType: "commonjs", globals: { module: "writable" } } },
  { files: ["**/*.mjs"], languageOptions: { globals: { process: "readonly" } } },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
);
