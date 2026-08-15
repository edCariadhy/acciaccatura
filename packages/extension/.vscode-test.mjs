import { defineConfig } from "@vscode/test-cli";

// End-to-end smoke tests that launch a real VS Code and load this extension.
// Run with `npm run test:e2e` (downloads VS Code on first run); intentionally
// separate from the fast `npm test` unit suite.
export default defineConfig({
  files: "test/e2e/**/*.test.js",
  version: "stable",
  // Keep the user-data-dir short: VS Code's IPC socket lives under it, and a
  // deep path blows past macOS's ~103-char Unix-socket limit (EINVAL).
  launchArgs: ["--user-data-dir", "/tmp/acc-e2e"],
  mocha: {
    ui: "tdd",
    timeout: 60000,
  },
});
