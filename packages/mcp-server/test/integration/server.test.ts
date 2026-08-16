import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AnnotationStore } from "@acciaccatura/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../../src/server.js";

/**
 * Integration test: drives the server through a real MCP {@link Client} over an
 * in-memory transport pair — the same request/response path an agent host uses,
 * without spawning a process or needing a prior build. Exercises the tools and
 * the product invariants they must uphold.
 */
let root: string;
let client: Client;

async function connect(): Promise<Client> {
  const store = new AnnotationStore(join(root, ".acciaccatura", "annotations.json"));
  await store.load();
  const server = createServer(store, root);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const c = new Client({ name: "test", version: "0" });
  await c.connect(clientT);
  return c;
}

const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((p) => p.text ?? "").join("\n");

/** A second writer on the same store file — stands in for the editor. */
async function editorStore(): Promise<AnnotationStore> {
  const s = new AnnotationStore(join(root, ".acciaccatura", "annotations.json"));
  await s.load();
  return s;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "acc-int-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "math.ts"), "export function add(a, b) {\n  return a + b;\n}\n", "utf8");
  client = await connect();
});

afterEach(async () => {
  await client.close();
  await rm(root, { recursive: true, force: true });
});

describe("MCP server integration", () => {
  it("advertises a small tool set, each with a when-to-call description", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "annotate_code",
      "get_annotations",
      "remove_annotation",
      "resolve_annotation",
    ]);
    // The description must say WHEN to call the tool, not only what it does.
    const get = tools.find((t) => t.name === "get_annotations");
    expect(get?.description ?? "").toMatch(/before you edit/i);
    // Finishing and deleting are different acts, and the descriptions have to
    // send an agent to the right one.
    const resolve = tools.find((t) => t.name === "resolve_annotation");
    expect(resolve?.description ?? "").toMatch(/done|finish/i);
    const remove = tools.find((t) => t.name === "remove_annotation");
    expect(remove?.description ?? "").toMatch(/resolve_annotation/);
  });

  it("round-trips annotate → get, reporting drift 'aligned' while code is unchanged", async () => {
    const snap = "export function add(a, b) {\n  return a + b;";
    const saved = await client.callTool({
      name: "annotate_code",
      arguments: { file: "src/math.ts", startLine: 1, endLine: 2, snapshot: snap, body: "add() is pure — keep it side-effect free." },
    });
    expect(textOf(saved as never)).toMatch(/^Saved annotation /);

    const got = await client.callTool({ name: "get_annotations", arguments: { file: "src/math.ts", line: 1 } });
    const text = textOf(got as never);
    expect(text).toContain("drift: aligned");
    expect(text).toContain("keep it side-effect free");
    expect(text).toContain("[agent/suggested]");
  });

  it("degrades loudly: drift flips to 'drifted' when code changes under the anchor", async () => {
    const snap = "export function add(a, b) {\n  return a + b;";
    await client.callTool({ name: "annotate_code", arguments: { file: "src/math.ts", startLine: 1, endLine: 2, snapshot: snap, body: "note" } });
    await writeFile(join(root, "src", "math.ts"), "export function add(a, b) {\n  return a - b;\n}\n", "utf8");

    const got = await client.callTool({ name: "get_annotations", arguments: { file: "src/math.ts", line: 1 } });
    expect(textOf(got as never)).toContain("drift: drifted");
  });

  it("bounds results to 3 by default and honors an explicit limit", async () => {
    for (let i = 1; i <= 5; i++) {
      await client.callTool({ name: "annotate_code", arguments: { file: "src/math.ts", startLine: i, endLine: i, snapshot: `l${i}`, body: `n${i}` } });
    }
    const def = await client.callTool({ name: "get_annotations", arguments: { file: "src/math.ts" } });
    expect((textOf(def as never).match(/drift:/g) ?? []).length).toBe(3);

    const all = await client.callTool({ name: "get_annotations", arguments: { file: "src/math.ts", limit: 10 } });
    expect((textOf(all as never).match(/drift:/g) ?? []).length).toBe(5);
  });

  it("sees an annotation the editor wrote after the server connected", async () => {
    // Two writers, one store: the server holds a copy from startup, but the
    // human keeps annotating. An agent asking for context must not be told
    // "none" because its process happened to start first.
    const editor = await editorStore();
    await editor.add({
      body: "written in the editor, after this server was already running",
      anchor: { file: "src/math.ts", startLine: 1, endLine: 2, snapshot: "export function add(a, b) {\n  return a + b;" },
      provenance: "human",
    });

    const got = await client.callTool({ name: "get_annotations", arguments: { file: "src/math.ts", line: 1 } });
    expect(textOf(got as never)).toContain("written in the editor");
  });

  it("does not destroy an editor annotation when the agent writes", async () => {
    const editor = await editorStore();
    await editor.add({
      body: "human note",
      anchor: { file: "src/math.ts", startLine: 1, endLine: 1, snapshot: "export function add(a, b) {" },
      provenance: "human",
    });

    await client.callTool({
      name: "annotate_code",
      arguments: { file: "src/math.ts", startLine: 2, endLine: 2, snapshot: "  return a + b;", body: "agent note" },
    });

    const got = await client.callTool({ name: "get_annotations", arguments: { file: "src/math.ts", limit: 10 } });
    const text = textOf(got as never);
    expect(text).toContain("human note");
    expect(text).toContain("agent note");
  });

  it("tells the agent where the code moved to, and keeps the saved lines", async () => {
    const snap = "export function add(a, b) {\n  return a + b;";
    await client.callTool({
      name: "annotate_code",
      arguments: { file: "src/math.ts", startLine: 1, endLine: 2, snapshot: snap, body: "keep add() pure" },
    });

    // Someone adds an import at the top: the code is the same, two lines lower.
    await writeFile(
      join(root, "src", "math.ts"),
      `import { z } from "./z.js";\n\n${"export function add(a, b) {\n  return a + b;\n}\n"}`,
      "utf8",
    );

    const got = await client.callTool({ name: "get_annotations", arguments: { file: "src/math.ts" } });
    expect(textOf(got as never)).toContain("src/math.ts:3-4 (moved from 1-2)");
  });

  it("says the code is not found rather than pointing at other code", async () => {
    const snap = "export function add(a, b) {\n  return a + b;";
    await client.callTool({
      name: "annotate_code",
      arguments: { file: "src/math.ts", startLine: 1, endLine: 2, snapshot: snap, body: "keep add() pure" },
    });
    await writeFile(join(root, "src", "math.ts"), "export const add = (a, b) => a + b;\n", "utf8");

    const got = await client.callTool({ name: "get_annotations", arguments: { file: "src/math.ts" } });
    expect(textOf(got as never)).toContain("(code not found)");
  });

  it("stops handing back a note once the work is done", async () => {
    const saved = await client.callTool({
      name: "annotate_code",
      arguments: { file: "src/math.ts", startLine: 1, endLine: 2, snapshot: "export function add(a, b) {", body: "swap this for the shared helper" },
    });
    const id = /Saved annotation (\S+)/.exec(textOf(saved as never))![1]!;

    const before = await client.callTool({ name: "get_annotations", arguments: { file: "src/math.ts" } });
    expect(textOf(before as never)).toContain("shared helper");

    await client.callTool({ name: "resolve_annotation", arguments: { id } });

    // The work is finished, so the note stops spending context on every turn.
    const after = await client.callTool({ name: "get_annotations", arguments: { file: "src/math.ts", limit: 10 } });
    expect(textOf(after as never)).not.toContain("shared helper");
  });

  it("keeps a note the editor finished out of the agent's results", async () => {
    const editor = await editorStore();
    const note = await editor.add({
      body: "human note, already handled",
      anchor: { file: "src/math.ts", startLine: 1, endLine: 1, snapshot: "export function add(a, b) {" },
      provenance: "human",
    });
    await editor.resolve(note.id, "human");

    const got = await client.callTool({ name: "get_annotations", arguments: { file: "src/math.ts", limit: 10 } });
    expect(textOf(got as never)).not.toContain("already handled");
  });

  it("says so plainly when the id is not one of ours", async () => {
    const got = await client.callTool({ name: "resolve_annotation", arguments: { id: "not-an-id" } });
    expect(textOf(got as never)).toMatch(/No annotation with id/);
  });

  it("rejects malformed input at the tool boundary (negative startLine)", async () => {
    const bad = await client.callTool({
      name: "annotate_code",
      arguments: { file: "src/math.ts", startLine: -1, endLine: 2, snapshot: "x", body: "y" },
    });
    expect((bad as { isError?: boolean }).isError).toBe(true);
  });

  describe("named sets", () => {
    /** Write note `order` of `scope` onto one line of the fixture. */
    async function addTo(scope: string, order: number, body: string) {
      return client.callTool({
        name: "annotate_code",
        arguments: {
          file: "src/math.ts",
          startLine: 2,
          endLine: 2,
          snapshot: "  return a + b;",
          body,
          scope,
          order,
        },
      });
    }

    it("takes a set and a place in it when writing a note", async () => {
      await addTo("pr/142", 1, "check the boundary first");

      const editor = await editorStore();
      const [saved] = editor.all();
      expect(saved?.scope).toBe("pr/142");
      expect(saved?.order).toBe(1);
    });

    it("reads a set back in the order its author chose", async () => {
      await addTo("pr/142", 2, "then the handler");
      await addTo("pr/142", 1, "read the migration first");

      const got = await client.callTool({
        name: "get_annotations",
        arguments: { scope: "pr/142" },
      });
      const text = textOf(got as never);
      expect(text.indexOf("read the migration first")).toBeLessThan(text.indexOf("then the handler"));
    });

    it("does not hand back notes from another set", async () => {
      await addTo("pr/142", 1, "only in the pull request");
      await addTo("onboarding/billing", 1, "only in the tour");

      const got = await client.callTool({ name: "get_annotations", arguments: { scope: "pr/142" } });
      expect(textOf(got as never)).toContain("only in the pull request");
      expect(textOf(got as never)).not.toContain("only in the tour");
    });

    it("tells the agent which set a note is in, and where in it", async () => {
      await addTo("pr/142", 1, "check the boundary first");

      const got = await client.callTool({ name: "get_annotations", arguments: { scope: "pr/142" } });
      expect(textOf(got as never)).toMatch(/pr\/142/);
    });

    it("leaves a note in no set when the agent names none", async () => {
      await client.callTool({
        name: "annotate_code",
        arguments: {
          file: "src/math.ts",
          startLine: 2,
          endLine: 2,
          snapshot: "  return a + b;",
          body: "a plain working note",
        },
      });

      const editor = await editorStore();
      expect(editor.all()[0]?.scope).toBeUndefined();
    });

    it("refuses a read that names neither a file nor a set", async () => {
      // There must be no way to ask for everything: that is what the result
      // bound exists to prevent, and an empty argument list must not be it.
      const bad = await client.callTool({ name: "get_annotations", arguments: {} });
      expect((bad as { isError?: boolean }).isError).toBe(true);
      // The store throws here too, so an error alone proves nothing. What this
      // pins is the message an agent actually reads: it has to say what to pass
      // next, not just that something went wrong.
      expect(textOf(bad as never)).toMatch(/pass a file, a scope, or both/i);
    });

    it("says when to reach for a set, not only that sets exist", async () => {
      const { tools } = await client.listTools();
      const get = tools.find((t) => t.name === "get_annotations");
      expect(get?.description ?? "").toMatch(/scope/i);
      const annotate = tools.find((t) => t.name === "annotate_code");
      expect(annotate?.description ?? "").toMatch(/scope/i);
    });
  });
});
