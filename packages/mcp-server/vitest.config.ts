import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Resolve the workspace's core package to its TypeScript source so the suite
// runs from a clean checkout (post `npm install`) without a prior build step.
const coreSrc = fileURLToPath(new URL("../core/src/index.ts", import.meta.url));

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@acciaccatura/core": coreSrc,
    },
  },
});
