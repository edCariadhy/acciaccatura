import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What a half-finished loose-to-scope move leaves behind.
 *
 * shard-crash.test.ts proves this ordering for a scope-to-scope move, where
 * both sides are emptied, never deleted. Moving a note OUT of no set is
 * different: the note's own file is not emptied, it is removed — see
 * `#persist` in store.ts. Gaining still has to land before that removal runs,
 * or a crash in between loses the note rather than leaving a harmless
 * duplicate. This file is the same proof for that path, because a mutation
 * that reversed the order here survived every other test in the suite.
 */

const crash = { failDeletesUnder: undefined as string | undefined };

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: actual,
    rm: async (path: string, opts?: unknown) => {
      // Only the note file's own delete is meant to fail — not the lock's
      // release (a different directory) and not a write's own temp-file
      // cleanup (a different suffix) — so real crashes elsewhere in the suite
      // are not disguised as this one.
      if (
        crash.failDeletesUnder !== undefined &&
        typeof path === "string" &&
        path.startsWith(crash.failDeletesUnder) &&
        path.endsWith(".json")
      ) {
        throw new Error("simulated crash before the old file was removed");
      }
      return actual.rm(path, opts as Parameters<typeof actual.rm>[1]);
    },
  };
});

const { AnnotationStore } = await import("../src/store.js");

let dir: string;
let root: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "acc-notes-crash-"));
  root = join(dir, ".acciaccatura");
  crash.failDeletesUnder = undefined;
});

afterEach(async () => {
  crash.failDeletesUnder = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function idsOnDisk(): Promise<string[]> {
  const found: string[] = [];
  const read = async (file: string) => {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as { annotations?: Array<{ id: string }> };
      for (const a of parsed.annotations ?? []) found.push(a.id);
    } catch {
      /* missing file */
    }
  };
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const inner of await readdir(join(root, entry.name))) await read(join(root, entry.name, inner));
    } else {
      await read(join(root, entry.name));
    }
  }
  return found;
}

describe("a note interrupted while moving out of no set", () => {
  it("leaves the note on disk, never nowhere", async () => {
    const store = new AnnotationStore(join(root, "annotations.json"));
    await store.load();
    const note = await store.add({
      body: "must survive a crash mid-move",
      provenance: "human",
      anchor: { file: "src/a.ts", startLine: 1, endLine: 1, snapshot: "const x = 1;" },
    });

    // The note starts loose, in notes/<id>.json. Let the gaining write (the
    // new scope file) land, then stop the delete of the old one.
    crash.failDeletesUnder = join(root, "notes");
    await expect(store.update(note.id, { scope: "pr/142" })).rejects.toThrow(/simulated/);
    crash.failDeletesUnder = undefined;

    // Written in the safe order, the note now sits in both files — a
    // duplicate the next read heals. Written the other way round, the delete
    // would have run before the scope file existed, and the note would be
    // gone from both.
    expect(await idsOnDisk()).toContain(note.id);
  });

  it("heals to one note, in the set it was moving to", async () => {
    const store = new AnnotationStore(join(root, "annotations.json"));
    await store.load();
    const note = await store.add({
      body: "must survive a crash mid-move",
      provenance: "human",
      anchor: { file: "src/a.ts", startLine: 1, endLine: 1, snapshot: "const x = 1;" },
    });

    crash.failDeletesUnder = join(root, "notes");
    await expect(store.update(note.id, { scope: "pr/142" })).rejects.toThrow(/simulated/);
    crash.failDeletesUnder = undefined;

    const reopened = new AnnotationStore(join(root, "annotations.json"));
    await reopened.load();
    expect(reopened.all()).toHaveLength(1);
    expect(reopened.get(note.id)?.scope).toBe("pr/142");
  });
});
