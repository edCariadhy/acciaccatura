import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { fingerprint, normalizeSnapshot } from "./anchor.js";
import type { Anchor, Annotation, NewAnnotation, Provenance, TrustLevel } from "./types.js";

/**
 * Default query bound. Context is the scarce resource: every annotation handed
 * back enters an agent's context window and is re-paid on every later turn, so
 * lookups return "the few that matter", never a full dump.
 */
export const DEFAULT_LIMIT = 3;

/**
 * Default bound for a read of one named set. Higher than {@link DEFAULT_LIMIT}
 * on purpose: the notes on a file are an incidental pile, so three is the right
 * answer there, but a set is something an author sat down and built, and its
 * size is their decision. A twelve-note tour cut to three is not a tour.
 *
 * Still bounded, though. "Read the whole set" is not a path we offer, because a
 * set someone let grow to five hundred would flood a context window just as
 * surely.
 */
export const DEFAULT_SCOPE_LIMIT = 20;

interface StoreFile {
  version: 1;
  annotations: Annotation[];
}

/**
 * What to look up. At least one of `file` or `scope` is required — see
 * {@link AnnotationStore.query} for why there is no "everything" path.
 */
export interface QueryOptions {
  /** Workspace-relative POSIX path to look up. */
  file?: string;
  /**
   * Named set to read, in its own sequence. Combine with `file` to narrow a set
   * to one file. See {@link Annotation.scope}.
   */
  scope?: string;
  /** Optional 1-based line to focus ranking around. Ignored for a set read. */
  line?: number;
  /**
   * Max results; defaults to {@link DEFAULT_LIMIT} for a file, and to
   * {@link DEFAULT_SCOPE_LIMIT} when a `scope` is named.
   */
  limit?: number;
  /**
   * Include notes whose work is finished. Off by default: a finished note has
   * nothing left to tell an agent, and every note returned costs context on
   * every later turn. Turn it on for review UIs and history.
   */
  includeResolved?: boolean;
}

/** How far back {@link AnnotationStore.sweepResolved} clears finished notes. */
export interface SweepOptions {
  /**
   * Delete notes finished at or before this moment. The boundary includes the
   * moment itself, so "everything finished so far" is `new Date()` and does not
   * quietly spare a note finished in the same millisecond.
   */
  resolvedBefore: Date;
}

/**
 * What an existing annotation may change. `id`, `createdAt`, and `provenance`
 * are deliberately absent: identity survives an edit, and who wrote a note is
 * not editable after the fact.
 */
export interface AnnotationUpdate {
  body?: string;
  /** Replacement anchor; `snapshotHash` is re-derived, as on {@link AnnotationStore.add}. */
  anchor?: Omit<Anchor, "snapshotHash">;
  trust?: TrustLevel;
  author?: string;
}

/**
 * The single local annotation store, backed by a JSON file.
 * Both writers — the editor extension and the MCP server — go through this
 * class, which is why provenance lives on every record.
 *
 * Nothing here reaches the network: annotations may carry proprietary
 * reasoning and stay on the machine unless a user explicitly exports them.
 */
export class AnnotationStore {
  readonly #path: string;
  #data: StoreFile = { version: 1, annotations: [] };
  #loaded = false;
  /** Serialises this instance's writes; see {@link AnnotationStore.mutate}. */
  #writes: Promise<unknown> = Promise.resolve();
  #tempCounter = 0;

  constructor(path: string) {
    this.#path = path;
  }

  /** Load from disk. A missing file is an empty store, not an error. */
  async load(): Promise<void> {
    await this.#readFromDisk();
    this.#loaded = true;
  }

  /**
   * Re-read the file, picking up anything the other writer has done since.
   * Readers that stay alive across writes — the MCP server between tool calls,
   * the editor between renders — need this, because the in-memory copy is a
   * snapshot from whenever it was last read, not a live view.
   *
   * This queues behind writes from this instance for the same reason they queue
   * behind each other: a read that lands in the middle of a write replaces the
   * list that write is about to save, and the change is lost. Two MCP tool
   * calls arriving together did exactly that.
   */
  async reload(): Promise<void> {
    this.#ensureLoaded();
    const run = this.#writes.then(() => this.#readFromDisk());
    this.#writes = run.catch(() => undefined);
    await run;
  }

