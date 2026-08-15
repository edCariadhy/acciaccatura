import type { NewAnnotation, Provenance, TrustLevel } from "./types.js";

/** A code selection captured at annotation time. */
export interface CapturedSelection {
  /** Workspace-relative POSIX path, e.g. `src/store.ts`. */
  file: string;
  /** 1-based inclusive first line. */
  startLine: number;
  /** 1-based inclusive last line. */
  endLine: number;
  /** Exact text of the selected lines. */
  snapshot: string;
}

export interface DraftInput {
  selection: CapturedSelection;
  body: string;
  /** Defaults to "human" — this helper is what the editor extension calls. */
  provenance?: Provenance;
  trust?: TrustLevel;
  author?: string;
}

export class EmptyAnnotationBodyError extends Error {
  constructor() {
    super("Annotation body must not be empty.");
    this.name = "EmptyAnnotationBodyError";
  }
}

/**
 * Pure mapping from a captured selection + note text to a {@link NewAnnotation}.
 * Deliberately free of `vscode` and `fs`: this is the seam the extension's
 * command wraps, so the write path is unit-testable without an editor host.
 * The store still derives id/hash/timestamps on {@link AnnotationStore.add}.
 */
export function annotationFromSelection(input: DraftInput): NewAnnotation {
  const body = input.body.trim();
  if (body.length === 0) throw new EmptyAnnotationBodyError();

  const { selection } = input;
  if (
    !Number.isInteger(selection.startLine) ||
    !Number.isInteger(selection.endLine) ||
    selection.startLine < 1 ||
    selection.endLine < selection.startLine
  ) {
    throw new RangeError(
      `Invalid selection range ${selection.startLine}-${selection.endLine}`,
    );
  }

  return {
    body,
    anchor: {
      file: selection.file,
      startLine: selection.startLine,
      endLine: selection.endLine,
      snapshot: selection.snapshot,
    },
    provenance: input.provenance ?? "human",
    trust: input.trust,
    author: input.author,
  };
}
