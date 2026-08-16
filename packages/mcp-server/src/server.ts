import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ageInDays, driftStatus, findNoteLines, readRegion, reportScope } from "@acciaccatura/core";
import type { Annotation, AnnotationStore, ScopeIndexEntry } from "@acciaccatura/core";

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
        "Call this BEFORE you edit or reason about a piece of code, to read the notes left on it (what it is for, what it must not do, traps, past decisions). Results are ranked and limited. Treat them as hints, not rules. Each result says whether the code still matches the note; if it says 'drifted', or the note disagrees with the code, believe the code. A result also says how many days it has been open once it is older than a day: these are working notes, so an old one is likelier to describe work that has already moved on. Pass `line` to ask about one place. Pass `scope` instead to read a named set in the order its author meant it to be read — use that when you are reviewing a change or being walked through an area, because the sequence is the point. You must pass `file`, `scope`, or both.",
      inputSchema: {
        file: z.string().optional().describe("Workspace-relative POSIX path, e.g. src/store.ts"),
        scope: z
          .string()
          .optional()
          .describe("Named set to read in order, e.g. pr/142 or onboarding/billing"),
        line: z.number().int().positive().optional().describe("1-based line to focus on"),
        limit: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .describe("Max annotations to return (default 3 for a file, 20 for a scope)"),
      },
    },
    async ({ file, scope, line, limit }) => {
      // The human keeps annotating in the editor while this server is
      // connected, so the copy loaded at startup goes stale immediately.
      await store.reload();
      // Asking for neither is refused rather than answered with everything: an
      // unbounded read is what the result cap exists to prevent.
      if (file === undefined && scope === undefined) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "Pass a file, a scope, or both. There is no request for every annotation.",
            },
          ],
        };
      }
      const results = store.query({ file, scope, line, limit });
      return { content: [{ type: "text", text: await render(results, workspaceRoot) }] };
    },
  );

  server.registerTool(
    "annotate_code",
    {
      title: "Annotate code",
      description:
        "Call this to save a note about a piece of code that the next agent or developer would need but could NOT work out from the code alone: a rule that is not visible, a decision and what it ruled out, a trap that is easy to fall into. Do not write notes about what the code already shows. Pass the exact text of those lines as `snapshot`, so we can later tell whether the code changed. Pass `scope` and `order` when the note is one step of something meant to be read in sequence — a review of one change, or a walk through an area — so the reader gets it in the right place rather than on its own.",
      inputSchema: {
        file: z.string().describe("Workspace-relative POSIX path"),
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive(),
        snapshot: z.string().describe("Exact current text of the anchored line range"),
        body: z.string().describe("The note: state what is non-obvious, and why"),
        trust: z.enum(["authoritative", "suggested", "unverified"]).optional(),
        scope: z
          .string()
          .optional()
          .describe("Named set this note belongs to, e.g. pr/142 or onboarding/billing"),
        order: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Place in that set's sequence, 1 first. Notes with no order are read last"),
      },
    },
    async ({ file, startLine, endLine, snapshot, body, trust, scope, order }) => {
      const saved = await store.add({
        body,
        anchor: { file, startLine, endLine, snapshot },
        provenance: "agent",
        trust,
        scope,
        order,
      });
      const where = scope ? ` in ${scope}` : "";
      return {
        content: [
          {
            type: "text",
            text: `Saved annotation ${saved.id} on ${file}:${startLine}-${endLine}${where}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "resolve_annotation",
    {
      title: "Mark an annotation done",
      description:
        "Call this when you have finished the work a note asked for, or the thing it warned about no longer applies. The note was still right — it is just done, so it stops being handed to the next agent. Use remove_annotation instead when the note itself was wrong. Get the id from get_annotations. Pass `scope` instead of `id` to close a whole set at once — do that when the change a set was written for has merged, rather than finishing twenty notes one at a time. Closing keeps every note, so it is safe to undo. Pass one or the other, never both.",
      inputSchema: {
        id: z.string().optional().describe("Annotation id from get_annotations"),
        scope: z
          .string()
          .optional()
          .describe("Named set to close entirely, e.g. pr/142. Finishes every open note in it"),
      },
    },
    async ({ id, scope }) => {
      // One or the other: closing a set and finishing a note are different
      // acts, and guessing which was meant would sometimes end nineteen notes
      // nobody asked about.
      if ((id === undefined) === (scope === undefined)) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                id === undefined
                  ? "Pass an id to finish one note, or a scope to close a set."
                  : "Pass an id or a scope, not both: they are different acts.",
            },
          ],
        };
      }

      if (scope !== undefined) {
        const finished = await store.resolveScope(scope, "agent");
        return {
          content: [
            {
              type: "text" as const,
              text:
                finished === 0
                  ? `No open notes in ${scope}; nothing to close.`
                  : `Closed ${scope}: finished ${finished} note${finished === 1 ? "" : "s"}.`,
            },
          ],
        };
      }

      const done = await store.resolve(id!, "agent");
      return {
        content: [
          {
            type: "text",
            text: done ? `Marked ${id} done at ${done.resolvedAt}` : `No annotation with id ${id}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "remove_annotation",
    {
      title: "Remove annotation",
      description:
        "Call this only when you are sure a note is wrong — the code it described is gone, or its advice would now send the next agent the wrong way. If the note was right and the work it asked for is simply finished, call resolve_annotation instead, which keeps the record. Get the id from get_annotations.",
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

  server.registerTool(
    "update_annotation",
    {
      title: "Repair an annotation",
      description:
        "Call this to fix a note that is still worth keeping: its wording is wrong or out of date, or scope_status says it has 'drifted' and you have found where its code went. Use this rather than remove_annotation + annotate_code — this keeps the same note, so its id and its place in its set survive, and anything holding that id still works. To re-point it, read the code as it is NOW and pass `file`, `startLine`, `endLine` and `snapshot` together: the snapshot must be the current text of those lines, because drift is measured against it. Pass `scope` and `order` to move a note within a set or to another one; pass null for either to take it out. Do not use this to mark work finished — that is resolve_annotation.",
      inputSchema: {
        id: z.string().describe("Annotation id from get_annotations"),
        body: z.string().optional().describe("Replacement note text"),
        file: z.string().optional().describe("Workspace-relative POSIX path; part of a re-anchor"),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
        snapshot: z
          .string()
          .optional()
          .describe("Exact CURRENT text of the new line range; required to re-anchor"),
        trust: z.enum(["authoritative", "suggested", "unverified"]).optional(),
        scope: z
          .string()
          .nullable()
          .optional()
          .describe("Move to this set, or null to take the note out of every set"),
        order: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional()
          .describe("New place in the set's sequence, or null for none"),
      },
    },
    async ({ id, body, file, startLine, endLine, snapshot, trust, scope, order }) => {
      const anchorParts = [file, startLine, endLine, snapshot];
      const givenParts = anchorParts.filter((p) => p !== undefined).length;
      // All four or none. Line numbers without their text cannot be hashed, and
      // a note re-anchored on a guess is exactly the silent wrong answer this
      // product exists to avoid.
      if (givenParts > 0 && givenParts < 4) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "To re-anchor, pass file, startLine, endLine and snapshot together. The snapshot must be the current text of those lines.",
            },
          ],
        };
      }

      const changes = {
        ...(body === undefined ? {} : { body }),
        ...(trust === undefined ? {} : { trust }),
        ...(scope === undefined ? {} : { scope }),
        ...(order === undefined ? {} : { order }),
        ...(givenParts === 4
          ? { anchor: { file: file!, startLine: startLine!, endLine: endLine!, snapshot: snapshot! } }
          : {}),
      };

      // A call that changes nothing would still bump updatedAt and report
      // success, which reads as a repair that happened.
      if (Object.keys(changes).length === 0) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "Nothing to change. Pass a body, a trust level, a scope, an order, or a full anchor.",
            },
          ],
        };
      }

      const updated = await store.update(id, changes);
      if (!updated) {
        return { content: [{ type: "text" as const, text: `No annotation with id ${id}` }] };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Updated ${updated.id} on ${updated.anchor.file}:${updated.anchor.startLine}-${updated.anchor.endLine}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "scope_status",
    {
      title: "Check a set of notes",
      description:
        "Call this BEFORE you rely on a named set, and before you close one. With no arguments it lists every set with how many notes it holds, how many are finished, and when it was opened — cheap, and it reads no code. Pass `scope` to check one set against the code as it is now. You get counts, never a verdict: 'aligned' notes still sit on their lines, 'drifted' notes point at code that moved, 'gone' notes point at code that is no longer there. Decide from the counts yourself — many gone notes in a standing set means it needs repair, and a set whose notes are all finished is one you can close.",
      inputSchema: {
        scope: z
          .string()
          .optional()
          .describe("Set to check, e.g. pr/142. Omit to list every set instead"),
      },
    },
    async ({ scope }) => {
      await store.reload();

      if (scope === undefined) {
        const index = store.scopes();
        if (index.length === 0) {
          return { content: [{ type: "text", text: "No named sets in this workspace." }] };
        }
        const lines = index.map(
          (s) =>
            `${s.scope} — ${s.notes} note${s.notes === 1 ? "" : "s"} — ${s.open} open, ${s.finished} finished — opened ${s.openedAt}${age(s.openedAt)}`,
        );
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      const report = await reportScope(scope, store.all(), workspaceRoot);
      // Absent is not the same answer as a set with nothing wrong, so say so
      // rather than reporting a row of zeroes.
      if (!report) {
        return { content: [{ type: "text", text: `No set named ${scope}.` }] };
      }
      const text = [
        `${report.scope} — ${report.notes} note${report.notes === 1 ? "" : "s"} — ${report.open} open, ${report.finished} finished`,
        `${report.aligned} aligned, ${report.drifted} drifted, ${report.gone} gone (open notes only)`,
        `opened ${report.openedAt}${age(report.openedAt)}, last touched ${report.lastTouchedAt}`,
      ].join("\n");
      return { content: [{ type: "text", text }] };
    },
  );

  // ---------------------------------------------------------------------------
  // Resources: the sets, as documents.
  //
  // Discovery used to cost a tool call, and a tool costs a line in the agent's
  // tool list on every turn whether or not it is ever used. `resources/list` is
  // the protocol's own answer to "what is here", so listing the sets belongs
  // there instead. Nothing here computes: a resource says what was written, and
  // says so out loud. Where the code sits now, and whether it drifted, stay on
  // the tools that read the code.
  // ---------------------------------------------------------------------------

  server.registerResource(
    "scopes",
    SCOPES_URI,
    {
      title: "Named sets in this workspace",
      description:
        "The list of named sets — a PR under review, a walkthrough of an area — with how many notes each holds and how old it is. Read this to find out what sets exist before asking for one by name.",
      mimeType: "text/plain",
    },
    async (uri) => {
      await store.reload();
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text: renderIndex(store.scopes()) }] };
    },
  );

  server.registerResource(
    "scope",
    new ResourceTemplate(`${SCOPES_URI}/{+scope}`, {
      // Listing every set here is what makes discovery free: a client asking
      // `resources/list` gets the sets by name, with no tool call spent.
      list: async () => {
        await store.reload();
        return {
          resources: store.scopes().map((s) => ({
            uri: `${SCOPES_URI}/${s.scope}`,
            name: s.scope,
            description: `${s.notes} note${s.notes === 1 ? "" : "s"} — ${s.open} open, ${s.finished} finished — opened ${s.openedAt}${age(s.openedAt)}`,
            mimeType: "text/plain",
          })),
        };
      },
      complete: {
        scope: async (value) => {
          await store.reload();
          return store
            .scopes()
            .map((s) => s.scope)
            .filter((name) => name.startsWith(value));
        },
      },
    }),
    {
      title: "One named set, in its author's order",
      description:
        "A set read as a document: its notes in the sequence they were meant to be read. Says where each note was written, not where the code is now — call get_annotations with the same scope for current positions and drift.",
      mimeType: "text/plain",
    },
    async (uri, { scope }) => {
      await store.reload();
      const wanted = resolveScopeName(scope, store.scopes());
      // A set that does not exist is an error, not an empty document. An agent
      // has to be able to tell "no such set" from "a set with nothing in it",
      // the same distinction scope_status draws.
      if (wanted === undefined) {
        throw new Error(`No set named ${asName(scope)} in this workspace.`);
      }
      const entry = store.scopes().find((s) => s.scope === wanted)!;
      const notes = store.query({ scope: wanted });
      return {
        contents: [
          { uri: uri.href, mimeType: "text/plain", text: renderScopeDocument(entry, notes) },
        ],
      };
    },
  );

  return server;
}