  async add(input: NewAnnotation): Promise<Annotation> {
    const now = new Date().toISOString();
    const annotation: Annotation = {
      id: randomUUID(),
      body: input.body,
      anchor: sealAnchor(input.anchor),
      provenance: input.provenance,
      // Human notes are authoritative by default; agent notes are suggestions
      // until a human confirms them.
      trust: input.trust ?? (input.provenance === "human" ? "authoritative" : "suggested"),
      author: input.author,
      scope: input.scope,
      order: input.order,
      createdAt: now,
      updatedAt: now,
    };
    await this.#mutate((annotations) => {
      annotations.push(annotation);
    });
    return annotation;
  }

  /**
   * Edit an annotation in place, keeping its id. Re-anchoring goes through
   * here rather than remove + add: ids are handed out (MCP results, tree-view
   * selections, anything an agent cached), so healing an anchor must not
   * quietly reissue the annotation under a new identity.
   *
   * Returns the updated record, or `undefined` when no annotation has that id
   * — the caller decides how to degrade; we never resurrect a deleted note.
   */
  async update(id: string, changes: AnnotationUpdate): Promise<Annotation | undefined> {
    return this.#mutate((annotations) => {
      // Resolved against the freshly-read list: another writer may have moved,
      // changed, or deleted this record since we last looked.
      const index = annotations.findIndex((a) => a.id === id);
      if (index === -1) return undefined;

      const existing = annotations[index]!;
      const updated: Annotation = {
        ...existing,
        body: changes.body ?? existing.body,
        anchor: changes.anchor ? sealAnchor(changes.anchor) : existing.anchor,
        trust: changes.trust ?? existing.trust,
        author: changes.author ?? existing.author,
        updatedAt: new Date().toISOString(),
      };
      annotations[index] = updated;
      return updated;
    });
  }

  /**
   * Mark the work this note was about as finished. The note stays on disk and
   * keeps its id, but drops out of {@link AnnotationStore.query}, so it stops
   * costing an agent context on every later turn.
   *
   * Both writers can decide the work is done, so this is deliberately not an
   * overwrite: the first answer stands and a second call changes nothing. Use
   * {@link AnnotationStore.reopen} to undo it, and
   * {@link AnnotationStore.sweepResolved} to clear finished notes for good.
   */
  async resolve(id: string, by: Provenance): Promise<Annotation | undefined> {
    return this.#mutate((annotations) => {
      const index = annotations.findIndex((a) => a.id === id);
      if (index === -1) return undefined;

      const existing = annotations[index]!;
      if (existing.resolvedAt) return existing;

      const now = new Date().toISOString();
      const updated: Annotation = { ...existing, resolvedAt: now, resolvedBy: by, updatedAt: now };
      annotations[index] = updated;
      return updated;
    });
  }

  /** Put a finished note back in play — the work was not done after all. */
  async reopen(id: string): Promise<Annotation | undefined> {
    return this.#mutate((annotations) => {
      const index = annotations.findIndex((a) => a.id === id);
      if (index === -1) return undefined;

      const updated: Annotation = { ...annotations[index]!, updatedAt: new Date().toISOString() };
      // Dropped, not blanked: a record with `resolvedAt: undefined` reads back
      // from JSON as an absent field anyway, and absent is what "open" means.
      delete updated.resolvedAt;
      delete updated.resolvedBy;
      annotations[index] = updated;
      return updated;
    });
  }

  /**
   * Delete notes finished at or before `resolvedBefore`, and report how many
   * went. Open notes are never touched, whatever their age — a note the work has
   * not finished with is not rubbish, however long it has sat there.
   *
   * Nothing calls this on a timer. Deleting someone's reasoning is a decision a
   * person makes, so the cutoff comes from the caller and never from here.
   */
  async sweepResolved({ resolvedBefore }: SweepOptions): Promise<number> {
    const cutoff = resolvedBefore.toISOString();
    return this.#mutate((annotations) => {
      let removed = 0;
      for (let i = annotations.length - 1; i >= 0; i--) {
        const { resolvedAt } = annotations[i]!;
        if (resolvedAt && resolvedAt <= cutoff) {
          annotations.splice(i, 1);
          removed++;
        }
      }
      return removed;
    });
  }

  get(id: string): Annotation | undefined {
    this.#ensureLoaded();
    return this.#data.annotations.find((a) => a.id === id);
  }

  async remove(id: string): Promise<boolean> {
    return this.#mutate((annotations) => {
      const index = annotations.findIndex((a) => a.id === id);
      if (index === -1) return false;
      // Cut it out in place: the array passed in IS the store's list, so
      // swapping in a new array would throw away what we just read.
      annotations.splice(index, 1);
      return true;
    });
  }

  /**
   * Bounded lookup, by file, by named set, or by both.
   *
   * The two reads answer different questions, so they order differently. A file
   * lookup ranks: an exact line overlap outranks proximity, and ties break
   * toward the most recently updated note. A set is read in the sequence its
   * author gave it, because "review the migration before the handler" is the
   * information the set exists to carry, and ranking would throw it away.
   *
   * Naming neither a file nor a set is an error rather than "everything". An
   * unbounded path is exactly what the result cap exists to prevent, and one
   * that appears by leaving an argument out would be found by accident.
   */
  query(options: QueryOptions): Annotation[] {
    this.#ensureLoaded();
    const { file, scope, line, includeResolved = false } = options;
    if (file === undefined && scope === undefined) {
      throw new Error("AnnotationStore.query needs a file or a scope: there is no query for every note.");
    }

    const bySet = scope !== undefined;
    const limit = options.limit ?? (bySet ? DEFAULT_SCOPE_LIMIT : DEFAULT_LIMIT);

    // Every filter runs before the cap: dropping notes afterwards would spend
    // the caller's few slots on notes it never returns.
    const matches = this.#data.annotations.filter(
      (a) =>
        (file === undefined || a.anchor.file === file) &&
        (scope === undefined || a.scope === scope) &&
        (includeResolved || !a.resolvedAt),
    );

    // `matches` is filter's own array, so sorting it in place is safe.
    const ordered = bySet
      ? matches.sort(bySequence)
      : matches
          .map((a) => ({ a, s: relevance(a, line) }))
          .sort((x, y) => y.s - x.s || byUpdatedDesc(x.a, y.a))
          .map((r) => r.a);

    return ordered.slice(0, Math.max(0, limit));
  }

  /** Every annotation, unranked and unbounded. For tooling/tests, not agents. */
  all(): readonly Annotation[] {
    this.#ensureLoaded();
    return this.#data.annotations;
  }

  #ensureLoaded(): void {
    if (!this.#loaded) {
      throw new Error("AnnotationStore.load() must be awaited before use.");
    }
  }

  /**
   * Apply a change and save it, without overwriting the other writer's work.
   *
   * The editor and the MCP server are two separate programs sharing one file.
   * Writing our whole in-memory copy back would quietly delete everything the
   * other one saved since we last read, so every change re-reads the file first
   * and applies itself to that. Changes from one instance run one after another,
   * so two callers here cannot both read and then both write.
   *
   * One risk is left, between programs: both can still read before either one
   * renames. That gap is now microseconds instead of a whole session. Closing it
   * fully needs a lock file, which we have chosen not to add yet.
   */
  async #mutate<T>(apply: (annotations: Annotation[]) => T): Promise<T> {
    this.#ensureLoaded();
    const run = this.#writes.then(async () => {
      await this.#readFromDisk();
      const result = apply(this.#data.annotations);
      await this.#persist();
      return result;
    });
    // Keep the chain alive even if this write fails, so one error does not
    // wedge every later write on this instance.
    this.#writes = run.catch(() => undefined);
    return run;
  }

  async #readFromDisk(): Promise<void> {
    try {
      const raw = await readFile(this.#path, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoreFile>;
      this.#data = { version: 1, annotations: parsed.annotations ?? [] };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      this.#data = { version: 1, annotations: [] };
    }
  }

  /**
   * Write via a temp file and rename. `rename` is atomic within a filesystem,
   * so a reader — or a crash — sees either the old file or the new one, never a
   * half-written store.
   */
  async #persist(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const temp = `${this.#path}.${process.pid}.${this.#tempCounter++}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(this.#data, null, 2)}\n`, "utf8");
      await rename(temp, this.#path);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
  }
}

