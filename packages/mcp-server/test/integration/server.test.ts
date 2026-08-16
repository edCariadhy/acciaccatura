import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
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
    // Kept short on purpose: every tool costs a line in the agent's tool list
    // on every turn, which is the same scarce context bounded results protect.
    expect(tools.map((t) => t.name).sort()).toEqual([
      "annotate_code",
      "get_annotations",
      "remove_annotation",
      "resolve_annotation",
      "scope_status",
      "update_annotation",
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

  /** Put a note straight on disk so a test can state its age. */
  async function writeAged(createdAt: string, extra: Record<string, unknown> = {}): Promise<void> {
    await mkdir(join(root, ".acciaccatura"), { recursive: true });
    await writeFile(
      join(root, ".acciaccatura", "annotations.json"),
      JSON.stringify({
        version: 1,
        annotations: [
          {
            id: "aged",
            body: "this has been waiting a while",
            anchor: {
              file: "src/math.ts",
              startLine: 1,
              endLine: 2,
              snapshot: "export function add(a, b) {\n  return a + b;",
              snapshotHash: "stale",
            },
            provenance: "agent",
            trust: "suggested",
            createdAt,
            updatedAt: createdAt,
            ...extra,
          },
        ],
      }),
      "utf8",
    );
  }

  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

  it("says how long an old note has been open, so an agent can weigh it", async () => {
    await writeAged(daysAgo(40));
    const got = await client.callTool({
      name: "get_annotations",
      arguments: { file: "src/math.ts" },
    });
    // Notes are working notes. One open for weeks is likelier to describe work
    // that already moved on, and an agent cannot tell without being told.
    expect(textOf(got as never)).toMatch(/open 40 days/);
  });

  it("spends no words on a note written today", async () => {
    await writeAged(daysAgo(0));
    const got = await client.callTool({
      name: "get_annotations",
      arguments: { file: "src/math.ts" },
    });
    // Every returned annotation is paid for on every later turn, so an age
    // that says nothing useful is not printed at all.
    expect(textOf(got as never)).not.toMatch(/open \d+ day/);
  });

  it("leaves a finished note out entirely, so its age never comes up", async () => {
    await writeAged(daysAgo(90), { resolvedAt: daysAgo(1), resolvedBy: "human" });
    const got = await client.callTool({
      name: "get_annotations",
      arguments: { file: "src/math.ts" },
    });
    // This is why `render` never has to decide what "open" means for a finished
    // note: the query has already dropped it.
    expect(textOf(got as never)).toBe("No annotations for this location.");
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

    it("closes a whole set in one call when the change is merged", async () => {
      await addTo("pr/142", 1, "first thing to review");
      await addTo("pr/142", 2, "second thing to review");

      const closed = await client.callTool({
        name: "resolve_annotation",
        arguments: { scope: "pr/142" },
      });
      expect(textOf(closed as never)).toMatch(/2/);

      const got = await client.callTool({ name: "get_annotations", arguments: { scope: "pr/142" } });
      expect(textOf(got as never)).not.toContain("first thing to review");
    });

    it("does not close notes outside the set it was given", async () => {
      await addTo("pr/142", 1, "in the pull request");
      await addTo("onboarding/billing", 1, "in the tour");

      await client.callTool({ name: "resolve_annotation", arguments: { scope: "pr/142" } });

      const tour = await client.callTool({
        name: "get_annotations",
        arguments: { scope: "onboarding/billing" },
      });
      expect(textOf(tour as never)).toContain("in the tour");
      // Both halves, or this passes just as well when closing does nothing.
      const pr = await client.callTool({ name: "get_annotations", arguments: { scope: "pr/142" } });
      expect(textOf(pr as never)).not.toContain("in the pull request");
    });

    it("says plainly when a set had nothing left to close", async () => {
      // The set name must not contain any word the assertion looks for, or a
      // reply that echoes the name passes without saying anything true.
      const closed = await client.callTool({
        name: "resolve_annotation",
        arguments: { scope: "pr/777" },
      });
      expect((closed as { isError?: boolean }).isError).toBeFalsy();
      expect(textOf(closed as never)).toMatch(/no open notes/i);
      // An empty set must not be reported as work done.
      expect(textOf(closed as never)).not.toMatch(/^Closed/);
    });

    it("refuses a finish that names neither a note nor a set", async () => {
      const bad = await client.callTool({ name: "resolve_annotation", arguments: {} });
      expect((bad as { isError?: boolean }).isError).toBe(true);
      expect(textOf(bad as never)).toMatch(/id|scope/i);
    });

    it("refuses to guess when given both a note and a set", async () => {
      await addTo("pr/142", 1, "a note");
      const editor = await editorStore();
      const id = editor.all()[0]!.id;

      // Ambiguous: closing the set and finishing one note are different acts.
      const bad = await client.callTool({
        name: "resolve_annotation",
        arguments: { id, scope: "pr/142" },
      });
      expect((bad as { isError?: boolean }).isError).toBe(true);
    });

    it("lists every set with its counts when asked for no set in particular", async () => {
      await addTo("pr/142", 1, "review this");
      await addTo("onboarding/billing", 1, "tour this");

      const status = await client.callTool({ name: "scope_status", arguments: {} });
      const text = textOf(status as never);
      expect(text).toContain("pr/142");
      expect(text).toContain("onboarding/billing");
    });

    it("says there are no sets rather than returning an empty answer", async () => {
      const status = await client.callTool({ name: "scope_status", arguments: {} });
      expect(textOf(status as never)).toMatch(/no (named )?sets/i);
    });

    it("reports how one set lines up with the code, in counts", async () => {
      await addTo("pr/142", 1, "still true");

      const status = await client.callTool({
        name: "scope_status",
        arguments: { scope: "pr/142" },
      });
      const text = textOf(status as never);
      expect(text).toMatch(/1 aligned/);
      expect(text).toMatch(/0 drifted/);
      expect(text).toMatch(/0 gone/);
    });

    it("reports code that moved out from under a set", async () => {
      await addTo("pr/142", 1, "this one moved");
      // Push the anchored line down the file; the code still exists elsewhere.
      await writeFile(
        join(root, "src", "math.ts"),
        "// added\n// added\nexport function add(a, b) {\n  return a + b;\n}\n",
        "utf8",
      );

      const status = await client.callTool({
        name: "scope_status",
        arguments: { scope: "pr/142" },
      });
      expect(textOf(status as never)).toMatch(/1 drifted/);
    });

    it("gives no report at all for a set that does not exist", async () => {
      await addTo("pr/142", 1, "a note");

      // "No such set" and "a set with nothing wrong" are different answers.
      const status = await client.callTool({
        name: "scope_status",
        arguments: { scope: "pr/999" },
      });
      expect(textOf(status as never)).toMatch(/no set named/i);
      expect(textOf(status as never)).not.toMatch(/aligned/);
    });

    it("says when to check a set, not only that checking exists", async () => {
      const { tools } = await client.listTools();
      const status = tools.find((t) => t.name === "scope_status");
      expect(status?.description ?? "").toMatch(/before|when/i);
      // Counts, never a score: the description must not promise a verdict.
      expect(status?.description ?? "").not.toMatch(/staleness score|score/i);
    });

    it("closes the loop: a drifted set is repaired and reads aligned again", async () => {
      await addTo("onboarding/billing", 1, "the tour step");
      const editor = await editorStore();
      const id = editor.all()[0]!.id;

      // Push the anchored line down the file. The note now points at the wrong
      // place, which scope_status reports and nothing yet can fix.
      const moved = "// added\n// added\nexport function add(a, b) {\n  return a + b;\n}\n";
      await writeFile(join(root, "src", "math.ts"), moved, "utf8");

      const before = await client.callTool({
        name: "scope_status",
        arguments: { scope: "onboarding/billing" },
      });
      expect(textOf(before as never)).toMatch(/1 drifted/);

      // Repair it: a fresh capture of where the code sits now.
      const fixed = await client.callTool({
        name: "update_annotation",
        arguments: {
          id,
          file: "src/math.ts",
          startLine: 4,
          endLine: 4,
          snapshot: "  return a + b;",
        },
      });
      expect((fixed as { isError?: boolean }).isError).toBeFalsy();

      const after = await client.callTool({
        name: "scope_status",
        arguments: { scope: "onboarding/billing" },
      });
      expect(textOf(after as never)).toMatch(/1 aligned/);
      expect(textOf(after as never)).toMatch(/0 drifted/);
    });

    it("keeps the note's id through a repair, so a cached id still works", async () => {
      await addTo("pr/142", 1, "before");
      const editor = await editorStore();
      const id = editor.all()[0]!.id;

      await client.callTool({
        name: "update_annotation",
        arguments: { id, body: "after" },
      });

      await editor.reload();
      expect(editor.all()).toHaveLength(1);
      expect(editor.get(id)?.body).toBe("after");
    });

    it("re-sequences a tour without rewriting it", async () => {
      await addTo("onboarding/billing", 1, "was first");
      await addTo("onboarding/billing", 2, "was second");
      const editor = await editorStore();
      const firstId = editor.all().find((a) => a.body === "was first")!.id;

      await client.callTool({
        name: "update_annotation",
        arguments: { id: firstId, order: 3 },
      });

      const got = await client.callTool({
        name: "get_annotations",
        arguments: { scope: "onboarding/billing" },
      });
      const text = textOf(got as never);
      expect(text.indexOf("was second")).toBeLessThan(text.indexOf("was first"));
    });

    it("says so plainly when the id is not one of ours", async () => {
      const bad = await client.callTool({
        name: "update_annotation",
        arguments: { id: "not-an-id", body: "x" },
      });
      expect(textOf(bad as never)).toMatch(/no annotation with id/i);
    });

    it("refuses a repair that changes nothing", async () => {
      await addTo("pr/142", 1, "a note");
      const editor = await editorStore();
      const id = editor.all()[0]!.id;

      // A call with only an id would silently bump updatedAt and say it worked.
      const bad = await client.callTool({ name: "update_annotation", arguments: { id } });
      expect((bad as { isError?: boolean }).isError).toBe(true);
    });

    it("refuses half an anchor, rather than anchoring at a guess", async () => {
      await addTo("pr/142", 1, "a note");
      const editor = await editorStore();
      const id = editor.all()[0]!.id;

      // Line numbers without the text they point at cannot be hashed, and a
      // note anchored on a guess is the failure this product exists to avoid.
      // A body goes along too, or the empty-change guard answers instead and
      // this passes without the anchor ever being checked.
      const bad = await client.callTool({
        name: "update_annotation",
        arguments: { id, body: "a real change", startLine: 4, endLine: 4 },
      });
      expect((bad as { isError?: boolean }).isError).toBe(true);
      expect(textOf(bad as never)).toMatch(/snapshot/i);

      // And it must not have half-applied the body while refusing the anchor.
      const editor2 = await editorStore();
      expect(editor2.get(id)?.body).toBe("a note");
    });

    it("tells an agent to re-read the code before repairing an anchor", async () => {
      const { tools } = await client.listTools();
      const update = tools.find((t) => t.name === "update_annotation");
      expect(update?.description ?? "").toMatch(/snapshot/i);
      // Repair keeps identity; the description has to say so, or an agent will
      // reach for remove + annotate and lose the note's place in its set.
      expect(update?.description ?? "").toMatch(/id|same note/i);
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

/**
 * Sets as resources.
 *
 * Discovery used to cost a tool call, and a tool costs a line in the agent's
 * tool list on every turn whether it is used or not. `resources/list` is the
 * protocol's own answer to "what is here", so the sets belong there. A resource
 * reads no code, which is exactly why it must not state a position as if it
 * were current.
 */
describe("sets as resources", () => {
  /** Put `count` notes in a set, in order, and hand back their ids. */
  async function seedSet(scope: string, bodies: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const [i, body] of bodies.entries()) {
      const saved = await client.callTool({
        name: "annotate_code",
        arguments: {
          file: "src/math.ts",
          startLine: 1,
          endLine: 1,
          snapshot: "export function add(a, b) {",
          body,
          scope,
          order: i + 1,
        },
      });
      ids.push((textOf(saved as never).match(/Saved annotation (\S+)/) ?? [])[1] ?? "");
    }
    return ids;
  }

  it("lists every set by name, so finding one costs no tool call", async () => {
    await seedSet("pr/142", ["read this first", "then this"]);
    await seedSet("onboarding/billing", ["how billing starts"]);

    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain("acciaccatura://scopes/pr/142");
    expect(uris).toContain("acciaccatura://scopes/onboarding/billing");
    // The listing carries what each set holds, so a client can choose without
    // reading any of them.
    const pr = resources.find((r) => r.uri === "acciaccatura://scopes/pr/142");
    expect(pr?.description ?? "").toMatch(/2 notes/);
    expect(pr?.description ?? "").toMatch(/2 open/);
  });

  it("reads back every URI it lists, slashes and all", async () => {
    await seedSet("pr/142", ["a note"]);
    await seedSet("onboarding/billing", ["another note"]);

    // The round trip is the property, not the spelling. `{scope}` percent-
    // encodes the slash and then fails to match its own URI back, so every
    // listed set becomes unreadable — and set names are `kind/name` by
    // convention, which makes that every set there is. Checking only the
    // listing would miss it: the listing builds its URIs by hand.
    const { resources } = await client.listResources();
    expect(resources.length).toBeGreaterThan(0);
    for (const resource of resources) {
      const read = await client.readResource({ uri: resource.uri });
      expect(String(read.contents[0]?.text ?? ""), `could not read ${resource.uri}`).not.toBe("");
    }
    expect(resources.map((r) => r.uri)).toContain("acciaccatura://scopes/pr/142");
  });

  it("reads a set in its author's order, not the order it was written", async () => {
    await client.callTool({
      name: "annotate_code",
      arguments: { file: "src/math.ts", startLine: 1, endLine: 1, snapshot: "x", body: "second", scope: "pr/9", order: 2 },
    });
    await client.callTool({
      name: "annotate_code",
      arguments: { file: "src/math.ts", startLine: 1, endLine: 1, snapshot: "x", body: "first", scope: "pr/9", order: 1 },
    });

    const read = await client.readResource({ uri: "acciaccatura://scopes/pr/9" });
    const text = String(read.contents[0]?.text ?? "");
    // Sequence is the point of a set: "read the migration before the handler"
    // is information no ranking can work out.
    expect(text.indexOf("first")).toBeLessThan(text.indexOf("second"));
  });

  it("says its line numbers are where a note was written, not where the code is", async () => {
    await seedSet("pr/142", ["a note"]);
    const read = await client.readResource({ uri: "acciaccatura://scopes/pr/142" });
    const text = String(read.contents[0]?.text ?? "");
    // A resource reads no code, so it cannot know whether those lines still
    // hold. Stating a position without that caveat is the quiet wrong answer.
    expect(text).toMatch(/written at 1-1/);
    expect(text).toMatch(/not where the code is now/i);
    expect(text).toMatch(/get_annotations/);
  });

  it("refuses a set that does not exist rather than returning an empty one", async () => {
    await seedSet("pr/142", ["a note"]);
    // "No such set" and "a set with nothing in it" are different answers, and
    // an agent has to be able to tell them apart.
    await expect(client.readResource({ uri: "acciaccatura://scopes/pr/999" })).rejects.toThrow(
      /No set named pr\/999/,
    );
  });

  it("finds a set whose name a client chose to percent-encode", async () => {
    await seedSet("pr/142", ["a note"]);
    const read = await client.readResource({ uri: "acciaccatura://scopes/pr%2F142" });
    expect(String(read.contents[0]?.text ?? "")).toContain("a note");
  });

  it("sees a set written after the client last listed", async () => {
    // Two writers, one store. The server holds a copy from startup and the
    // human keeps annotating; a set they made must not be invisible because
    // this process started first.
    const editor = await editorStore();
    await editor.add({
      body: "written in the editor",
      anchor: { file: "src/math.ts", startLine: 1, endLine: 1, snapshot: "export function add(a, b) {" },
      provenance: "human",
      scope: "pr/later",
    });

    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain("acciaccatura://scopes/pr/later");
  });

  it("offers the index as a document, not only as a client-side listing", async () => {
    await seedSet("pr/142", ["a note"]);
    const read = await client.readResource({ uri: "acciaccatura://scopes" });
    const text = String(read.contents[0]?.text ?? "");
    expect(text).toMatch(/pr\/142/);
    expect(text).toMatch(/1 note\b/);
  });

  it("says a workspace has no sets rather than returning an empty document", async () => {
    const read = await client.readResource({ uri: "acciaccatura://scopes" });
    expect(String(read.contents[0]?.text ?? "")).toMatch(/No named sets/i);
  });

  it("tells a closed set apart from an empty one", async () => {
    const [id] = await seedSet("pr/142", ["a note"]);
    await client.callTool({ name: "resolve_annotation", arguments: { id } });

    const read = await client.readResource({ uri: "acciaccatura://scopes/pr/142" });
    const text = String(read.contents[0]?.text ?? "");
    // A set whose work is over is a real state with a real meaning. "No notes"
    // would read as a set nobody ever wrote into.
    expect(text).toMatch(/Every note in this set is finished/i);
    expect(text).not.toMatch(/No open notes/i);
  });

  it("leaves finished notes out of the reading, but says they are there", async () => {
    const ids = await seedSet("pr/142", ["done already", "still to read"]);
    await client.callTool({ name: "resolve_annotation", arguments: { id: ids[0] } });

    const read = await client.readResource({ uri: "acciaccatura://scopes/pr/142" });
    const text = String(read.contents[0]?.text ?? "");
    expect(text).toContain("still to read");
    expect(text).not.toContain("done already");
    expect(text).toMatch(/1 finished note is not listed/);
  });

  it("does not spend a tool slot on any of this", async () => {
    const { tools } = await client.listTools();
    // The whole reason resources exist here: every tool is a line in the tool
    // list on every turn, paid whether or not it is ever called.
    expect(tools.map((t) => t.name).sort()).toEqual([
      "annotate_code",
      "get_annotations",
      "remove_annotation",
      "resolve_annotation",
      "scope_status",
      "update_annotation",
    ]);
  });
});

/**
 * We advertise `resources.listChanged`, which entitles a client to list the
 * sets once and then wait to be told. Advertising a capability and never
 * honouring it leaves that client reading a list that quietly went out of date.
 */
describe("telling a client the set list moved", () => {
  /** Connect a client that records every resource-list-changed notification. */
  async function connectCounting(): Promise<{ c: Client; count: () => number }> {
    const store = new AnnotationStore(join(root, ".acciaccatura", "annotations.json"));
    await store.load();
    const server = createServer(store, root);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const c = new Client({ name: "test", version: "0" });
    let seen = 0;
    c.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
      seen++;
    });
    await c.connect(clientT);
    return { c, count: () => seen };
  }

  const settle = () => new Promise((r) => setTimeout(r, 20));

  it("says so when a note creates a set that did not exist", async () => {
    const { c, count } = await connectCounting();
    await c.callTool({
      name: "annotate_code",
      arguments: { file: "src/math.ts", startLine: 1, endLine: 1, snapshot: "x", body: "n", scope: "pr/new" },
    });
    await settle();
    expect(count()).toBe(1);
    await c.close();
  });

  it("stays quiet for a note that joins a set already there", async () => {
    const { c, count } = await connectCounting();
    const add = (body: string) =>
      c.callTool({
        name: "annotate_code",
        arguments: { file: "src/math.ts", startLine: 1, endLine: 1, snapshot: "x", body, scope: "pr/1" },
      });
    await add("first");
    await settle();
    const afterFirst = count();
    await add("second");
    await settle();
    // The list did not change, so there is nothing to tell. A notification per
    // write would train a client to re-list for no reason.
    expect(count()).toBe(afterFirst);
    await c.close();
  });

  it("stays quiet when a note is only marked done", async () => {
    const { c, count } = await connectCounting();
    const saved = await c.callTool({
      name: "annotate_code",
      arguments: { file: "src/math.ts", startLine: 1, endLine: 1, snapshot: "x", body: "n", scope: "pr/1" },
    });
    await settle();
    const before = count();
    const id = (textOf(saved as never).match(/Saved annotation (\S+)/) ?? [])[1];
    await c.callTool({ name: "resolve_annotation", arguments: { id } });
    await settle();
    // A finished note still belongs to its set, so the list is unchanged.
    expect(count()).toBe(before);
    await c.close();
  });

  it("says so when the last note leaves a set", async () => {
    const { c, count } = await connectCounting();
    const saved = await c.callTool({
      name: "annotate_code",
      arguments: { file: "src/math.ts", startLine: 1, endLine: 1, snapshot: "x", body: "n", scope: "pr/1" },
    });
    await settle();
    const before = count();
    const id = (textOf(saved as never).match(/Saved annotation (\S+)/) ?? [])[1];
    await c.callTool({ name: "remove_annotation", arguments: { id } });
    await settle();
    expect(count()).toBe(before + 1);
    await c.close();
  });

  it("says so when a note is moved out of its set", async () => {
    const { c, count } = await connectCounting();
    const saved = await c.callTool({
      name: "annotate_code",
      arguments: { file: "src/math.ts", startLine: 1, endLine: 1, snapshot: "x", body: "n", scope: "pr/1" },
    });
    await settle();
    const before = count();
    const id = (textOf(saved as never).match(/Saved annotation (\S+)/) ?? [])[1];
    await c.callTool({ name: "update_annotation", arguments: { id, scope: null } });
    await settle();
    expect(count()).toBe(before + 1);
    await c.close();
  });
});

/**
 * The procedures, as prompts.
 *
 * A set is a sequence, and how to work through one is a workflow the tools
 * cannot state on their own. These are prompts and not a Claude skill on
 * purpose: a skill is one vendor's format, and this product exists to deliver
 * intent at the protocol layer so every agent benefits.
 */
describe("procedures as prompts", () => {
  /** The text of the single message a prompt returns. */
  async function promptText(name: string, scope: string): Promise<string> {
    const got = await client.getPrompt({ name, arguments: { scope } });
    return got.messages.map((m) => (m.content.type === "text" ? m.content.text : "")).join("\n");
  }

  async function seed(scope: string, body = "a note"): Promise<void> {
    await client.callTool({
      name: "annotate_code",
      arguments: { file: "src/math.ts", startLine: 1, endLine: 1, snapshot: "export function add(a, b) {", body, scope, order: 1 },
    });
  }

  it("offers the three procedures a set implies, and no more", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual([
      "onboarding_tour",
      "repair_set",
      "review_change",
    ]);
    // A prompt has to say WHEN to reach for it, the same rule the tools follow.
    for (const p of prompts) {
      expect(p.description ?? "", `${p.name} has no when-to-use`).toMatch(/use this when/i);
    }
  });

  it("tells every procedure to believe the code over the note", async () => {
    await seed("pr/142");
    // The first invariant of the product. A procedure that left it out would be
    // teaching an agent to treat a stale note as an instruction.
    for (const name of ["review_change", "onboarding_tour", "repair_set"]) {
      const text = await promptText(name, "pr/142");
      expect(text, `${name} does not say the code wins`).toMatch(/the code wins|believe the code/i);
      expect(text, `${name} does not call them hints`).toMatch(/hints|not the truth/i);
    }
  });

  it("sends every procedure through the tools rather than pasting the notes in", async () => {
    await seed("pr/142", "the body of the note");
    for (const name of ["review_change", "onboarding_tour", "repair_set"]) {
      const text = await promptText(name, "pr/142");
      expect(text, `${name} does not call get_annotations`).toContain("get_annotations");
      // Copying the notes into the message would hand the agent a snapshot that
      // stopped being true when it was written, with no drift in it.
      expect(text, `${name} pasted the note body in`).not.toContain("the body of the note");
    }
  });

  it("makes the order the reason to use a set, in both reading procedures", async () => {
    await seed("pr/142");
    for (const name of ["review_change", "onboarding_tour"]) {
      expect(await promptText(name, "pr/142"), `${name} does not mention order`).toMatch(/order/i);
    }
  });

  it("stops a review from closing the set on its own", async () => {
    await seed("pr/142");
    const text = await promptText("review_change", "pr/142");
    // Closing means the change merged, which is not the reviewer's call.
    expect(text).toMatch(/do not close the set/i);
  });

  it("stops a tour from finishing the notes it just read", async () => {
    await seed("onboarding/billing");
    const text = await promptText("onboarding_tour", "onboarding/billing");
    // A standing walkthrough outlives any one reading. An agent that "completed"
    // it would take it away from the next person.
    expect(text).toMatch(/do not close the set/i);
    expect(text).toMatch(/standing/i);
    expect(text).toMatch(/change nothing/i);
  });

  it("makes repair re-point rather than delete, and never on a guess", async () => {
    await seed("onboarding/billing");
    const text = await promptText("repair_set", "onboarding/billing");
    // update_annotation exists so a drifted note can be fixed without losing its
    // id or its place. A procedure that reached for remove would undo that.
    expect(text).toContain("update_annotation");
    expect(text).toMatch(/all four/i);
    expect(text).toMatch(/snapshot/);
    expect(text).toMatch(/never re-point a note on a guess/i);
  });

  it("names the sets that do exist when asked for one that does not", async () => {
    await seed("pr/142");
    // Handing back a procedure for a set that is not there would send an agent
    // to run six steps against nothing.
    await expect(client.getPrompt({ name: "review_change", arguments: { scope: "pr/999" } })).rejects.toThrow(
      /No set named pr\/999.*pr\/142/s,
    );
  });

  it("says a workspace has no sets rather than listing none", async () => {
    await expect(client.getPrompt({ name: "review_change", arguments: { scope: "pr/1" } })).rejects.toThrow(
      /no named sets yet/i,
    );
  });

  it("sees a set the editor made after this server started", async () => {
    const editor = await editorStore();
    await editor.add({
      body: "written in the editor",
      anchor: { file: "src/math.ts", startLine: 1, endLine: 1, snapshot: "export function add(a, b) {" },
      provenance: "human",
      scope: "pr/later",
    });
    expect(await promptText("review_change", "pr/later")).toContain("pr/later");
  });

  it("does not spend a tool slot on any of this", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(6);
  });
});
