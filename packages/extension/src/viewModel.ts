import { ageInDays, bySequence, findNoteLines } from "@acciaccatura/core";
import type {
  AgeBreakdown,
  AgeReport,
  Annotation,
  NoteLines,
  ScopeIndexEntry,
  ScopeReport,
} from "@acciaccatura/core";

/**
 * What the editor shows, decided without the editor.
 *
 * Nothing here imports `vscode`, so every choice a reader actually sees — which
 * label, which icon, what order, which notes appear at all — can be tested
 * without launching one. The `vscode` files above this are then only the parts
 * that build a TreeItem or a decoration from these answers.
 *
 * This mirrors the seam `capture.ts` and `lifecycle.ts` already use.
 */

/** The icons the sidebar draws, by what the reader most needs to know. */
export type NoteIcon = "check" | "warning" | "lightbulb" | "comment";

/** What the sidebar shows for one note. */
export interface NoteView {
  label: string;
  description: string;
  tooltip: string;
  /** What the right-click menu keys off. */
  contextValue: "resolved" | "suggested" | "authoritative";
  icon: NoteIcon;
  /** 1-based lines to open at, or absent when the code cannot be found. */
  reveal?: { startLine: number; endLine: number };
}

const MAX_LABEL_LENGTH = 60;

/**
 * The sidebar row is one fixed-width line — cut a long line down instead of
 * letting it run past the panel or get clipped mid-word by VS Code. The full
 * text is never lost: it is still what the tooltip shows.
 */
function truncateLabel(firstLine: string): string {
  if (firstLine.length <= MAX_LABEL_LENGTH) return firstLine;
  return `${firstLine.slice(0, MAX_LABEL_LENGTH)}…`;
}

/**
 * Decide how one note reads, given where its code sits now.
 *
 * `lines` comes from `findNoteLines`, never from the saved anchor: the anchor
 * says where the note was written, which is not where the code is.
 */
export function noteView(annotation: Annotation, lines: NoteLines): NoteView {
  const finished = Boolean(annotation.resolvedAt);
  const { startLine, endLine } = annotation.anchor;

  let description: string;
  let tooltip: string;
  if (lines.state === "gone") {
    description = "code not found";
    tooltip = `${annotation.body}\n\nWe can't find the code this note was written for. It was on lines ${startLine}–${endLine}.`;
  } else {
    description =
      lines.state === "moved"
        ? `L${lines.startLine}-L${lines.endLine} (moved)`
        : `L${lines.startLine}-L${lines.endLine}`;
    tooltip = annotation.body;
  }

  if (finished) {
    description = `${description} · done`;
    tooltip = `${annotation.body}\n\nDone — marked by the ${annotation.resolvedBy ?? "unknown"} writer.`;
  }

  return {
    label: truncateLabel(annotation.body.split("\n")[0] ?? "") || "Annotation",
    description,
    tooltip,
    contextValue: finished ? "resolved" : annotation.trust === "suggested" ? "suggested" : "authoritative",
    // Finished first: a note whose work is done is not a problem to fix, even
    // when its code has gone.
    icon: finished ? "check" : lines.state === "gone" ? "warning" : annotation.trust === "suggested" ? "lightbulb" : "comment",
    // Nowhere to jump when the code is gone. Opening the saved lines would send
    // the reader to whatever took that place.
    ...(lines.state === "gone" ? {} : { reveal: { startLine: lines.startLine, endLine: lines.endLine } }),
  };
}

/** Every file that has notes, once, in the order the store holds them. */
export function filesWithNotes(annotations: readonly Annotation[]): string[] {
  return [...new Set(annotations.map((a) => a.anchor.file))];
}

/**
 * Notes on one file, still-open ones first. Finished notes stay in the list —
 * the sidebar is where they are reviewed and reopened — but they read last.
 */
export function notesForFile(annotations: readonly Annotation[], file: string): Annotation[] {
  return annotations
    .filter((a) => a.anchor.file === file)
    .sort((a, b) => Number(Boolean(a.resolvedAt)) - Number(Boolean(b.resolvedAt)));
}

/** One thing the gutter draws. */
export type GutterMark =
  | { kind: "note"; startLine: number; endLine: number; hover: string }
  | { kind: "missing"; hover: string };

/**
 * Work out what to draw beside the code in one file.
 *
 * Finished notes are left out: they stay in the sidebar, where they can be
 * reopened, but the code someone is working on stays clear.
 *
 * `fileText` is the buffer as the editor has it, not the file on disk, so notes
 * follow unsaved edits. Nothing is written back — the saved anchor is the
 * capture, and this runs on every keystroke.
 */
export function gutterMarks(
  annotations: readonly Annotation[],
  file: string,
  fileText: string,
): GutterMark[] {
  const marks: GutterMark[] = [];

  for (const annotation of annotations) {
    if (annotation.anchor.file !== file || annotation.resolvedAt) continue;

    const found = findNoteLines(annotation.anchor, fileText);
    if (found.state === "gone") {
      marks.push({
        kind: "missing",
        hover: `**Note with no code:** ${annotation.body}\n\n*We can't find the code this note was written for. Open the Acciaccatura view in the sidebar to move it or delete it.*`,
      });
      continue;
    }

    let hover = `**Acciaccatura (${annotation.trust})**\n\n${annotation.body}`;
    if (found.state === "moved") {
      hover += `\n\n*The code moved here from lines ${annotation.anchor.startLine}–${annotation.anchor.endLine}.*`;
    }
    marks.push({ kind: "note", startLine: found.startLine, endLine: found.endLine, hover });
  }

  return marks;
}

