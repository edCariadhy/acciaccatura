#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { join, resolve } from "node:path";

import { AnnotationStore } from "@acciaccatura/core";

import { createServer } from "./server.js";

/**
 * Entry point for the local MCP server. Speaks MCP over stdio so an
 * agent host can spawn it directly. The workspace root and store path are taken
 * from the environment so the extension can point the server at the same file
 * the human writes to.
 */
async function main(): Promise<void> {
  const workspaceRoot = resolve(process.env.ACCIACCATURA_WORKSPACE ?? process.cwd());
  const storePath = process.env.ACCIACCATURA_STORE
    ? resolve(process.env.ACCIACCATURA_STORE)
    : join(workspaceRoot, ".acciaccatura", "annotations.json");

  const store = new AnnotationStore(storePath);
  await store.load();

  const server = createServer(store, workspaceRoot);
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  // stdout is the MCP channel; diagnostics must go to stderr.
  console.error("acciaccatura-mcp failed to start:", err);
  process.exit(1);
});
