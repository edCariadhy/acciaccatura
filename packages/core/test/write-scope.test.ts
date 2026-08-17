import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AnnotationStore } from "../src/store.js";
import type { NewAnnotation } from "../src/types.js";

/**
 * What a write is allowed to touch.
 *
 * Every write used to rewrite every file the list needed, so adding one note to
 * a 2,000-note store wrote 1,281 KB across every file. That is not only waste:
 * it is why two writers on unrelated sets collided every time, because both
 * were rewriting the same bytes. A file whose contents did not change is not
 * written at all now.
 *
 * A rename replaces the inode, so "was this file written" is exactly "did its
 * inode change" — no dependence on clock resolution.
 */

let dir: string;
let storePath: string;

function draft(body: string, scope?: string): NewAnnotation {
  return {
    body,
    provenance: "agent",
    anchor: { file: "src/a.ts", startLine: 1, endLine: 1, snapshot: "const x = 1;" },
    ...(scope === undefined ? {} : { scope }),
  };
}

/** Identity of every file in the store, so a test can say what was rewritten. */
async function inodes(): Promise<Map<string, number>> {
  const root = dirname(storePath);
  const found = new Map<string, number>();
  const { readdir } = await import("node:fs/promises");
  const walk = async (d: string, prefix = ""): Promise<void> => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) await walk(full, `${prefix}${entry.name}/`);
      else if (entry.name.endsWith(".json")) found.set(`${prefix}${entry.name}`, (await stat(full)).ino);
    }
  };
  await walk(root);
  return found;
}

/** Names of the files whose inode changed between two snapshots. */
function rewritten(before: Map<string, number>, after: Map<string, number>): string[] {
  const changed: string[] = [];
  for (const [name, ino] of after) if (before.get(name) !== ino) changed.push(name);
  return changed.sort();
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "acc-write-"));
  storePath = join(dir, ".acciaccatura", "annotations.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("a write only touches what it changes", () => {
  it("leaves other sets alone when a note joins one set", async () => {
    const store = new AnnotationStore(storePath);
    await store.load();
    await store.add(draft("in one", "pr/1"));
    await store.add(draft("in two", "pr/2"));
    await store.add(draft("loose"));

    const before = await inodes();
    await store.add(draft("also in one", "pr/1"));

    // Two writers working on different sets used to collide every time, because
    // each rewrote all of them.
    expect(rewritten(before, await inodes())).toEqual(["scopes/pr__1.json"]);
  });

  it("leaves the sets alone when a loose note is added", async () => {
    const store = new AnnotationStore(storePath);
    await store.load();
    await store.add(draft("in a set", "pr/1"));
    await store.add(draft("loose"));

    const before = await inodes();
    await store.add(draft("another loose"));

    expect(rewritten(before, await inodes())).toEqual(["annotations.json"]);
  });

  it("writes nothing at all when nothing changed", async () => {
    const store = new AnnotationStore(storePath);
    await store.load();
    await store.add(draft("done already", "pr/1"));
    await store.resolveScope("pr/1", "human");

    const before = await inodes();
    // Closing a set with no open notes left changes no note, so it must leave
    // the disk exactly as it found it. Saying "0 finished" is the answer; a
    // rewrite would be a lie about what happened.
    expect(await store.resolveScope("pr/1", "human")).toBe(0);
    expect(rewritten(before, await inodes())).toEqual([]);
  });

  it("touches both files when a note moves between sets, gaining one first", async () => {
    const store = new AnnotationStore(storePath);
    await store.load();
    const note = await store.add(draft("moves", "pr/1"));
    await store.add(draft("stays put", "pr/9"));

    const before = await inodes();
    await store.update(note.id, { scope: "pr/2" });

    // The set it left and the set it joined, and nothing else — pr/9 has no
    // part in this.
    expect(rewritten(before, await inodes())).toEqual(["scopes/pr__1.json", "scopes/pr__2.json"]);
  });

  it("still empties a file when its last note leaves", async () => {
    const store = new AnnotationStore(storePath);
    await store.load();
    const note = await store.add(draft("only one", "pr/1"));
    await store.update(note.id, { scope: null });

    const reopened = new AnnotationStore(storePath);
    await reopened.load();
    // The file stays put, emptied: that is what shows a reviewer the set was
    // cleared rather than never existing.
    expect(reopened.all()).toHaveLength(1);
    expect(reopened.get(note.id)?.scope).toBeUndefined();
  });

  it("rewrites a file when a note in it is edited, not only when one is added", async () => {
    const store = new AnnotationStore(storePath);
    await store.load();
    const note = await store.add(draft("before", "pr/1"));
    await store.add(draft("elsewhere", "pr/2"));

    const before = await inodes();
    await store.update(note.id, { body: "after" });

    expect(rewritten(before, await inodes())).toEqual(["scopes/pr__1.json"]);
  });
});
