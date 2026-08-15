import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Build output, deps, and the downloaded VS Code are never linted.
    ignores: ["**/dist/**", "**/out/**", "**/.vscode-test/**", "**/node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node-targeted TypeScript across every package.
    files: ["**/*.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // Allow intentionally unused args prefixed with _ (e.g. handler shapes).
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // Node ESM tooling: build/test/docs scripts and config files.
    files: ["**/*.mjs"],
    languageOptions: {
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
  {
    // e2e specs are plain CommonJS driven by Mocha's tdd globals; require() is
    // the correct import form for the VS Code host to load them.
    files: ["packages/extension/test/e2e/**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { ...globals.node, ...globals.mocha },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