/** The icons a named set can carry, by what most needs attention. */
export type ScopeIcon = "check" | "error" | "warning" | "list-ordered";

/** What the sidebar shows for one named set. */
export interface ScopeView {
  label: string;
  description: string;
  tooltip: string;
  contextValue: "scope";
  icon: ScopeIcon;
}

/**
 * Decide how a named set reads.
 *
 * `report` is absent until someone asks for the set to be checked, because
 * checking reads the code and the sidebar draws far more often than that. When
 * it is absent we say the set has **not been checked**, rather than showing
 * "0 drifted" — claiming everything is fine before looking would be a false
 * answer a reader would act on.
 */
export function scopeView(entry: ScopeIndexEntry, report?: ScopeReport): ScopeView {
  const plural = entry.notes === 1 ? "note" : "notes";
  const done = entry.open === 0 && entry.notes > 0;
  // A check only ever counts OPEN notes, so once a set is finished its last
  // check describes notes nobody is reporting on any more. Keeping those counts
  // on the row would be a stale answer the reader would act on.
  const useReport = report && !done;

  const description = useReport
    ? `${entry.notes} ${plural} · ${report.aligned} aligned, ${report.drifted} drifted, ${report.gone} gone`
    : done
      ? `${entry.notes} ${plural} · ${entry.finished} finished`
      : `${entry.notes} ${plural} · ${entry.open} open`;

  const tooltip = [
    entry.scope,
    `${entry.notes} ${plural}: ${entry.open} open, ${entry.finished} finished`,
    useReport
      ? `Of the open notes: ${report.aligned} aligned, ${report.drifted} drifted, ${report.gone} gone.`
      : done
        ? "Every note in this set is finished. Reopen one to pick the work back up."
        : "Not checked against the code yet. Run “Check Set” to see what still matches.",
    `Opened ${entry.openedAt}`,
  ].join("\n");

  return {
    label: entry.scope,
    description,
    tooltip,
    contextValue: "scope",
    // Done first — a set with no open notes is finished, whatever its code did.
    // Then gone before drifted: a note that cannot be placed at all is worse
    // than one that merely moved.
    icon: done
      ? "check"
      : useReport && report.gone > 0
        ? "error"
        : useReport && report.drifted > 0
          ? "warning"
          : "list-ordered",
  };
}

/**
 * Every note in one named set, in the author's sequence, finished ones
 * included — the sidebar is where a person reviews and reopens them.
 *
 * The order comes from core's own comparator on purpose. A second copy of that
 * rule would drift, and then a tour would read one way for an agent and another
 * way for the person sitting beside it.
 */
export function notesInScope(annotations: readonly Annotation[], scope: string): Annotation[] {
  return annotations.filter((a) => a.scope === scope).sort(bySequence);
}

/**
 * Just the age split, e.g. `2 today, 4 30+ days`, or `""` for nothing to split.
 *
 * Empty buckets are left out. Someone deciding what to delete needs the two or
 * three numbers that are not zero, not a full grid with the zeroes in it.
 */
export function ageSplit(breakdown: AgeBreakdown): string {
  const parts = breakdown.buckets.filter((b) => b.count > 0).map((b) => `${b.count} ${b.label}`);
  // Notes we could not age are said out loud rather than folded into a bucket,
  // or the split would stop adding up to the total without saying why.
  if (breakdown.undated > 0) parts.push(`${breakdown.undated} with no readable date`);
  return parts.join(", ");
}

/**
 * One group as a short phrase, e.g. `6 open (oldest 52 days)`.
 *
 * The full split is deliberately not here. A message bar truncates, and the
 * whole split spelled out ran past the end of the bar with the number that
 * mattered — how much is old — sitting in the part that got cut. The oldest age
 * is the one number worth reading at a glance; the split belongs where there is
 * room for it, which is the confirmation before a delete.
 */
export function describeAgeGroup(breakdown: AgeBreakdown, noun: string, now?: Date): string {
  if (breakdown.total === 0) return `no ${noun} notes`;

  const days = breakdown.oldestAt === undefined ? undefined : ageInDays(breakdown.oldestAt, now);
  const parts: string[] = [];
  if (days !== undefined && days >= 1) parts.push(`oldest ${days} day${days === 1 ? "" : "s"}`);
  // Every note being undated would otherwise read as a workspace with nothing
  // old in it, which is the opposite of what we know.
  if (breakdown.undated > 0) parts.push(`${breakdown.undated} with no date`);

  return parts.length === 0
    ? `${breakdown.total} ${noun}`
    : `${breakdown.total} ${noun} (${parts.join(", ")})`;
}

/**
 * What the workspace is carrying, in one line for a message bar.
 *
 * Deleting finished notes asks for a cutoff and gives nothing to pick it with;
 * this is the half that was missing. Open work and finished work are kept
 * apart, because only the finished half is what a delete would take.
 */
export function describeAges(report: AgeReport, now?: Date): string {
  if (report.open.total === 0 && report.finished.total === 0) return "No notes in this workspace.";
  // Open work first, and no lead-in words. A message bar cuts the end off, and
  // the bar's width is not ours to choose, so the order has to be the defence:
  // whatever gets cut is the least important half. Open notes are what the
  // workspace is still carrying; finished ones are only waiting to be deleted.
  const open = describeAgeGroup(report.open, "open", now);
  const finished = describeAgeGroup(report.finished, "finished", now);
  return `${open}, ${finished}.`;
}
