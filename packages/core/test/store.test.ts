import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AnnotationStore, DEFAULT_LIMIT, DEFAULT_SCOPE_LIMIT } from "../src/store.js";
import type { NewAnnotation } from "../src/types.js";

function draft(overrides: Partial<NewAnnotation> = {}): NewAnnotation {
  return {
    body: "why this exists",
    provenance: "agent",
    anchor: { file: "src/a.ts", startLine: 10, endLine: 12, snapshot: "const x = 1;" },
    ...overrides,
  };
}

describe("AnnotationStore", () => {
  let dir: string;
  let storePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "acciaccatura-"));
    storePath = join(dir, ".acciaccatura", "annotations.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("treats a missing store file as empty, not an error", async () => {
    const store = new AnnotationStore(storePath);
    await store.load();
    expect(store.all()).toHaveLength(0);
  });

  it("throws if used before load()", async () => {
    const store = new AnnotationStore(storePath);
    expect(() => store.all()).toThrow(/load\(\)/);
  });

  it("derives id, hash, timestamps, and default trust on add", async () => {
    const store = new AnnotationStore(storePath);
    await store.load();
    const human = await store.add(draft({ provenance: "human" }));
    const agent = await store.add(draft({ provenance: "agent" }));

    expect(human.id).not.toEqual(agent.id);
    expect(human.anchor.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(human.createdAt).toEqual(human.updatedAt);
    // Human notes are authoritative by default; agent notes only suggested.
    expect(human.trust).toBe("authoritative");
    expect(agent.trust).toBe("suggested");
  });

  it("persists across reloads", async () => {
    const first = new AnnotationStore(storePath);
    await first.load();
    const saved = await first.add(draft());

    const second = new AnnotationStore(storePath);
    await second.load();
    expect(second.get(saved.id)?.body).toBe("why this exists");
  });

  it("bounds query results and defaults to 3", async () => {
    const store = new AnnotationStore(storePath);
    await store.load();
    for (let i = 0; i < 10; i++) {
      await store.add(draft({ anchor: { file: "src/a.ts", startLine: i + 1, endLine: i + 1, snapshot: `l${i}` } }));
    }
    expect(store.query({ file: "src/a.ts" })).toHaveLength(3);
    expect(store.query({ file: "src/a.ts", limit: 5 })).toHaveLength(5);
    expect(store.query({ file: "src/other.ts" })).toHaveLength(0);
  });

  it("ranks a line-overlapping annotation above distant ones", async () => {
    const store = new AnnotationStore(storePath);
    await store.load();
    const far = await store.add(draft({ anchor: { file: "src/a.ts", startLine: 100, endLine: 100, snapshot: "far" } }));
    const near = await store.add(draft({ anchor: { file: "src/a.ts", startLine: 40, endLine: 50, snapshot: "near" } }));

    const [top] = store.query({ file: "src/a.ts", line: 45, limit: 1 });
    expect(top?.id).toBe(near.id);
    expect(top?.id).not.toBe(far.id);
  });

  it("breaks a tie between equally relevant notes toward the most recently updated", async () => {
    const store = new AnnotationStore(storePath);
    await store.load();
    // Same distance from the query line, so only the tie-break separates them.
    const older = await store.add(draft({ anchor: { file: "src/a.ts", startLine: 5, endLine: 5, snapshot: "older" } }));
    const newer = await store.add(draft({ anchor: { file: "src/a.ts", startLine: 15, endLine: 15, snapshot: "newer" } }));

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(newer.updatedAt) + 5000));
    await store.update(newer.id, { body: "touched most recently" });
    vi.useRealTimers();

    const ranked = store.query({ file: "src/a.ts", line: 10, limit: 2 });
    expect(ranked.map((a) => a.id)).toEqual([newer.id, older.id]);
  });

  it("removes annotations idempotently", async () => {
    const store = new AnnotationStore(storePath);
    await store.load();
    const saved = await store.add(draft());
    expect(await store.remove(saved.id)).toBe(true);
    expect(await store.remove(saved.id)).toBe(false);
    expect(store.get(saved.id)).toBeUndefined();
  });

  it("keeps id, createdAt, and provenance when updating in place", async () => {
    const store = new AnnotationStore(storePath);
    await store.load();
    const saved = await store.add(draft({ provenance: "agent" }));

    // Anything holding the id — a cached MCP result, a tree-view selection —
    // must still resolve after an edit, so identity cannot be reissued.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(saved.createdAt) + 1000));
    const updated = await store.update(saved.id, { trust: "authoritative" });
    vi.useRealTimers();

    expect(updated?.id).toBe(saved.id);
    expect(updated?.createdAt).toBe(saved.createdAt);
    expect(updated?.provenance).toBe("agent");
    expect(updated?.body).toBe(saved.body);
    expect(updated?.trust).toBe("authoritative");
    expect(updated?.updatedAt > saved.updatedAt).toBe(true);
    expect(store.all()).toHaveLength(1);
    expect(store.get(saved.id)?.trust).toBe("authoritative");
  });

  it("re-derives the snapshot hash when an update moves the anchor", async () => {
    const store = new AnnotationStore(storePath);
    await store.load();
    const saved = await store.add(draft());

    // A healed anchor from reanchor(): new lines, new snapshot, same note.
    const updated = await store.update(saved.id, {
      anchor: { file: "src/a.ts", startLine: 40, endLine: 40, snapshot: "const x = 2;\r\n" },
    });

    expect(updated?.anchor.startLine).toBe(40);
    // Normalized before hashing, like add(), so a CRLF file is not falsely drifted.
    expect(updated?.anchor.snapshot).toBe("const x = 2;\n");
    expect(updated?.anchor.snapshotHash).not.toBe(saved.anchor.snapshotHash);
    expect(updated?.anchor.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("reports an unknown id instead of resurrecting the annotation", async () => {
    const store = new AnnotationStore(storePath);
    await store.load();
    const saved = await store.add(draft());
    await store.remove(saved.id);

    expect(await store.update(saved.id, { body: "back from the dead" })).toBeUndefined();
    expect(store.all()).toHaveLength(0);
  });

  it("persists updates across reloads", async () => {
    const first = new AnnotationStore(storePath);
    await first.load();
    const saved = await first.add(draft());
    await first.update(saved.id, { body: "revised" });

    const second = new AnnotationStore(storePath);
    await second.load();
    expect(second.get(saved.id)?.body).toBe("revised");
  });

  it("does not let one writer destroy another's annotation", async () => {
    // The real topology: the extension host and the MCP server are separate
    // processes over one store file. Each one holding its own copy in memory and
    // rewriting the file wholesale means the last writer wins and the other's
    // note is gone — "two writers, one store" has to survive this.
    const editor = new AnnotationStore(storePath);
    const server = new AnnotationStore(storePath);

    await editor.load();
    await editor.add(draft({ provenance: "human", anchor: { file: "src/a.ts", startLine: 1, endLine: 1, snapshot: "a" } }));

    await server.load(); // server starts, sees one annotation
    await editor.add(draft({ provenance: "human", anchor: { file: "src/b.ts", startLine: 1, endLine: 1, snapshot: "b" } }));
    await server.add(draft({ provenance: "agent", anchor: { file: "src/c.ts", startLine: 1, endLine: 1, snapshot: "c" } }));

    const verify = new AnnotationStore(storePath);
    await verify.load();
    expect(verify.all().map((a) => a.anchor.file).sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("keeps a concurrent addition when the other writer removes something", async () => {
    const editor = new AnnotationStore(storePath);
    const server = new AnnotationStore(storePath);
    await editor.load();
    const doomed = await editor.add(draft({ anchor: { file: "src/a.ts", startLine: 1, endLine: 1, snapshot: "a" } }));

    await server.load();
    await server.add(draft({ anchor: { file: "src/new.ts", startLine: 1, endLine: 1, snapshot: "new" } }));
    await editor.remove(doomed.id); // editor never saw the server's write

    const verify = new AnnotationStore(storePath);
    await verify.load();
    expect(verify.all().map((a) => a.anchor.file)).toEqual(["src/new.ts"]);
  });

  it("serialises concurrent writes from one process", async () => {
    const store = new AnnotationStore(storePath);
    await store.load();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.add(draft({ anchor: { file: `src/${i}.ts`, startLine: 1, endLine: 1, snapshot: `s${i}` } })),
      ),
    );

    const verify = new AnnotationStore(storePath);
    await verify.load();
    expect(verify.all()).toHaveLength(20);
  });

  it("reload() picks up another writer's changes", async () => {
    const reader = new AnnotationStore(storePath);
    const writer = new AnnotationStore(storePath);
    await reader.load();
    await writer.load();

    await writer.add(draft({ anchor: { file: "src/late.ts", startLine: 1, endLine: 1, snapshot: "late" } }));
    expect(reader.all()).toHaveLength(0); // still the snapshot it loaded

    await reader.reload();
    expect(reader.all()).toHaveLength(1);
  });

  it("leaves no temp files beside the store", async () => {
    const store = new AnnotationStore(storePath);
    await store.load();
    const saved = await store.add(draft());
    await store.update(saved.id, { body: "revised" });
    await store.remove(saved.id);

    expect(await readdir(dirname(storePath))).toEqual(["annotations.json"]);
  });

  it("writes newline-terminated pretty JSON", async () => {
    const store = new AnnotationStore(storePath);
    await store.load();
    await store.add(draft());
    const raw = await readFile(storePath, "utf8");
    expect(raw.endsWith("}\n")).toBe(true);
    expect(raw).toContain("\n  ");
  });

  // A note is a working note between collaborators, not a permanent record. It
  // needs an end, or the store only ever grows and every stale note keeps
  // spending an agent's context. See docs/wiki/standards/storage-and-lifecycle.md.
  describe("finishing a note", () => {
    it("starts a note open", async () => {
      const store = new AnnotationStore(storePath);
      await store.load();
      const saved = await store.add(draft());
      expect(saved.resolvedAt).toBeUndefined();
    });

    it("marks a note done without changing who wrote it or its id", async () => {
      const store = new AnnotationStore(storePath);
      await store.load();
      const saved = await store.add(draft({ provenance: "agent" }));

      const done = await store.resolve(saved.id, "human");

      expect(done?.id).toBe(saved.id);
      expect(done?.createdAt).toBe(saved.createdAt);
      expect(done?.provenance).toBe("agent");
      expect(done?.resolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(done?.resolvedBy).toBe("human");
    });

    it("keeps a finished note out of the query an agent sees", async () => {
      const store = new AnnotationStore(storePath);
      await store.load();
      const open = await store.add(draft({ body: "still open" }));
      const done = await store.add(draft({ body: "already handled" }));
      await store.resolve(done.id, "agent");

      const found = store.query({ file: "src/a.ts", limit: 10 });
      expect(found.map((a) => a.id)).toEqual([open.id]);
    });

    it("hands back finished notes only when asked for them", async () => {
      const store = new AnnotationStore(storePath);
      await store.load();
      const done = await store.add(draft());
      await store.resolve(done.id, "human");

      const found = store.query({ file: "src/a.ts", limit: 10, includeResolved: true });
      expect(found.map((a) => a.id)).toEqual([done.id]);
    });

    it("does not spend the result bound on notes it will not return", async () => {
      const store = new AnnotationStore(storePath);
      await store.load();
      // Three finished notes ahead of three open ones: the default cap is 3, so
      // filtering after the cap would hand the agent an empty answer.
      for (let i = 0; i < 3; i++) {
        const stale = await store.add(draft({ body: `handled ${i}` }));
        await store.resolve(stale.id, "agent");
      }
      for (let i = 0; i < 3; i++) await store.add(draft({ body: `open ${i}` }));

      const found = store.query({ file: "src/a.ts" });
      expect(found).toHaveLength(3);
      expect(found.every((a) => a.resolvedAt === undefined)).toBe(true);
    });

    it("keeps the first finish time when resolve runs twice", async () => {
      const store = new AnnotationStore(storePath);
      await store.load();
      const saved = await store.add(draft());
      const first = await store.resolve(saved.id, "human");

      vi.useFakeTimers();
      vi.setSystemTime(new Date(Date.parse(first!.resolvedAt!) + 60_000));
      const second = await store.resolve(saved.id, "agent");
      vi.useRealTimers();

      // Two writers can both decide the work is done. The first one to say so
      // is the record; the second must not rewrite it.
      expect(second?.resolvedAt).toBe(first!.resolvedAt);
      expect(second?.resolvedBy).toBe("human");
    });

    it("reopens a note that was finished by mistake", async () => {
      const store = new AnnotationStore(storePath);
      await store.load();
      const saved = await store.add(draft());
      await store.resolve(saved.id, "human");

      const back = await store.reopen(saved.id);

      expect(back?.resolvedAt).toBeUndefined();
      expect(back?.resolvedBy).toBeUndefined();
      expect(store.query({ file: "src/a.ts" }).map((a) => a.id)).toEqual([saved.id]);
    });

    it("reports an unknown id instead of inventing a note", async () => {
      const store = new AnnotationStore(storePath);
      await store.load();
      expect(await store.resolve("no-such-id", "human")).toBeUndefined();
      expect(await store.reopen("no-such-id")).toBeUndefined();
    });

    it("is not lost when a read lands in the middle of the write", async () => {
      const store = new AnnotationStore(storePath);
      await store.load();
      const saved = await store.add(draft());

      // One process doing two jobs at once: the MCP server finishes a note for
      // one tool call while another tool call re-reads the file. A read that
      // lands mid-write replaces the list the write is about to save, and the
      // finish disappears. Reads have to queue behind writes.
      let writeFinished = false;
      const write = store.resolve(saved.id, "agent").then(() => {
        writeFinished = true;
      });
      const readSawTheWrite = await store.reload().then(() => writeFinished);
      await write;

      expect(readSawTheWrite).toBe(true);
      const reader = new AnnotationStore(storePath);
      await reader.load();
      expect(reader.get(saved.id)?.resolvedAt).toBeDefined();
    });

    it("survives the other writer, like every other change", async () => {
      const editor = new AnnotationStore(storePath);
      const agent = new AnnotationStore(storePath);
      await editor.load();
      await agent.load();
      const mine = await editor.add(draft({ provenance: "human" }));
      await agent.reload();
      const theirs = await agent.add(draft({ provenance: "agent" }));

      await editor.resolve(mine.id, "human");

      await agent.reload();
      expect(agent.get(theirs.id)).toBeDefined();
      expect(agent.get(mine.id)?.resolvedAt).toBeDefined();
    });
  });

  describe("sweeping finished notes", () => {
    it("deletes finished notes older than the cutoff", async () => {
      const store = new AnnotationStore(storePath);
      await store.load();
      const old = await store.add(draft({ body: "finished last week" }));
      await store.resolve(old.id, "human");

      const removed = await store.sweepResolved({ resolvedBefore: new Date(Date.now() + 1000) });

      expect(removed).toBe(1);
      expect(store.all()).toHaveLength(0);
    });

    it("deletes a note finished at the very moment of the cutoff", async () => {
      const store = new AnnotationStore(storePath);
      await store.load();
      const note = await store.add(draft());
      const done = await store.resolve(note.id, "human");

      // "Delete everything finished so far" passes the current moment. A note
      // finished in that same millisecond must go too, or the editor says it
      // deleted one note and deletes none.
      const removed = await store.sweepResolved({ resolvedBefore: new Date(done!.resolvedAt!) });

      expect(removed).toBe(1);
    });

    it("keeps finished notes newer than the cutoff", async () => {
      const store = new AnnotationStore(storePath);
      await store.load();
      const recent = await store.add(draft());
      await store.resolve(recent.id, "human");

      const removed = await store.sweepResolved({ resolvedBefore: new Date(Date.now() - 60_000) });

      expect(removed).toBe(0);
      expect(store.get(recent.id)).toBeDefined();
    });

    it("never deletes an open note, however old", async () => {
      const store = new AnnotationStore(storePath);
      await store.load();
      const open = await store.add(draft());

      // A cutoff far in the future: everything finished would go. Nothing did.
      const removed = await store.sweepResolved({ resolvedBefore: new Date(Date.now() + 86_400_000) });

      expect(removed).toBe(0);
      expect(store.get(open.id)).toBeDefined();
    });
  });

  it("reads a note saved before this field existed as still open", async () => {
    // The store file is a contract with files we do not control. An older
    // annotation has no resolvedAt at all, and must not read as finished.
    const older = {
      version: 1,
      annotations: [
        {
          id: "written-by-an-older-build",
          body: "no lifecycle fields here",
          anchor: {
            file: "src/a.ts",
            startLine: 1,
            endLine: 1,
            snapshot: "const x = 1;",
            snapshotHash: "0".repeat(64),
          },
          provenance: "human",
          trust: "authoritative",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    await mkdir(dirname(storePath), { recursive: true });
    await writeFile(storePath, JSON.stringify(older), "utf8");

    const store = new AnnotationStore(storePath);
    await store.load();
    expect(store.query({ file: "src/a.ts" })).toHaveLength(1);
    expect(store.get("written-by-an-older-build")?.resolvedAt).toBeUndefined();
  });

  describe("scopes", () => {
    /** A note in `set` at position `order`, on its own file unless told otherwise. */
    function inScope(scope: string, order: number, file = `src/f${order}.ts`): NewAnnotation {
      return draft({ scope, order, anchor: { file, startLine: 1, endLine: 1, snapshot: `l${order}` } });
    }

    it("leaves a note in no set when the writer names none", async () => {
      const store = new AnnotationStore(storePath);
      await store.load();
      const plain = await store.add(draft());

      expect(plain.scope).toBeUndefined();
      expect(plain.order).toBeUndefined();
    });

    it("writes a note into a named set, and keeps it there across a reload", async () => {
      const first = new AnnotationStore(storePath);
      await first.load();
      const saved = await first.add(inScope("pr/142", 1));

      const second = new AnnotationStore(storePath);
      await second.load();
      expect(second.get(saved.id)?.scope).toBe("pr/142");
      expect(second.get(saved.id)?.order).toBe(1);
    });

    it("returns a set in the order its author chose, not by relevance", async () => {
      const store = new AnnotationStore(storePath);
      await store.load();
      // Added out of sequence on purpose: insertion order must not decide.
      await store.add(inScope("pr/142", 3));
      await store.add(inScope("pr/142", 1));
      await store.add(inScope("pr/142", 2));

      const tour = store.query({ scope: "pr/142" });
      expect(tour.map((a) => a.order)).toEqual([1, 2, 3]);
    });

    it("keeps two notes given the same place in a steady order", async () => {
      const store = new AnnotationStore(storePath);
      await store.load();
      // An author can give two notes the same number. The set must still read
      // the same way every time, so oldest-first decides it.
      const first = await store.add(inScope("pr/142", 1, "src/one.ts"));
      vi.useFakeTimers();
      vi.setSystemTime(new Date(Date.parse(first.createdAt) + 5000));
      const second = await store.add(inScope("pr/142", 1, "src/two.ts"));
      vi.useRealTimers();

      expect(store.query({ scope: "pr/142" }).map((a) => a.id)).toEqual([first.id, second.id]);
    });

    it("puts notes with no place in the sequence after the ordered ones", async () => {
      const store = new AnnotationStore(storePath);
      await store.load();
      await store.add(draft({ scope: "pr/142" }));
      await store.add(inScope("pr/142", 1));

      expect(store.query({ scope: "pr/142" }).map((a) => a.order)).toEqual([1, undefined]);
    });

    it("does not mix in notes from another set, or unscoped ones", async () => {
      const store = new AnnotationStore(storePath);
      await store.load();
      await store.add(inScope("pr/142", 1));
      await store.add(inScope("onboarding/billing", 1));
      await store.add(draft());

      expect(store.query({ scope: "pr/142" })).toHaveLength(1);
    });

    it("reads a set that spans several files", async () => {
      const store = new AnnotationStore(storePath);
      await store.load();
      await store.add(inScope("onboarding/billing", 1, "src/pay.ts"));
      await store.add(inScope("onboarding/billing", 2, "src/invoice.ts"));

      const tour = store.query({ scope: "onboarding/billing" });
      expect(tour.map((a) => a.anchor.file)).toEqual(["src/pay.ts", "src/invoice.ts"]);
    });

    it("narrows to one file inside a set when the caller gives both", async () => {
      const store = new AnnotationStore(storePath);
      await store.load();
      await store.add(inScope("onboarding/billing", 1, "src/pay.ts"));
      await store.add(inScope("onboarding/billing", 2, "src/invoice.ts"));
      // Same file, different set: the file filter alone would let this through.
      await store.add(inScope("pr/142", 1, "src/pay.ts"));

      const onPay = store.query({ scope: "onboarding/billing", file: "src/pay.ts" });
      expect(onPay).toHaveLength(1);
      expect(onPay[0]?.order).toBe(1);
      expect(onPay[0]?.scope).toBe("onboarding/billing");
    });

    it("leaves finished notes out of a set read, as it does for a file", async () => {
      const store = new AnnotationStore(storePath);
      await store.load();
      const done = await store.add(inScope("pr/142", 1));
      await store.add(inScope("pr/142", 2));
      await store.resolve(done.id, "agent");

      expect(store.query({ scope: "pr/142" }).map((a) => a.order)).toEqual([2]);
      expect(store.query({ scope: "pr/142", includeResolved: true })).toHaveLength(2);
    });

    it("bounds a set read well above a file read, and lets the caller raise it", async () => {
      const store = new AnnotationStore(storePath);
      await store.load();
      for (let i = 1; i <= 25; i++) await store.add(inScope("onboarding/billing", i));

      // A tour is a set someone sat down and wrote, so three is far too few —
      // but it is still bounded, never a full dump.
      expect(store.query({ scope: "onboarding/billing" })).toHaveLength(DEFAULT_SCOPE_LIMIT);
      expect(store.query({ scope: "onboarding/billing", limit: 25 })).toHaveLength(25);
      expect(DEFAULT_SCOPE_LIMIT).toBeGreaterThan(DEFAULT_LIMIT);
    });

    it("keeps the sequence when a set read is cut short", async () => {
      const store = new AnnotationStore(storePath);
      await store.load();
      for (let i = 1; i <= 5; i++) await store.add(inScope("pr/142", i));

      // The cap must take the first of the tour, not an arbitrary few.
      expect(store.query({ scope: "pr/142", limit: 2 }).map((a) => a.order)).toEqual([1, 2]);
    });

    it("refuses a query that names neither a file nor a set", async () => {
      const store = new AnnotationStore(storePath);
      await store.load();
      await store.add(draft());

      // Without this there is a path that returns everything, which is the one
      // thing the result bound exists to prevent.
      expect(() => store.query({} as never)).toThrow(/file|scope/i);
    });

    describe("repairing a note in a set", () => {
      it("re-sequences a note without touching anything else", async () => {
        const store = new AnnotationStore(storePath);
        await store.load();
        const note = await store.add(inScope("onboarding/billing", 3));

        const moved = await store.update(note.id, { order: 1 });
        expect(moved?.order).toBe(1);
        expect(moved?.scope).toBe("onboarding/billing");
        expect(moved?.id).toBe(note.id);
        expect(moved?.body).toBe(note.body);
      });

      it("moves a note to another set, keeping its id", async () => {
        const store = new AnnotationStore(storePath);
        await store.load();
        const note = await store.add(inScope("pr/142", 1));

        const moved = await store.update(note.id, { scope: "onboarding/billing", order: 4 });
        expect(moved?.id).toBe(note.id);
        expect(store.query({ scope: "pr/142" })).toHaveLength(0);
        expect(store.query({ scope: "onboarding/billing" })).toHaveLength(1);
      });

      it("takes a note out of its set when the scope is cleared", async () => {
        const store = new AnnotationStore(storePath);
        await store.load();
        const note = await store.add(inScope("pr/142", 1));

        // Absent is what "in no set" means, so clearing has to drop the field
        // rather than leave an empty string behind.
        const loose = await store.update(note.id, { scope: null });
        expect(loose?.scope).toBeUndefined();
        expect(store.scopes()).toEqual([]);
      });

      it("clears a note's place in the sequence without removing it from the set", async () => {
        const store = new AnnotationStore(storePath);
        await store.load();
        const note = await store.add(inScope("pr/142", 2));

        const loose = await store.update(note.id, { order: null });
        expect(loose?.order).toBeUndefined();
        expect(loose?.scope).toBe("pr/142");
      });

      it("leaves the set alone when an update does not mention it", async () => {
        const store = new AnnotationStore(storePath);
        await store.load();
        const note = await store.add(inScope("pr/142", 2));

        const edited = await store.update(note.id, { body: "a better explanation" });
        expect(edited?.scope).toBe("pr/142");
        expect(edited?.order).toBe(2);
      });

      it("re-points a drifted note at where its code went, and it reads aligned again", async () => {
        const store = new AnnotationStore(storePath);
        await store.load();
        const note = await store.add(
          draft({
            scope: "onboarding/billing",
            order: 1,
            anchor: { file: "src/pay.ts", startLine: 2, endLine: 2, snapshot: "  return a * 2;" },
          }),
        );

        // The repair is a fresh capture, not a guess: the caller passes the text
        // as it is now, and the hash is re-derived from it.
        const repaired = await store.update(note.id, {
          anchor: { file: "src/pay.ts", startLine: 9, endLine: 9, snapshot: "  return a * 3;" },
        });

        expect(repaired?.id).toBe(note.id);
        expect(repaired?.anchor.startLine).toBe(9);
        expect(repaired?.anchor.snapshotHash).not.toBe(note.anchor.snapshotHash);
        // Repairing must not quietly finish or unscope the note.
        expect(repaired?.scope).toBe("onboarding/billing");
        expect(repaired?.resolvedAt).toBeUndefined();
      });
    });

    describe("closing a set", () => {
      it("finishes every open note in the set, and says how many", async () => {
        const store = new AnnotationStore(storePath);
        await store.load();
        await store.add(inScope("pr/142", 1));
        await store.add(inScope("pr/142", 2));

        expect(await store.resolveScope("pr/142", "agent")).toBe(2);
        expect(store.query({ scope: "pr/142" })).toHaveLength(0);
        expect(store.query({ scope: "pr/142", includeResolved: true })).toHaveLength(2);
      });

      it("records who closed it on every note", async () => {
        const store = new AnnotationStore(storePath);
        await store.load();
        await store.add(inScope("pr/142", 1));
        await store.resolveScope("pr/142", "agent");

        const [note] = store.query({ scope: "pr/142", includeResolved: true });
        expect(note?.resolvedBy).toBe("agent");
        expect(note?.resolvedAt).toBeTruthy();
      });

      it("leaves other sets and unscoped notes alone", async () => {
        const store = new AnnotationStore(storePath);
        await store.load();
        await store.add(inScope("pr/142", 1));
        await store.add(inScope("onboarding/billing", 1));
        const loose = await store.add(draft());

        expect(await store.resolveScope("pr/142", "agent")).toBe(1);
        expect(store.query({ scope: "onboarding/billing" })).toHaveLength(1);
        expect(store.get(loose.id)?.resolvedAt).toBeUndefined();
      });

      it("keeps the first finish time when a set is closed twice", async () => {
        const store = new AnnotationStore(storePath);
        await store.load();
        const first = await store.add(inScope("pr/142", 1));
        await store.resolveScope("pr/142", "human");
        const when = store.get(first.id)?.resolvedAt;

        // Closing again finishes nothing new, and must not overwrite who ended
        // it — the same rule single-note resolve follows.
        expect(await store.resolveScope("pr/142", "agent")).toBe(0);
        expect(store.get(first.id)?.resolvedAt).toBe(when);
        expect(store.get(first.id)?.resolvedBy).toBe("human");
      });

      it("counts only what it actually finished in a half-closed set", async () => {
        const store = new AnnotationStore(storePath);
        await store.load();
        const done = await store.add(inScope("pr/142", 1));
        await store.add(inScope("pr/142", 2));
        await store.resolve(done.id, "human");

        expect(await store.resolveScope("pr/142", "agent")).toBe(1);
      });

      it("reports nothing done for a set that does not exist", async () => {
        const store = new AnnotationStore(storePath);
        await store.load();
        await store.add(inScope("pr/142", 1));

        expect(await store.resolveScope("pr/999", "agent")).toBe(0);
      });

      it("is reversible one note at a time", async () => {
        const store = new AnnotationStore(storePath);
        await store.load();
        const note = await store.add(inScope("pr/142", 1));
        await store.resolveScope("pr/142", "agent");
        await store.reopen(note.id);

        // Closing is a judgement, so it has to be undoable — that asymmetry is
        // why an agent may close but only a person may delete.
        expect(store.query({ scope: "pr/142" })).toHaveLength(1);
      });

      it("survives the other writer, like every other change", async () => {
        const mine = new AnnotationStore(storePath);
        await mine.load();
        await mine.add(inScope("pr/142", 1));

        const theirs = new AnnotationStore(storePath);
        await theirs.load();

        // Both hold the store in memory; closing must not delete their note.
        const added = await theirs.add(draft({ body: "written by the editor" }));
        await mine.resolveScope("pr/142", "agent");

        await theirs.reload();
        expect(theirs.get(added.id)).toBeDefined();
      });
    });

    it("reads a note saved before scopes existed as belonging to no set", async () => {
      const older = {
        version: 1,
        annotations: [
          {
            id: "written-before-scopes",
            body: "no scope field here",
            anchor: {
              file: "src/a.ts",
              startLine: 1,
              endLine: 1,
              snapshot: "const x = 1;",
              snapshotHash: "0".repeat(64),
            },
            provenance: "human",
            trust: "authoritative",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      };
      await mkdir(dirname(storePath), { recursive: true });
      await writeFile(storePath, JSON.stringify(older), "utf8");

      const store = new AnnotationStore(storePath);
      await store.load();
      expect(store.get("written-before-scopes")?.scope).toBeUndefined();
      // It still answers a file lookup, and belongs to no set.
      expect(store.query({ file: "src/a.ts" })).toHaveLength(1);
      expect(store.query({ scope: "pr/142" })).toHaveLength(0);
    });
  });
});
