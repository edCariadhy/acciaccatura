import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { driftStatus, findNoteLines, readRegion } from "@acciaccatura/core";
import type { Annotation, AnnotationStore } from "@acciaccatura/core";

/**
 * Build the Acciaccatura MCP server over a loaded store.
 *
 * We keep the set of tools small on purpose, and each description says WHEN to
 * call the tool, not only what it does. These tools are how agents use the
 * product, so a description that no longer matches the code is a bug that no
 * prompt can fix. `workspaceRoot` lets the server read the code as it is now,
 * to report whether it still matches each note.
 */
export function createServer(store: AnnotationStore, workspaceRoot: string): McpServer {
  const server = new McpServer({ name: "acciaccatura", version: "0.0.0" });

  server.registerTool(
    "get_annotations",
    {
      title: "Get code annotations",
      description:
        "Call this BEFORE you edit or reason about a piece of code, to read the notes left on it (what it is for, what it must not do, traps, past decisions). Results are ranked and limited. Treat them as hints, not rules. Each result says whether the code still matches the note; if it says 'drifted', or the note disagrees with the code, believe the code. Pass `line` to ask about one place.",
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
      // The human keeps annotating in the editor while this server is
      // connected, so the copy loaded at startup goes stale immediately.
      await store.reload();
      const results = store.query({ file, line, limit });
      return { content: [{ type: "text", text: await render(results, workspaceRoot) }] };
    },
  );

  server.registerTool(
    "annotate_code",
    {
      title: "Annotate code",
      description:
        "Call this to save a note about a piece of code that the next agent or developer would need but could NOT work out from the code alone: a rule that is not visible, a decision and what it ruled out, a trap that is easy to fall into. Do not write notes about what the code already shows. Pass the exact text of those lines as `snapshot`, so we can later tell whether the code changed.",
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
        "Call this only when you are sure a note is out of date — the code it described is gone, or its advice is now wrong. Deleting an old note is better than leaving one that sends the next agent the wrong way. Get the id from get_annotations.",
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
      // Saved lines say where the note was written. Say where the code is now,
      // so an agent reads the right lines when the file has changed.
      const fileText = await readFile(join(workspaceRoot, a.anchor.file), "utf8").catch(
        () => undefined,
      );
      const found = findNoteLines(a.anchor, fileText);
      const where =
        found.state === "gone"
          ? `${a.anchor.file}:${a.anchor.startLine}-${a.anchor.endLine} (code not found)`
          : found.state === "moved"
            ? `${a.anchor.file}:${found.startLine}-${found.endLine} (moved from ${a.anchor.startLine}-${a.anchor.endLine})`
            : `${a.anchor.file}:${found.startLine}-${found.endLine}`;
      const head = `#${a.id} [${a.provenance}/${a.trust}] ${where} (drift: ${drift})`;
      return `${head}\n${a.body}`;
    }),
  );
  return blocks.join("\n\n");
}
