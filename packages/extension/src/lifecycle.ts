import type { Annotation, AnnotationStore } from "@acciaccatura/core";

/**
 * Dependencies the finish-a-note flows need, injected so they are testable
 * without a running `vscode` host — the same seam pattern as `capture.ts`.
 * `extension.ts` supplies the real editor-backed implementations.
 */
export interface LifecycleDeps {
  /** The shared store (same file the MCP server reads). */
  store: AnnotationStore;
  /** Ask which note to act on; `undefined` means the user backed out. */
  chooseNote: (candidates: readonly Annotation[]) => Promise<Annotation | undefined>;
  /** Ask before deleting notes for good; `false` means stop. */
  confirmDelete: (count: number) => Promise<boolean>;
  /** Surface a message to the user. */
  notify: (level: "info" | "warn", message: string) => void;
}

/**
 * Mark the work a note asked for as finished. `chosen` is the note picked in
 * the sidebar; called from the command palette there is none, so we ask.
 *
 * Every flow here re-reads the store first: an agent may have added, finished,
 * or deleted notes since the sidebar last drew itself.
 */
export async function markNoteDone(
  deps: LifecycleDeps,
  chosen?: Annotation,
): Promise<string | undefined> {
  const note = await pick(deps, chosen, (a) => !a.resolvedAt, "No open notes to mark done.");
  if (!note) return undefined;

  const done = await deps.store.resolve(note.id, "human");
  if (!done) {
    deps.notify("warn", "That note is gone — someone else removed it.");
    return undefined;
  }
  deps.notify("info", `Marked done: ${summarize(done)}`);
  return done.id;
}

/** Put a finished note back in play — the work was not done after all. */
export async function reopenNote(
  deps: LifecycleDeps,
  chosen?: Annotation,
): Promise<string | undefined> {
  const note = await pick(deps, chosen, (a) => Boolean(a.resolvedAt), "No finished notes to reopen.");
  if (!note) return undefined;

  const back = await deps.store.reopen(note.id);
  if (!back) {
    deps.notify("warn", "That note is gone — someone else removed it.");
    return undefined;
  }
  deps.notify("info", `Reopened: ${summarize(back)}`);
  return back.id;
}

/**
 * Delete every finished note, after asking. Nothing sweeps on a timer: throwing
 * away someone's reasoning is a decision a person makes, so this only ever runs
 * from an explicit command with an explicit yes.
 */
export async function clearFinishedNotes(deps: LifecycleDeps): Promise<number> {
  await deps.store.reload();
  // One cutoff for both steps, so the number the user agrees to is the number
  // that goes: anything finished after they were asked survives.
  const cutoff = new Date();
  const finished = deps.store.all().filter((a) => a.resolvedAt && a.resolvedAt <= cutoff.toISOString());
  if (finished.length === 0) {
    deps.notify("info", "No finished notes to delete.");
    return 0;
  }
  if (!(await deps.confirmDelete(finished.length))) return 0;

  const removed = await deps.store.sweepResolved({ resolvedBefore: cutoff });
  deps.notify("info", `Deleted ${removed} finished ${removed === 1 ? "note" : "notes"}.`);
  return removed;
}

/** The note to act on: the one already picked, or one the user chooses. */
async function pick(
  deps: LifecycleDeps,
  chosen: Annotation | undefined,
  wanted: (a: Annotation) => boolean,
  nothingToDo: string,
): Promise<Annotation | undefined> {
  await deps.store.reload();
  if (chosen) return deps.store.get(chosen.id) ?? chosen;

  const candidates = deps.store.all().filter(wanted);
  if (candidates.length === 0) {
    deps.notify("info", nothingToDo);
    return undefined;
  }
  return deps.chooseNote(candidates);
}

/** First line of the note, short enough for a message bar. */
function summarize(a: Annotation): string {
  const firstLine = a.body.split("\n")[0] ?? "";
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}
