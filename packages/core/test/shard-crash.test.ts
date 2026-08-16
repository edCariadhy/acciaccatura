import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What a half-finished move leaves behind.
 *
 * Moving a note between sets means writing two files, and nothing is atomic
 * across two files. The order decides which way it breaks:
 *
 * - gaining file first  -> a crash leaves the note in BOTH files. A duplicate,
 *   which the next read heals by keeping the newer copy.
 * - losing file first   -> a crash leaves the note in NEITHER. Nothing can get
 *   it back.
 *
 * Both orders pass every other test in the suite, which is why this one exists:
 * it stops the second write and checks the note is still there.
 */

const crash = { failRenamesAfter: Number.POSITIVE_INFINITY, renames: 0 };

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: actual,
    rename: async (from: string, to: string) => {
      if (crash.renames++ >= crash.failRenamesAfter) {
        throw new Error("simulated crash between the two writes");
      }
      return actual.rename(from, to);
    },
  };
});

const { AnnotationStore } = await import("../src/store.js");

let dir: string;
let root: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "acc-crash-"));
  root = join(dir, ".acciaccatura");
  crash.failRenamesAfter = Number.POSITIVE_INFINITY;
  crash.renames = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Every note id sitting in any file under `.acciaccatura/`. */
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

describe("a move interrupted between its two writes", () => {
  it("leaves the note on disk, never nowhere", async () => {
    const store = new AnnotationStore(join(root, "annotations.json"));
    await store.load();
    const note = await store.add({
      body: "must survive a crash mid-move",
      provenance: "human",
      scope: "pr/142",
      anchor: { file: "src/a.ts", startLine: 1, endLine: 1, snapshot: "const x = 1;" },
    });

    // Let the first write land, then stop the second one.
    crash.renames = 0;
    crash.failRenamesAfter = 1;
    await expect(store.update(note.id, { scope: "onboarding/billing" })).rejects.toThrow(/simulated/);
    crash.failRenamesAfter = Number.POSITIVE_INFINITY;

    // Written in the safe order, the note is now in two files. Written the
    // other way round it would be in none, and this is the assertion that
    // tells those two apart.
    expect(await idsOnDisk()).toContain(note.id);
  });

  it("heals to one note, in the set it was moving to", async () => {
    const store = new AnnotationStore(join(root, "annotations.json"));
    await store.load();
    const note = await store.add({
      body: "must survive a crash mid-move",
      provenance: "human",
      scope: "pr/142",
      anchor: { file: "src/a.ts", startLine: 1, endLine: 1, snapshot: "const x = 1;" },
    });

    crash.renames = 0;
    crash.failRenamesAfter = 1;
    await expect(store.update(note.id, { scope: "onboarding/billing" })).rejects.toThrow(/simulated/);
    crash.failRenamesAfter = Number.POSITIVE_INFINITY;

    const reopened = new AnnotationStore(join(root, "annotations.json"));
    await reopened.load();
    expect(reopened.all()).toHaveLength(1);
    expect(reopened.get(note.id)?.scope).toBe("onboarding/billing");
  });
});
