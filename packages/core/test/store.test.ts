import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AnnotationStore } from "../src/store.js";
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
});
