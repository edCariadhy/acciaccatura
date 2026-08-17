import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AnnotationStore } from "../src/store.js";
import type { NewAnnotation } from "../src/types.js";

/**
 * One file per loose note — the short-lived half of decisions/0003-store-shape.md.
 *
 * A set stays one readable file, curated and reviewed. A note in no set is the
 * opposite: high-churn and swept, so it gets a file nobody else ever shares —
 * which is what makes two loose notes unable to collide, and what makes a
 * delete `rm` rather than a merge.
 */

let dir: string;
let root: string;

function draft(over: Partial<NewAnnotation> = {}): NewAnnotation {
  return {
    body: "why this exists",
    provenance: "agent",
    anchor: { file: "src/a.ts", startLine: 1, endLine: 1, snapshot: "const x = 1;" },
    ...over,
  };
}

function open(): AnnotationStore {
  return new AnnotationStore(join(root, "annotations.json"));
}

async function noteFiles(): Promise<string[]> {
  try {
    return (await readdir(join(root, "notes"))).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return [];
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "acc-notes-"));
  root = join(dir, ".acciaccatura");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("a loose note's own file", () => {
  it("is named after the note's id", async () => {
    const store = open();
    await store.load();
    const note = await store.add(draft());

    expect(await noteFiles()).toEqual([`${note.id}.json`]);
  });

  it("gives two loose notes two separate files", async () => {
    const store = open();
    await store.load();
    const a = await store.add(draft({ body: "first" }));
    const b = await store.add(draft({ body: "second" }));

    expect(await noteFiles()).toEqual([`${a.id}.json`, `${b.id}.json`].sort());
  });

  it("is deleted, not emptied, once the note is removed", async () => {
    const store = open();
    await store.load();
    const note = await store.add(draft());
    await store.remove(note.id);

    // Not a tombstone: there is nothing left for an empty note file to mean,
    // unlike a scope, which can be "opened and now finished".
    expect(await noteFiles()).toEqual([]);
  });

  it("is deleted, not emptied, once the note moves into a set", async () => {
    const store = open();
    await store.load();
    const note = await store.add(draft());
    await store.update(note.id, { scope: "pr/142" });

    expect(await noteFiles()).toEqual([]);
    const scoped = JSON.parse(await readFile(join(root, "scopes", "pr__142.json"), "utf8"));
    expect(scoped.annotations).toHaveLength(1);
  });

  it("survives finishing the note — resolve is not delete", async () => {
    const store = open();
    await store.load();
    const note = await store.add(draft());
    await store.resolve(note.id, "human");

    // The file is not a tombstone for the note's existence; it holds the note,
    // finished. Sweeping is the only thing that deletes a finished note's file.
    expect(await noteFiles()).toEqual([`${note.id}.json`]);
    const saved = JSON.parse(await readFile(join(root, "notes", `${note.id}.json`), "utf8"));
    expect(saved.annotations[0].resolvedAt).toBeDefined();
  });

  it("is deleted once a finished note is swept", async () => {
    const store = open();
    await store.load();
    const note = await store.add(draft());
    await store.resolve(note.id, "human");
    await store.sweepResolved({ resolvedBefore: new Date() });

    expect(await noteFiles()).toEqual([]);
  });
});

describe("loading an old store", () => {
  it("reads a loose note an older build left in the shared file", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "annotations.json"),
      JSON.stringify({
        version: 1,
        annotations: [
          {
            id: "written-by-an-older-build",
            body: "loose, in the old single file",
            anchor: { file: "src/a.ts", startLine: 1, endLine: 1, snapshot: "x", snapshotHash: "0".repeat(64) },
            provenance: "human",
            trust: "authoritative",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );

    const store = open();
    await store.load();
    expect(store.all()).toHaveLength(1);
    expect(store.get("written-by-an-older-build")?.body).toBe("loose, in the old single file");
  });

  it("moves an old loose note into its own file the next time anything is written", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "annotations.json"),
      JSON.stringify({
        version: 1,
        annotations: [
          {
            id: "old",
            body: "was in the shared file",
            anchor: { file: "src/a.ts", startLine: 1, endLine: 1, snapshot: "x", snapshotHash: "0".repeat(64) },
            provenance: "human",
            trust: "authoritative",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );

    const store = open();
    await store.load();
    await store.add(draft()); // any write is enough to trigger the move

    expect(await noteFiles()).toContain("old.json");
    const shared = JSON.parse(await readFile(join(root, "annotations.json"), "utf8"));
    // Emptied, like a scope file, never deleted: staying put and empty is what
    // shows a reviewer the notes moved rather than vanished.
    expect(shared.annotations).toEqual([]);
  });
});

describe("two writers, two loose notes", () => {
  it("does not let one writer destroy the other's loose note", async () => {
    const editor = open();
    const server = open();
    await editor.load();
    await server.load();

    await editor.add(draft({ body: "from the editor", provenance: "human" }));
    await server.add(draft({ body: "from the agent", provenance: "agent" }));

    const verify = open();
    await verify.load();
    expect(verify.all().map((a) => a.body).sort()).toEqual(["from the agent", "from the editor"]);
  });
});

describe("a move interrupted between its two writes — scope to loose", () => {
  it("leaves the note somewhere, never nowhere", async () => {
    await mkdir(join(root, "src"), { recursive: true });
    const store = open();
    await store.load();
    const note = await store.add(draft({ scope: "pr/142" }));

    // Simulate a crash after the gaining write (the note's own file) landed but
    // before the losing write (emptying the scope file) ran.
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(
      join(root, "notes", `${note.id}.json`),
      JSON.stringify({ version: 1, annotations: [{ ...note, scope: undefined, updatedAt: "2026-06-01T00:00:00.000Z" }] }),
      "utf8",
    );

    const healed = open();
    await healed.load();
    // The newer copy wins — whichever write actually landed last in a real
    // crash — so this only asserts the note itself was not lost.
    expect(healed.all()).toHaveLength(1);
  });
});
