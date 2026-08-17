import type {
  AgeBreakdown,
  Annotation,
  NoteLines,
  ScopeIndexEntry,
  ScopeReport,
} from "@acciaccatura/core";
import { describe, expect, it } from "vitest";

import {
  ageSplit,
  describeAgeGroup,
  describeAges,
  filesWithNotes,
  gutterMarks,
  noteView,
  notesForFile,
  notesInScope,
  scopeView,
} from "../../src/viewModel.js";

/**
 * What the editor shows, decided without the editor.
 *
 * The sidebar and the gutter were 235 lines of `vscode` calls with the
 * decisions buried inside them, so nothing about what a reader actually sees
 * could be tested. These are those decisions, pulled out: which label, which
 * icon, what order, and which notes appear at all.
 */

const SAME: NoteLines = { state: "same", startLine: 10, endLine: 12 };
const MOVED: NoteLines = { state: "moved", startLine: 40, endLine: 42 };
const GONE: NoteLines = { state: "gone" };

let counter = 0;

function note(over: Partial<Annotation> = {}): Annotation {
  counter++;
  return {
    id: `id-${counter}`,
    body: "why this exists",
    anchor: {
      file: "src/pay.ts",
      startLine: 10,
      endLine: 12,
      snapshot: "  return a * 2;",
      snapshotHash: "0".repeat(64),
    },
    provenance: "human",
    trust: "authoritative",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("how one note reads in the sidebar", () => {
  it("labels the note with its first line, so a long note still fits", () => {
    const view = noteView(note({ body: "the short point\nand the long reasoning after it" }), SAME);
    expect(view.label).toBe("the short point");
  });

  it("falls back to a name rather than showing an empty row", () => {
    expect(noteView(note({ body: "" }), SAME).label).toBe("Annotation");
  });

  it("truncates a long line, not just a long note, so one paragraph without a break still fits", () => {
    const oneLongLine = "why this exists: " + "reasoning ".repeat(20); // no "\n" at all
    const view = noteView(note({ body: oneLongLine }), SAME);
    expect(view.label.length).toBeLessThanOrEqual(61); // 60 chars + the ellipsis
    expect(view.label.endsWith("…")).toBe(true);
    // The reader isn't left guessing what was cut — the tooltip still has it all.
    expect(view.tooltip).toBe(oneLongLine);
  });

  it("shows where the code is now", () => {
    expect(noteView(note(), SAME).description).toBe("L10-L12");
  });

  it("says a note moved, so the saved lines are not mistaken for the current ones", () => {
    expect(noteView(note(), MOVED).description).toBe("L40-L42 (moved)");
  });

  it("says the code is missing rather than pointing at a line that is now something else", () => {
    const view = noteView(note(), GONE);
    expect(view.description).toBe("code not found");
    expect(view.tooltip).toMatch(/can't find the code/i);
    // The tooltip has to name the lines it was written for, or there is nothing
    // to go on when looking for where the code went.
    expect(view.tooltip).toMatch(/10.*12/);
  });

  it("marks a finished note as done without hiding where it sits", () => {
    const view = noteView(note({ resolvedAt: "2026-02-01T00:00:00.000Z", resolvedBy: "agent" }), SAME);
    expect(view.description).toBe("L10-L12 · done");
    // Who finished it matters: an agent closing a person's note is worth seeing.
    expect(view.tooltip).toMatch(/agent/);
  });

  it("gives the menus something to key off, per kind of note", () => {
    expect(noteView(note({ trust: "suggested" }), SAME).contextValue).toBe("suggested");
    expect(noteView(note({ trust: "authoritative" }), SAME).contextValue).toBe("authoritative");
    expect(noteView(note({ resolvedAt: "2026-02-01T00:00:00.000Z" }), SAME).contextValue).toBe("resolved");
  });

  it("picks the icon by what the reader most needs to know", () => {
    expect(noteView(note(), SAME).icon).toBe("comment");
    expect(noteView(note({ trust: "suggested" }), SAME).icon).toBe("lightbulb");
    expect(noteView(note(), GONE).icon).toBe("warning");
    // Finished wins over missing: a note whose work is done is not a problem to
    // fix, even when its code has gone.
    expect(noteView(note({ resolvedAt: "2026-02-01T00:00:00.000Z" }), GONE).icon).toBe("check");
  });

  it("opens the file at where the code is now, not where it was written", () => {
    expect(noteView(note(), MOVED).reveal).toEqual({ startLine: 40, endLine: 42 });
  });

  it("offers nowhere to jump when the code is gone", () => {
    // Revealing the saved lines would send the reader to whatever took that
    // place, which is the silent wrong answer this product exists to avoid.
    expect(noteView(note(), GONE).reveal).toBeUndefined();
  });
});

describe("how the sidebar is grouped", () => {
  it("lists each file that has notes, once", () => {
    const notes = [
      note({ anchor: { ...note().anchor, file: "src/a.ts" } }),
      note({ anchor: { ...note().anchor, file: "src/b.ts" } }),
      note({ anchor: { ...note().anchor, file: "src/a.ts" } }),
    ];
    expect(filesWithNotes(notes)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("has no files to show when there are no notes", () => {
    expect(filesWithNotes([])).toEqual([]);
  });

  it("puts the notes still open before the finished ones", () => {
    const done = note({ body: "done", resolvedAt: "2026-02-01T00:00:00.000Z" });
    const open = note({ body: "open" });
    const forFile = notesForFile([done, open], "src/pay.ts");
    expect(forFile.map((a) => a.body)).toEqual(["open", "done"]);
  });

  it("keeps finished notes in the list, because they can still be reopened", () => {
    const done = note({ resolvedAt: "2026-02-01T00:00:00.000Z" });
    expect(notesForFile([done], "src/pay.ts")).toHaveLength(1);
  });

  it("does not mix in notes from another file", () => {
    const other = note({ anchor: { ...note().anchor, file: "src/other.ts" } });
    expect(notesForFile([note(), other], "src/pay.ts")).toHaveLength(1);
  });
});

describe("what the gutter draws", () => {
  const TEXT = "line one\nline two\n  return a * 2;\nline four\n";

  it("marks the note where its code sits now", () => {
    const marks = gutterMarks([note({ anchor: { ...note().anchor, startLine: 3, endLine: 3 } })], "src/pay.ts", TEXT);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ kind: "note", startLine: 3, endLine: 3 });
  });

  it("keeps a finished note out of the gutter, so the code stays clear", () => {
    const done = note({
      anchor: { ...note().anchor, startLine: 3, endLine: 3 },
      resolvedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(gutterMarks([done], "src/pay.ts", TEXT)).toEqual([]);
  });

  it("ignores notes belonging to another file", () => {
    const other = note({ anchor: { ...note().anchor, file: "src/other.ts", startLine: 3, endLine: 3 } });
    expect(gutterMarks([other], "src/pay.ts", TEXT)).toEqual([]);
  });

  it("warns in the open when a note's code cannot be found", () => {
    const lost = note({ anchor: { ...note().anchor, snapshot: "nothing like this", startLine: 3, endLine: 3 } });
    const marks = gutterMarks([lost], "src/pay.ts", "a\nb\nc\n");
    expect(marks).toHaveLength(1);
    expect(marks[0]?.kind).toBe("missing");
  });

  it("says in the hover when the code moved, and where from", () => {
    // Written against line 3; the code now sits further down.
    const moved = note({ anchor: { ...note().anchor, startLine: 3, endLine: 3 } });
    const shifted = "new\nnew\nnew\nnew\n  return a * 2;\n";
    const marks = gutterMarks([moved], "src/pay.ts", shifted);
    expect(marks[0]).toMatchObject({ kind: "note", startLine: 5, endLine: 5 });
    expect(marks[0]?.hover).toMatch(/moved/i);
    expect(marks[0]?.hover).toMatch(/3/);
  });

  it("puts how far to trust a note in the hover", () => {
    const marks = gutterMarks(
      [note({ trust: "suggested", anchor: { ...note().anchor, startLine: 3, endLine: 3 } })],
      "src/pay.ts",
      TEXT,
    );
    expect(marks[0]?.hover).toMatch(/suggested/);
  });
});

function entry(over: Partial<ScopeIndexEntry> = {}): ScopeIndexEntry {
  return {
    scope: "pr/142",
    notes: 3,
    open: 3,
    finished: 0,
    openedAt: "2026-01-01T00:00:00.000Z",
    lastTouchedAt: "2026-01-02T00:00:00.000Z",
    ...over,
  };
}

function report(over: Partial<ScopeReport> = {}): ScopeReport {
  return { ...entry(), aligned: 3, drifted: 0, gone: 0, ...over };
}

describe("how a named set reads in the sidebar", () => {
  it("names the set and says how much is left in it", () => {
    const view = scopeView(entry({ notes: 3, open: 2, finished: 1 }));
    expect(view.label).toBe("pr/142");
    expect(view.description).toMatch(/3/);
    expect(view.description).toMatch(/2 open/);
  });

  it("shows counts, never a single verdict, once the code has been checked", () => {
    const view = scopeView(entry(), report({ aligned: 1, drifted: 1, gone: 1 }));
    expect(view.description).toMatch(/1 aligned/);
    expect(view.description).toMatch(/1 drifted/);
    expect(view.description).toMatch(/1 gone/);
    // A made-up score would be an authority we do not have.
    expect(view.description).not.toMatch(/%|score/i);
  });

  it("says the set has not been checked yet rather than implying it is fine", () => {
    // Checking reads code, so it does not happen just because the tree drew.
    // Claiming "0 drifted" before looking would be a lie the reader would act on.
    const view = scopeView(entry());
    expect(view.description).not.toMatch(/aligned|drifted|gone/);
    expect(view.tooltip).toMatch(/not checked/i);
  });

  it("marks a set whose work is all finished", () => {
    expect(scopeView(entry({ open: 0, finished: 3 })).icon).toBe("check");
  });

  it("warns when notes in the set point at code that moved", () => {
    expect(scopeView(entry(), report({ aligned: 2, drifted: 1, gone: 0 })).icon).toBe("warning");
  });

  it("raises an error icon when notes point at code that is gone", () => {
    // Gone outranks drifted: a note that cannot be placed at all is worse than
    // one that merely moved.
    expect(scopeView(entry(), report({ aligned: 1, drifted: 1, gone: 1 })).icon).toBe("error");
  });

  it("looks ordinary when the set is open and nothing is wrong", () => {
    expect(scopeView(entry(), report()).icon).toBe("list-ordered");
    expect(scopeView(entry()).icon).toBe("list-ordered");
  });

  it("says when the set was opened, so its age can be judged", () => {
    expect(scopeView(entry()).tooltip).toMatch(/2026-01-01/);
  });

  it("gives the menus something to key off", () => {
    expect(scopeView(entry()).contextValue).toBe("scope");
  });
});

describe("reading a set in the sidebar", () => {
  function inSet(scope: string | undefined, order: number | undefined, body: string): Annotation {
    return note({ scope, order, body });
  }

  it("reads the set in the order its author chose", () => {
    const notes = [inSet("pr/142", 3, "third"), inSet("pr/142", 1, "first"), inSet("pr/142", 2, "second")];
    expect(notesInScope(notes, "pr/142").map((a) => a.body)).toEqual(["first", "second", "third"]);
  });

  it("puts notes with no place after the ordered ones", () => {
    const notes = [inSet("pr/142", undefined, "unplaced"), inSet("pr/142", 1, "first")];
    expect(notesInScope(notes, "pr/142").map((a) => a.body)).toEqual(["first", "unplaced"]);
  });

  it("leaves out notes from another set, and notes in none", () => {
    const notes = [inSet("pr/142", 1, "mine"), inSet("other", 1, "theirs"), inSet(undefined, undefined, "loose")];
    expect(notesInScope(notes, "pr/142").map((a) => a.body)).toEqual(["mine"]);
  });

  it("keeps finished notes in the set, because a person may still reopen them", () => {
    const done = note({ scope: "pr/142", order: 1, resolvedAt: "2026-02-01T00:00:00.000Z" });
    expect(notesInScope([done], "pr/142")).toHaveLength(1);
  });
});

describe("a check that no longer describes the set", () => {
  it("stops showing drift counts once every note is finished", () => {
    // reportScope only counts OPEN notes, so once a set is closed its last
    // check describes notes that are no longer being reported on. Showing
    // "1 gone" for a finished set would be a stale answer a reader acts on.
    const view = scopeView(entry({ open: 0, finished: 3 }), report({ aligned: 2, drifted: 0, gone: 1 }));
    expect(view.description).not.toMatch(/aligned|drifted|gone/);
    expect(view.description).toMatch(/3 finished|all done/i);
  });

  it("still marks that set as done", () => {
    expect(scopeView(entry({ open: 0, finished: 3 }), report({ gone: 1 })).icon).toBe("check");
  });
});

describe("age, said in one line", () => {
  const NOW = new Date("2026-08-16T12:00:00.000Z");
  const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

  /** A breakdown of `total` notes whose earliest is `oldestAt`. */
  function aged(total: number, oldestAt: string): AgeBreakdown {
    return { ...breakdown([total]), total, oldestAt };
  }

  /** A breakdown with the given counts, in bucket order. */
  function breakdown(counts: number[], undated = 0): AgeBreakdown {
    const labels = ["today", "1-6 days", "7-29 days", "30+ days"];
    const buckets = labels.map((label, i) => ({
      fromDays: i,
      label,
      count: counts[i] ?? 0,
    }));
    const total = counts.reduce((a, b) => a + b, 0) + undated;
    return { total, buckets, undated };
  }

  it("leaves out the buckets that are empty", () => {
    // A reader deciding what to delete needs the numbers that are not zero.
    // "2 today, 0 1-6 days, 0 7-29 days, 4 30+ days" buries them.
    expect(ageSplit(breakdown([2, 0, 0, 4]))).toBe("2 today, 4 30+ days");
  });

  it("keeps the buckets in oldest-last order, so the split reads as a scale", () => {
    expect(ageSplit(breakdown([1, 1, 1, 1]))).toBe("1 today, 1 1-6 days, 1 7-29 days, 1 30+ days");
  });

  it("says out loud when a date could not be read", () => {
    // Silently dropping it would leave a split that does not add up to the
    // total, with nothing to say why.
    expect(ageSplit(breakdown([1], 2))).toBe("1 today, 2 with no readable date");
  });

  it("gives the oldest age, not the whole split", () => {
    // Spelled out in full this ran to 125 characters and the message bar cut it
    // — with "1 30+ days", the number that mattered, in the part that got cut.
    const line = describeAges(
      { open: aged(6, daysAgo(52)), finished: aged(2, daysAgo(41)) },
      NOW,
    );
    expect(line).toMatch(/6 open \(oldest 52 days\)/);
    expect(line).toMatch(/2 finished \(oldest 41 days\)/);
    expect(line).not.toMatch(/30\+ days/);
  });

  it("puts open work first, so a cut-off line loses the least important half", () => {
    // The message bar truncates and its width is not ours to pick, so the order
    // is the defence. Open notes are what the workspace is still carrying;
    // finished ones are only waiting to be deleted.
    const line = describeAges(
      { open: aged(6, daysAgo(52)), finished: aged(2, daysAgo(41)) },
      NOW,
    );
    expect(line.indexOf("open")).toBeLessThan(line.indexOf("finished"));
    // And no lead-in word before it, which would cost the same room for nothing.
    expect(line.startsWith("6 open")).toBe(true);
  });

  it("says nothing about age when nothing is older than a day", () => {
    // "oldest 0 days" is a word count, not information.
    const line = describeAges({ open: aged(3, daysAgo(0)), finished: breakdown([]) }, NOW);
    expect(line).toMatch(/^3 open,/);
    expect(line).not.toMatch(/oldest/);
  });

  it("counts one day as a day, not as days", () => {
    expect(describeAgeGroup(aged(1, daysAgo(1)), "open", NOW)).toBe("1 open (oldest 1 day)");
  });

  it("names the empty half instead of showing it as a zero", () => {
    const line = describeAges({ open: aged(3, daysAgo(2)), finished: breakdown([]) }, NOW);
    expect(line).toMatch(/3 open/);
    expect(line).toMatch(/no finished notes/);
    expect(line).not.toMatch(/0 finished/);
  });

  it("still reports notes it could not age, which have no oldest date at all", () => {
    // Otherwise a workspace of nothing but unreadable dates reads as a
    // workspace with nothing old in it.
    expect(describeAgeGroup(breakdown([], 2), "open", NOW)).toBe("2 open (2 with no date)");
  });

  it("says nothing is being carried when nothing is", () => {
    expect(describeAges({ open: breakdown([]), finished: breakdown([]) }, NOW)).toBe(
      "No notes in this workspace.",
    );
  });
});
