import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AnnotationStore } from "../src/store.js";
import type { NewAnnotation } from "../src/types.js";

/**
 * One file per named set, and one file per loose note.
 *
 * A set is the unit you hand over, end, and review, so it is the unit the store
 * is cut along: a pull request's notes travel with the diff as one file, and two
 * pull requests touching different sets do not meet in a merge conflict.
 *
 * A note in no set is the opposite: short-lived by design, so it gets a file of
 * its own under `notes/`, rather than sharing one with every other loose note —
 * see decisions/0003-store-shape.md. `annotations.json` is what every store
 * looked like before either of these existed, so an old store still loads, and
 * whatever it holds moves out to a scope file or a note file the next time
 * anything is written.
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

/** Every file the store has written, relative to `.acciaccatura/`. */
async function filesOnDisk(): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const inner of await readdir(join(root, entry.name))) out.push(`${entry.name}/${inner}`);
    } else {
      out.push(entry.name);
    }
  }
  return out.sort();
}

async function readJson(rel: string): Promise<{ annotations: Array<{ id: string; scope?: string }> }> {
  return JSON.parse(await readFile(join(root, rel), "utf8"));
}

function open(): AnnotationStore {
  return new AnnotationStore(join(root, "annotations.json"));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "acc-shard-"));
  root = join(dir, ".acciaccatura");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("where a note is written", () => {
  it("gives a note in no set a file of its own", async () => {
    const store = open();
    await store.load();
    const note = await store.add(draft());

    expect(await filesOnDisk()).toEqual([`notes/${note.id}.json`]);
  });

  it("gives each named set a file of its own", async () => {
    const store = open();
    await store.load();
    await store.add(draft({ scope: "pr/142" }));
    await store.add(draft({ scope: "onboarding/billing" }));

    // Readable in a diff: a reviewer should see which set changed.
    expect(await filesOnDisk()).toEqual([
      "scopes/onboarding__billing.json",
      "scopes/pr__142.json",
    ]);
  });

  it("does not leave a scoped note in its own note file", async () => {
    const store = open();
    await store.load();
    await store.add(draft({ scope: "pr/142" }));
    const loose = await store.add(draft());

    const alone = await readJson(`notes/${loose.id}.json`);
    expect(alone.annotations).toHaveLength(1);
    expect(alone.annotations[0]?.scope).toBeUndefined();
  });

  it("reads every set back as one store", async () => {
    const first = open();
    await first.load();
    await first.add(draft({ scope: "pr/142" }));
    await first.add(draft({ scope: "onboarding/billing" }));
    await first.add(draft());

    const second = open();
    await second.load();
    expect(second.all()).toHaveLength(3);
    expect(second.scopes().map((s) => s.scope)).toEqual(["onboarding/billing", "pr/142"]);
  });

  it("still answers a file-and-line lookup across separate set files", async () => {
    const store = open();
    await store.load();
    await store.add(draft({ scope: "pr/142" }));
    await store.add(draft({ scope: "onboarding/billing" }));

    // The cost of sharding: this lookup now spans files. It must still work.
    expect(store.query({ file: "src/a.ts", limit: 10 })).toHaveLength(2);
  });
});

describe("moving a note between sets", () => {
  it("moves it between files, keeping its id", async () => {
    const store = open();
    await store.load();
    const note = await store.add(draft({ scope: "pr/142" }));

    await store.update(note.id, { scope: "onboarding/billing" });

    expect((await readJson("scopes/pr__142.json")).annotations).toHaveLength(0);
    const moved = (await readJson("scopes/onboarding__billing.json")).annotations;
    expect(moved).toHaveLength(1);
    expect(moved[0]?.id).toBe(note.id);
  });

  it("moves a note out of every set into a file of its own", async () => {
    const store = open();
    await store.load();
    const note = await store.add(draft({ scope: "pr/142" }));

    await store.update(note.id, { scope: null });

    const alone = await readJson(`notes/${note.id}.json`);
    expect(alone.annotations).toHaveLength(1);
    expect((await readJson("scopes/pr__142.json")).annotations).toHaveLength(0);
  });

  it("survives a move that stopped half way", async () => {
    const store = open();
    await store.load();
    const note = await store.add(draft({ scope: "pr/142" }));
    await store.update(note.id, { scope: "onboarding/billing" });

    // A crash between the two writes leaves the note in both files. There is no
    // atomic rename across two files, so the store has to heal instead: adding
    // comes before removing, which makes the leftover a duplicate rather than a
    // loss, and the newer copy wins on load.
    const stale = await readJson("scopes/onboarding__billing.json");
    await writeFile(
      join(root, "scopes", "pr__142.json"),
      JSON.stringify({ version: 1, annotations: [{ ...stale.annotations[0], scope: "pr/142" }] }),
      "utf8",
    );

    const healed = open();
    await healed.load();
    expect(healed.all()).toHaveLength(1);
    expect(healed.get(note.id)?.scope).toBe("onboarding/billing");
  });
});