/**
 * Store the normalized snapshot alongside its hash, so the stored text matches
 * both its fingerprint and what the read side reconstructs. Every write path
 * goes through here — an anchor persisted with a stale hash reads as drifted.
 */
function sealAnchor(anchor: Omit<Anchor, "snapshotHash">): Anchor {
  const snapshot = normalizeSnapshot(anchor.snapshot);
  return { ...anchor, snapshot, snapshotHash: fingerprint(snapshot) };
}

/** Higher is more relevant. Line overlap dominates; otherwise inverse distance. */
function relevance(a: Annotation, line: number | undefined): number {
  if (line === undefined) return 0;
  const { startLine, endLine } = a.anchor;
  if (line >= startLine && line <= endLine) return Number.MAX_SAFE_INTEGER;
  const distance = line < startLine ? startLine - line : line - endLine;
  return -distance;
}

function byUpdatedDesc(a: Annotation, b: Annotation): number {
  return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
}

/**
 * A set's own sequence: `order` ascending, then oldest first so the run stays
 * put. Notes with no `order` sort last rather than first — the author gave them
 * no place, and a note nobody sequenced should not open the tour.
 */
function bySequence(a: Annotation, b: Annotation): number {
  const left = a.order ?? Number.POSITIVE_INFINITY;
  const right = b.order ?? Number.POSITIVE_INFINITY;
  if (left !== right) return left - right;
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}
