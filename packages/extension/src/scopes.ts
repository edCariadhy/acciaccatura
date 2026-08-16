import { reportScope } from "@acciaccatura/core";
import type { Annotation, AnnotationStore, ScopeIndexEntry, ScopeReport } from "@acciaccatura/core";

/**
 * The set-level flows a person runs from the editor, injected so they are
 * testable without a running `vscode` host — the same seam `capture.ts` and
 * `lifecycle.ts` use.
 *
 * Everything about scopes was agent-only before this: an agent could read a
 * set, check it and close it over MCP, and a person could do none of those,
 * which left "two writers, one store" true for notes but not for sets.
 */
export interface ScopeDeps {
  /** The shared store (same file the MCP server reads). */
  store: AnnotationStore;
  /** Where to read the code from when checking a set. */
  workspaceRoot: string;
  /** Ask which set to act on; `undefined` means the user backed out. */
  chooseScope: (scopes: readonly ScopeIndexEntry[]) => Promise<string | undefined>;
  /** Ask which note to act on; `undefined` means the user backed out. */
  chooseNote: (candidates: readonly Annotation[]) => Promise<Annotation | undefined>;
  /** Ask for a set name, offering the ones that already exist. */
  askScopeName: (existing: readonly string[]) => Promise<string | undefined>;
  /** Ask before finishing a whole set; `false` means stop. */
  confirmClose: (scope: string, count: number) => Promise<boolean>;
  /** Surface a message to the user. */
  notify: (level: "info" | "warn", message: string) => void;
}

/**
 * Finish every open note in one set, for a change that has landed.
 *
 * We ask first. Closing is reversible — `reopen` puts a note back — but a set
 * can hold twenty notes, and a misclick that ends all of them is worth one
 * question. Deleting stays a separate, heavier decision.
 */
export async function closeScope(deps: ScopeDeps, scope?: string): Promise<number> {
  const chosen = await pickScope(deps, scope);
  if (!chosen) return 0;

  const open = deps.store.query({ scope: chosen, limit: Number.MAX_SAFE_INTEGER }).length;
  if (open === 0) {
    deps.notify("info", `Nothing open in ${chosen}.`);
    return 0;
  }
  if (!(await deps.confirmClose(chosen, open))) return 0;

  // "human", not "agent": who ended the work is part of the record.
  const finished = await deps.store.resolveScope(chosen, "human");
  deps.notify("info", `Closed ${chosen}: finished ${finished} ${finished === 1 ? "note" : "notes"}.`);
  return finished;
}

/**
 * Check one set against the code as it is now, and report the counts.
 *
 * Counts, never a score: "2 notes point at code that is gone" is something to
 * act on, where a single number would be an authority we do not have.
 */
export async function checkScope(deps: ScopeDeps, scope?: string): Promise<ScopeReport | undefined> {
  const chosen = await pickScope(deps, scope);
  if (!chosen) return undefined;

  const report = await reportScope(chosen, deps.store.all(), deps.workspaceRoot);
  if (!report) {
    deps.notify("warn", `No set named ${chosen}.`);
    return undefined;
  }

  deps.notify(
    "info",
    `${report.scope}: ${report.aligned} aligned, ${report.drifted} drifted, ${report.gone} gone (of ${report.open} open).`,
  );
  return report;
}

/**
 * Put a note into a named set, so a person can build a walkthrough rather than
 * only read one an agent wrote.
 *
 * The note keeps its id — this is an edit, not a rewrite — and joins at the end
 * of the sequence. Guessing a place inside someone's order would be worse than
 * the end, and moving it is a separate act.
 */
export async function addNoteToScope(
  deps: ScopeDeps,
  chosen?: Annotation,
): Promise<string | undefined> {
  await deps.store.reload();

  const note = chosen ? (deps.store.get(chosen.id) ?? chosen) : await deps.chooseNote(deps.store.all());
  if (!note) return undefined;

  const existing = deps.store.scopes().map((s) => s.scope);
  const scope = await deps.askScopeName(existing);
  if (!scope) return undefined;

  const last = deps.store
    .all()
    .filter((a) => a.scope === scope)
    .reduce((highest, a) => Math.max(highest, a.order ?? 0), 0);

  const moved = await deps.store.update(note.id, { scope, order: last + 1 });
  if (!moved) {
    deps.notify("warn", "That note is gone — someone else removed it.");
    return undefined;
  }
  deps.notify("info", `Added to ${scope} as step ${moved.order}.`);
  return moved.id;
}

/** The set to act on: the one already picked, or one the user chooses. */
async function pickScope(deps: ScopeDeps, scope: string | undefined): Promise<string | undefined> {
  // An agent may have created or emptied a set since the sidebar last drew.
  await deps.store.reload();
  if (scope) return scope;

  const scopes = deps.store.scopes();
  if (scopes.length === 0) {
    deps.notify("info", "No named sets in this workspace.");
    return undefined;
  }
  return deps.chooseScope(scopes);
}