describe("two writers, separate sets", () => {
  it("does not let one writer destroy the other's set", async () => {
    const editor = open();
    const server = open();
    await editor.load();
    await server.load();

    await editor.add(draft({ scope: "pr/142", provenance: "human" }));
    await server.add(draft({ scope: "onboarding/billing", provenance: "agent" }));

    const verify = open();
    await verify.load();
    expect(verify.all()).toHaveLength(2);
  });

  it("does not let one writer destroy the other's note in the same set", async () => {
    const editor = open();
    const server = open();
    await editor.load();
    await server.load();

    await editor.add(draft({ scope: "pr/142", body: "from the editor" }));
    await server.add(draft({ scope: "pr/142", body: "from the agent" }));

    const verify = open();
    await verify.load();
    expect(verify.all().map((a) => a.body).sort()).toEqual(["from the agent", "from the editor"]);
  });

  it("closing a set does not disturb another set", async () => {
    const store = open();
    await store.load();
    await store.add(draft({ scope: "pr/142" }));
    await store.add(draft({ scope: "onboarding/billing" }));

    await store.resolveScope("pr/142", "human");

    const verify = open();
    await verify.load();
    expect(verify.query({ scope: "onboarding/billing" })).toHaveLength(1);
    expect(verify.query({ scope: "pr/142" })).toHaveLength(0);
  });
});

describe("older stores and awkward names", () => {
  it("loads a store written before sets had their own files", async () => {
    // The old shape: everything in annotations.json, scoped notes included.
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "annotations.json"),
      JSON.stringify({
        version: 1,
        annotations: [
          {
            id: "written-by-an-older-build",
            body: "in a set, in the old single file",
            anchor: { file: "src/a.ts", startLine: 1, endLine: 1, snapshot: "x", snapshotHash: "0".repeat(64) },
            provenance: "human",
            trust: "authoritative",
            scope: "pr/142",
            order: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );

    const store = open();
    await store.load();
    expect(store.query({ scope: "pr/142" })).toHaveLength(1);
  });

  it("moves an old scoped note into its own file the next time it is written", async () => {
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
            scope: "pr/142",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );

    const store = open();
    await store.load();
    await store.add(draft());

    expect((await readJson("scopes/pr__142.json")).annotations).toHaveLength(1);
    expect((await readJson("annotations.json")).annotations.map((a) => a.id)).not.toContain("old");
  });

  it("keeps a set name that would not be safe as a file name", async () => {
    const store = open();
    await store.load();
    await store.add(draft({ scope: "feature/../etc/passwd" }));

    const files = await filesOnDisk();
    // Nothing may escape .acciaccatura/scopes/, whatever the set is called.
    expect(files.every((f) => f.startsWith("scopes/"))).toBe(true);
    expect(files.some((f) => f.includes(".."))).toBe(false);

    const back = open();
    await back.load();
    expect(back.scopes()[0]?.scope).toBe("feature/../etc/passwd");
  });

  it("refuses to let two different sets share one file", async () => {
    const store = open();
    await store.load();
    await store.add(draft({ scope: "pr/142" }));

    // `pr/142` and `pr__142` both want scopes/pr__142.json. Silently merging
    // two sets would be worse than refusing.
    await expect(store.add(draft({ scope: "pr__142" }))).rejects.toThrow(/name|file|set/i);
  });
});
