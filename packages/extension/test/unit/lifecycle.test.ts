import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AnnotationStore } from "@acciaccatura/core";
import type { Annotation, NewAnnotation } from "@acciaccatura/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearFinishedNotes,
  markNoteDone,
  reopenNote,
  showNoteAges,
} from "../../src/lifecycle.js";

function draft(body: string): NewAnnotation {
  return {
    body,
    provenance: "human",
    anchor: { file: "src/math.ts", startLine: 1, endLine: 2, snapshot: "export function add(a, b) {" },
  };
}

let dir: string;
let store: AnnotationStore;

/** Deps with a picker that never gets a choice, unless a test overrides it. */
function deps(over: Partial<Parameters<typeof markNoteDone>[0]> = {}) {
  return {
    store,
    chooseNote: vi.fn(async (candidates: readonly Annotation[]) => candidates[0]),
    confirmDelete: vi.fn(async () => true),
    notify: vi.fn(),
    ...over,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "acc-life-"));
  store = new AnnotationStore(join(dir, ".acciaccatura", "annotations.json"));
  await store.load();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("markNoteDone", () => {
  it("finishes the note the sidebar picked", async () => {
    const note = await store.add(draft("swap this for the shared helper"));
    const d = deps();

    const id = await markNoteDone(d, note);

    expect(id).toBe(note.id);
    expect(store.get(note.id)?.resolvedAt).toBeDefined();
    expect(store.get(note.id)?.resolvedBy).toBe("human");
    expect(d.chooseNote).not.toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledWith("info", expect.stringContaining("shared helper"));
  });

  it("asks which note when the command came from the palette", async () => {
    await store.add(draft("first"));
    const second = await store.add(draft("second"));
    const d = deps({ chooseNote: vi.fn(async () => second) });

    const id = await markNoteDone(d);

    expect(id).toBe(second.id);
    expect(d.chooseNote).toHaveBeenCalledOnce();
  });

  it("offers only notes that are still open", async () => {
    const open = await store.add(draft("still open"));
    const done = await store.add(draft("already handled"));
    await store.resolve(done.id, "agent");
    const d = deps();

    await markNoteDone(d);

    const offered = d.chooseNote.mock.calls[0]![0] as readonly Annotation[];
    expect(offered.map((a) => a.id)).toEqual([open.id]);
  });

  it("says there is nothing to do rather than showing an empty list", async () => {
    const d = deps();

    const id = await markNoteDone(d);

    expect(id).toBeUndefined();
    expect(d.chooseNote).not.toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledWith("info", expect.stringMatching(/no open notes/i));
  });

  it("writes nothing when the user backs out of the list", async () => {
    const note = await store.add(draft("leave me open"));
    const d = deps({ chooseNote: vi.fn(async () => undefined) });

    expect(await markNoteDone(d)).toBeUndefined();
    expect(store.get(note.id)?.resolvedAt).toBeUndefined();
  });

  it("degrades in the open when the other writer deleted the note first", async () => {
    const note = await store.add(draft("about to vanish"));
    // The sidebar still holds the note; an agent has since removed it.
    const agent = new AnnotationStore(join(dir, ".acciaccatura", "annotations.json"));
    await agent.load();
    await agent.remove(note.id);
    const d = deps();

    const id = await markNoteDone(d, note);

    expect(id).toBeUndefined();
    expect(d.notify).toHaveBeenCalledWith("warn", expect.stringMatching(/gone/i));
  });
});

describe("reopenNote", () => {
  it("puts a finished note back in play", async () => {
    const note = await store.add(draft("closed too early"));
    await store.resolve(note.id, "agent");
    const d = deps();

    const id = await reopenNote(d, note);

    expect(id).toBe(note.id);
    expect(store.get(note.id)?.resolvedAt).toBeUndefined();
  });

  it("offers only finished notes", async () => {
    await store.add(draft("still open"));
    const done = await store.add(draft("finished"));
    await store.resolve(done.id, "human");
    const d = deps();

    await reopenNote(d);

    const offered = d.chooseNote.mock.calls[0]![0] as readonly Annotation[];
    expect(offered.map((a) => a.id)).toEqual([done.id]);
  });
});

describe("clearFinishedNotes", () => {
  it("deletes finished notes once the user says yes", async () => {
    const open = await store.add(draft("still open"));
    const done = await store.add(draft("finished"));
    await store.resolve(done.id, "human");
    const d = deps();

    const removed = await clearFinishedNotes(d);

    expect(removed).toBe(1);
    expect(d.confirmDelete).toHaveBeenCalledWith(
      expect.stringContaining("Delete 1 finished note?"),
    );
    expect(store.get(open.id)).toBeDefined();
    expect(store.get(done.id)).toBeUndefined();
  });

  it("says how old the notes are, so the count is not the only thing on offer", async () => {
    const done = await store.add(draft("finished"));
    await store.resolve(done.id, "human");
    const d = deps();

    await clearFinishedNotes(d);

    // A count alone cannot tell "finished this morning" from "finished in June",
    // and this is the one flow that cannot be undone.
    const question = vi.mocked(d.confirmDelete).mock.calls[0]?.[0] ?? "";
    expect(question).toMatch(/1 today/);
    expect(question).toMatch(/cannot be undone/);
  });

  it("deletes nothing when the user says no", async () => {
    const done = await store.add(draft("finished"));
    await store.resolve(done.id, "human");
    const d = deps({ confirmDelete: vi.fn(async () => false) });

    expect(await clearFinishedNotes(d)).toBe(0);
    expect(store.get(done.id)).toBeDefined();
  });

  it("does not ask at all when there is nothing finished", async () => {
    await store.add(draft("still open"));
    const d = deps();

    expect(await clearFinishedNotes(d)).toBe(0);
    expect(d.confirmDelete).not.toHaveBeenCalled();
  });
});

describe("showNoteAges", () => {
  it("counts open and finished notes apart", async () => {
    await store.add(draft("still open"));
    await store.add(draft("also open"));
    const done = await store.add(draft("finished"));
    await store.resolve(done.id, "human");
    const d = deps();

    const summary = await showNoteAges(d);

    // Only the finished half is what a delete would take, so the two counts
    // must never be run together.
    expect(summary).toMatch(/2 open/);
    expect(summary).toMatch(/1 finished/);
    expect(d.notify).toHaveBeenCalledWith("info", summary);
  });

  it("says so plainly when there is nothing to carry", async () => {
    expect(await showNoteAges(deps())).toBe("No notes in this workspace.");
  });

  it("writes nothing to the store", async () => {
    const note = await store.add(draft("still open"));
    const before = store.get(note.id)?.updatedAt;

    await showNoteAges(deps());

    // Reporting is a read. A report that touched timestamps would age the very
    // notes it was asked to describe.
    expect(store.get(note.id)?.updatedAt).toBe(before);
  });

  it("picks up a note an agent wrote since the sidebar last drew", async () => {
    const other = new AnnotationStore(join(dir, ".acciaccatura", "annotations.json"));
    await other.load();
    await other.add(draft("written by someone else"));

    expect(await showNoteAges(deps())).toMatch(/1 open/);
  });
});