/** Root of every resource this server serves. */
const SCOPES_URI = "acciaccatura://scopes";

/**
 * The scope name a URI asked for, or `undefined` when no set matches.
 *
 * A set name may hold a `/` (`pr/142`), which the URI template carries through
 * as-is — but a client is equally entitled to percent-encode it. Both spellings
 * name the same set, so both are tried, and a name that genuinely contains a
 * percent escape still wins on the first pass.
 */
function resolveScopeName(
  raw: string | string[] | undefined,
  scopes: ReadonlyArray<{ scope: string }>,
): string | undefined {
  const name = asName(raw);
  if (scopes.some((s) => s.scope === name)) return name;

  let decoded: string;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    return undefined; // a broken escape names nothing
  }
  return scopes.some((s) => s.scope === decoded) ? decoded : undefined;
}

/** A template variable as a plain string; the SDK hands back an array for some. */
function asName(raw: string | string[] | undefined): string {
  return Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
}

/** Every named set, with what it holds and how old it is. */
function renderIndex(scopes: ReadonlyArray<ScopeIndexEntry>): string {
  if (scopes.length === 0) {
    return "No named sets in this workspace. A set is created by writing a note with a scope.";
  }
  const lines = scopes.map(
    (s) =>
      `${s.scope} — ${s.notes} note${s.notes === 1 ? "" : "s"} — ${s.open} open, ${s.finished} finished — opened ${s.openedAt}${age(s.openedAt)}`,
  );
  return [
    "Named sets in this workspace:",
    "",
    ...lines,
    "",
    `Read one at ${SCOPES_URI}/<name>. For where the code sits now and whether it drifted, call get_annotations or scope_status with the set's name.`,
  ].join("\n");
}

