import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Unit tests exercise the vscode-free capture logic; resolve the core package
// to its source so the suite runs without a build step.
const coreSrc = fileURLToPath(new URL("../core/src/index.ts", import.meta.url));

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@acciaccatura/core": coreSrc,
    },
  },
});
