import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
});
