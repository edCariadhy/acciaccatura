import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { driftStatus, readRegion } from "./anchor.js";
import type { AnnotationStore } from "./store.js";
import type { Annotation } from "./types.js";

/**
 * Build the Acciaccatura MCP server over a loaded store.
 *
 * The tool set is deliberately small and the descriptions state WHEN to call
 * each tool, not merely what it does: the MCP surface is the product API that
 * agents navigate by, so a description that drifts from behavior is a defect no
 * prompt can repair. `workspaceRoot` lets the server read current code to
 * report anchor drift.
 */
export function createServer(store: AnnotationStore, workspaceRoot: string): McpServer {
  const server = new McpServer({ name: "acciaccatura", version: "0.0.0" });

  server.registerTool(
    "get_annotations",
    {
      title: "Get code annotations",
      description:
        "Call this BEFORE editing or reasoning about a region of code, to retrieve the notes anchored there (intent, constraints, gotchas, past decisions). Results are ranked and capped — treat them as advisory context, not authority. Each result reports a drift status; if it is 'drifted' or the note contradicts the code, trust the code. Pass `line` to focus on one location.",
      inputSchema: {
        file: z.string().describe("Workspace-relative POSIX path, e.g. src/store.ts"),
        line: z.number().int().positive().optional().describe("1-based line to focus on"),
        limit: z
          .number()
          .int()
          .positive()
          .max(20)
          .optional()
          .describe("Max annotations to return (default 3)"),
      },
    },
    async ({ file, line, limit }) => {
      const results = store.query({ file, line, limit });
      return { content: [{ type: "text", text: await render(results, workspaceRoot) }] };
    },
  );

  server.registerTool(
    "annotate_code",
    {
      title: "Annotate code",
      description:
        "Call this to persist a durable note about a specific code region that a future agent or developer would need but could NOT re-derive from the code alone: a non-obvious constraint, a decision and the alternative it rejected, a subtle gotcha. Do not annotate the obvious. Pass the exact current text of the lines as `snapshot` so later drift can be detected.",
      inputSchema: {
        file: z.string().describe("Workspace-relative POSIX path"),
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive(),
        snapshot: z.string().describe("Exact current text of the anchored line range"),
        body: z.string().describe("The note: state what is non-obvious, and why"),
        trust: z.enum(["authoritative", "suggested", "unverified"]).optional(),
      },
    },
    async ({ file, startLine, endLine, snapshot, body, trust }) => {
      const saved = await store.add({
        body,
        anchor: { file, startLine, endLine, snapshot },
        provenance: "agent",
        trust,
      });
      return {
        content: [
          { type: "text", text: `Saved annotation ${saved.id} on ${file}:${startLine}-${endLine}` },
        ],
      };
    },
  );

  server.registerTool(
    "remove_annotation",
    {
      title: "Remove annotation",
      description:
        "Call this only when an annotation is confirmed obsolete — the code it described is gone, or its guidance is now wrong. Removing a stale note is better than leaving one that could mislead a future agent. Get the id from get_annotations.",
      inputSchema: {
        id: z.string().describe("Annotation id from get_annotations"),
      },
    },
    async ({ id }) => {
      const removed = await store.remove(id);
      return {
        content: [{ type: "text", text: removed ? `Removed ${id}` : `No annotation with id ${id}` }],
      };
    },
  );

  return server;
}

async function render(annotations: Annotation[], workspaceRoot: string): Promise<string> {
  if (annotations.length === 0) return "No annotations for this location.";
  const blocks = await Promise.all(
    annotations.map(async (a) => {
      const current = await readRegion(workspaceRoot, a.anchor);
      const drift = driftStatus(a.anchor, current);
      const head = `#${a.id} [${a.provenance}/${a.trust}] ${a.anchor.file}:${a.anchor.startLine}-${a.anchor.endLine} (drift: ${drift})`;
      return `${head}\n${a.body}`;
    }),
  );
  return blocks.join("\n\n");
}
