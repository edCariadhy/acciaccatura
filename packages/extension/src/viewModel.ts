import { findNoteLines } from "@acciaccatura/core";
import type { Annotation, NoteLines } from "@acciaccatura/core";

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
    label: annotation.body.split("\n")[0] || "Annotation",
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