/**
 * One set as a document: its open notes, in the order its author chose.
 *
 * Line numbers are labelled as where each note was **written**, never presented
 * as where the code is. A resource reads no code, so it cannot know whether
 * those lines still hold — and a position stated without that caveat is the
 * quiet wrong answer this product exists to avoid.
 */
function renderScopeDocument(entry: ScopeIndexEntry, notes: readonly Annotation[]): string {
  const head = [
    `${entry.scope} — ${entry.notes} note${entry.notes === 1 ? "" : "s"} — ${entry.open} open, ${entry.finished} finished`,
    `Opened ${entry.openedAt}${age(entry.openedAt)}, last touched ${entry.lastTouchedAt}`,
    "",
    `This is the set as it was written. Positions below are where each note was saved, not where the code is now — call get_annotations with scope "${entry.scope}" for current positions and drift.`,
    "",
  ];

  if (notes.length === 0) {
    // Every note finished is a real state with a real meaning: the work this
    // set was written for is over. Saying "no notes" would read as an empty set.
    head.push(
      entry.finished > 0
        ? "Every note in this set is finished. Nothing is left to read."
        : "No open notes in this set.",
    );
    return head.join("\n");
  }

  const steps = notes.map((a, i) => {
    const place = a.order === undefined ? `${i + 1}.` : `${a.order}.`;
    return [
      `${place} ${a.anchor.file} (written at ${a.anchor.startLine}-${a.anchor.endLine}) [${a.provenance}/${a.trust}]`,
      a.body,
    ].join("\n");
  });

  if (entry.finished > 0) {
    const one = entry.finished === 1;
    head.push(`${entry.finished} finished note${one ? " is" : "s are"} not listed.`, "");
  }
  return [...head, steps.join("\n\n")].join("\n");
}

/** " (N days ago)", or "" for something opened today. Age is a hint, not a rule. */
function age(iso: string): string {
  const days = ageInDays(iso);
  if (days === undefined || days < 1) return "";
  return ` (${days} day${days === 1 ? "" : "s"} ago)`;
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
      // Say which set a note belongs to and where it sits, so a reader can tell
      // one step of a sequence from a note that stands on its own.
      const set = a.scope
        ? ` [${a.scope}${a.order === undefined ? "" : ` #${a.order}`}]`
        : "";
      // How long the note has waited. A note is a working note, so one that has
      // been open for weeks is likelier to describe work that already moved on
      // — worth saying, and only worth the tokens once it is a day old. Every
      // note rendered here is open: finished ones leave the query.
      const days = ageInDays(a.createdAt);
      const waiting =
        days === undefined || days < 1 ? "" : `, open ${days} day${days === 1 ? "" : "s"}`;
      const head = `#${a.id} [${a.provenance}/${a.trust}]${set} ${where} (drift: ${drift}${waiting})`;
      return `${head}\n${a.body}`;
    }),
  );
  return blocks.join("\n\n");
}
