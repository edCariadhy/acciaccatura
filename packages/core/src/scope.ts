import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { findNoteLines } from "./anchor.js";
import type { Annotation } from "./types.js";

/**
 * What a set looks like from the outside, without reading any code.
 *
 * This is the cheap half. A workspace may hold many sets, so listing them must
 * stay metadata: counts and dates the store already has in memory. Checking
 * whether a set still describes the code is the expensive half, done one set at
 * a time by {@link reportScope}.
 */
export interface ScopeIndexEntry {
  scope: string;
  /** Notes in the set, finished ones included. */
  notes: number;
  open: number;
  finished: number;
  /** ISO-8601 of the earliest note: a set is as old as its oldest note. */
  openedAt: string;
  /** ISO-8601 of the most recent change to any note in it. */
  lastTouchedAt: string;
}

/**
 * A set's index entry plus how its open notes line up with the code now.
 *
 * Counts, never a score. "2 notes point at code that is gone" is something an
 * agent can act on; a single "staleness: 0.72" would be an authority we made
 * up, and this product's rule is to say what is true and let the reader decide
 * — the same rule drift itself follows.
 */
export interface ScopeReport extends ScopeIndexEntry {
  /** Notes still sitting on the lines they were written against. */
  aligned: number;
  /** Notes whose code was found, but no longer where the note recorded it. */
  drifted: number;
  /** Notes whose code could not be found at all. */
  gone: number;
}

/**
 * Summarise every named set, cheaply. Notes belonging to no set are left out —
 * they are not a set and have no lifetime of their own.
 *
 * Sorted by name so repeated calls read the same way.
 */
export function indexScopes(annotations: readonly Annotation[]): ScopeIndexEntry[] {
  const found = new Map<string, ScopeIndexEntry>();

  for (const note of annotations) {
    const { scope } = note;
    if (scope === undefined) continue;

    const entry = found.get(scope);
    if (!entry) {
      found.set(scope, {
        scope,
        notes: 1,
        open: note.resolvedAt ? 0 : 1,
        finished: note.resolvedAt ? 1 : 0,
        openedAt: note.createdAt,
        lastTouchedAt: note.updatedAt,
      });
      continue;
    }

    entry.notes++;
    if (note.resolvedAt) entry.finished++;
    else entry.open++;
    if (note.createdAt < entry.openedAt) entry.openedAt = note.createdAt;
    if (note.updatedAt > entry.lastTouchedAt) entry.lastTouchedAt = note.updatedAt;
  }

  return [...found.values()].sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0));
}

/**
 * Check one set against the code as it is now, and report the counts.
 *
 * Returns `undefined` for a set that does not exist. That is deliberately not
 * the same answer as a set with nothing wrong: an agent has to be able to tell
 * "no such set" from "a set in good shape".
 *
 * Only open notes are checked. A finished note's code being gone is not a
 * problem to report — the work it described is over, and counting it would push
 * an agent to repair a set that is already done.
 *
 * Each file is read once however many notes point into it, because a curated
 * tour normally revisits the same handful of files.
 */
export async function reportScope(
  scope: string,
  annotations: readonly Annotation[],
  workspaceRoot: string,
): Promise<ScopeReport | undefined> {
  const entry = indexScopes(annotations).find((s) => s.scope === scope);
  if (!entry) return undefined;

  const report: ScopeReport = { ...entry, aligned: 0, drifted: 0, gone: 0 };
  const fileCache = new Map<string, string | undefined>();

  for (const note of annotations) {
    if (note.scope !== scope || note.resolvedAt) continue;

    const path = note.anchor.file;
    if (!fileCache.has(path)) {
      fileCache.set(
        path,
        await readFile(join(workspaceRoot, path), "utf8").catch(() => undefined),
      );
    }

    const where = findNoteLines(note.anchor, fileCache.get(path));
    if (where.state === "same") report.aligned++;
    else if (where.state === "moved") report.drifted++;
    else report.gone++;
  }

  return report;
}
