import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

  it("writes newline-terminated pretty JSON", async () => {
    const store = new AnnotationStore(storePath);
    await store.load();
    await store.add(draft());
    const raw = await readFile(storePath, "utf8");
    expect(raw.endsWith("}\n")).toBe(true);
    expect(raw).toContain("\n  ");
  });
});
