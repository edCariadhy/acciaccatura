import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { fingerprint, normalizeSnapshot } from "./anchor.js";
import { withStoreLock } from "./lock.js";
import { indexScopes } from "./scope.js";
import type { ScopeIndexEntry } from "./scope.js";
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
  /**
   * Move the note to another set, or pass `null` to take it out of every set.
   * Omit to leave the set as it is — the three cases are different, which is
   * why this is not just an optional string.
   */
  scope?: string | null;
  /** New place in the sequence, or `null` to give it none. Omit to leave it. */
  order?: number | null;
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
  /**
   * What each file looked like when this instance last read it.
   *
   * A second line behind {@link withStoreLock}, for anything that writes
   * without taking the lock — an older build still running, or a person
   * editing the file by hand. On its own it is not enough: it catches
   * "somebody wrote before me", and the case that loses notes is "somebody is
   * writing at the same moment as me".
   */
  #seen = new Map<string, string>();
  /**
   * The bytes each file currently holds, as a digest.
   *
   * Every write used to rewrite every file the list needed, so adding one note
   * to a 2,000-note store wrote 1,281 KB across every file — and two writers
   * touching unrelated sets collided every time, because they were both
   * rewriting the same bytes. A file whose contents have not changed is not
   * written at all now, which turns "always collide" into "never" for writers
   * working on different sets.
   */
  #digest = new Map<string, string>();

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

      // Three cases, not two: absent leaves the set alone, a name moves the
      // note, and null takes it out. Dropped rather than blanked, because an
      // absent field is what "in no set" means once it is read back from JSON.
      if (changes.scope !== undefined) {
        if (changes.scope === null) delete updated.scope;
        else updated.scope = changes.scope;
      }
      if (changes.order !== undefined) {
        if (changes.order === null) delete updated.order;
        else updated.order = changes.order;
      }

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

  /**
   * Finish every open note in one named set, and report how many were finished.
   * A merged pull request ends twenty notes at once; doing that one round trip
   * at a time is the kind of cost that stops an agent bothering at all.
   *
   * Notes already finished are left exactly as they are and are not counted, so
   * the first answer stands and closing twice is safe — the same rule
   * {@link AnnotationStore.resolve} follows for a single note.
   *
   * This is the prune verb, and it is deliberately the reversible one: closing
   * keeps every record and {@link AnnotationStore.reopen} undoes it note by
   * note. Deleting is the one that loses someone's reasoning, which is why it
   * stays a person's decision in {@link AnnotationStore.sweepResolved}.
   */
  async resolveScope(scope: string, by: Provenance): Promise<number> {
    return this.#mutate((annotations) => {
      const now = new Date().toISOString();
      let finished = 0;
      for (let i = 0; i < annotations.length; i++) {
        const existing = annotations[i]!;
        if (existing.scope !== scope || existing.resolvedAt) continue;
        annotations[i] = { ...existing, resolvedAt: now, resolvedBy: by, updatedAt: now };
        finished++;
      }
      return finished;
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

  /**
   * Summarise every named set: counts and dates, no file reads. A workspace may
   * hold many sets, so the listing has to stay cheap; checking whether one set
   * still matches the code is a separate, per-set cost. See
   * {@link reportScope}.
   */
  scopes(): ScopeIndexEntry[] {
    this.#ensureLoaded();
    return indexScopes(this.#data.annotations);
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
    const run = this.#writes.then(async () =>
      // The queue above orders this process against itself. The lock orders it
      // against the other one: everything from the read to the last rename
      // happens with the store to ourselves. Reading outside the lock is what
      // loses notes — the other writer saves between our read and our write,
      // and we then save a list that never knew about it.
      withStoreLock(this.#path, async () => {
        for (let attempt = 1; ; attempt++) {
          await this.#readFromDisk();
          const result = apply(this.#data.annotations);
          try {
            await this.#persist();
            return result;
          } catch (err) {
            if (!(err instanceof StoreChangedError) || attempt >= MAX_WRITE_ATTEMPTS) throw err;
            // Reached only when something wrote without taking the lock.
            // Redoing the work against what they left beats saving over them.
            await new Promise((r) => setTimeout(r, Math.random() * RETRY_BACKOFF_MS));
          }
        }
      }),
    );
    // Keep the chain alive even if this write fails, so one error does not
    // wedge every later write on this instance.
    this.#writes = run.catch(() => undefined);
    return run;
  }

  /**
   * Read the shared file and every set file, and merge them into one list.
   *
   * A note may appear twice when a move between sets stopped half way — see
   * {@link AnnotationStore.persist}. The newer copy wins, which is what makes a
   * broken move heal itself rather than needing a repair step.
   */
  async #readFromDisk(): Promise<void> {
    const files = [this.#path, ...(await this.#scopeFiles())];
    const byId = new Map<string, Annotation>();

    this.#seen.clear();
    for (const file of files) {
      const { annotations, mark, digest } = await readWithMark(file);
      // The mark belongs to the bytes just read, not to the file a moment
      // later, or a write landing in between would be invisible to the check
      // that exists to catch exactly that.
      this.#seen.set(file, mark);
      this.#digest.set(file, digest);
      for (const note of annotations) {
        const seen = byId.get(note.id);
        if (!seen || seen.updatedAt < note.updatedAt) byId.set(note.id, note);
      }
    }

    this.#data = { version: 1, annotations: [...byId.values()] };
  }

  /** Paths of every set file currently on disk. */
  async #scopeFiles(): Promise<string[]> {
    const dir = join(dirname(this.#path), SCOPE_DIR);
    try {
      const names = await readdir(dir);
      return names.filter((n) => n.endsWith(".json")).sort().map((n) => join(dir, n));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      return [];
    }
  }

  /**
   * Save every file the current list needs.
   *
   * A set is the unit you hand over, end, and review, so it is the unit the
   * store is cut along: a pull request's notes are one file next to the diff,
   * and two pull requests touching different sets never meet in a conflict.
   * Notes in no set stay in the shared file, which is also what an older store
   * is — so an old file still loads, and its scoped notes move to their own
   * file the next time anything is written.
   *
   * Each file is written through a temp file and renamed, which is atomic within
   * a filesystem. Across two files nothing is atomic, so the ORDER matters:
   * files that gain notes are written before files that lose them. A crash in
   * between then leaves a note in two files — a duplicate the next read heals —
   * instead of in none, which nothing could recover.
   */
  async #persist(): Promise<void> {
    const wanted = this.#partition();

    await mkdir(dirname(this.#path), { recursive: true });
    if ([...wanted.keys()].some((f) => f !== this.#path)) {
      await mkdir(join(dirname(this.#path), SCOPE_DIR), { recursive: true });
    }

    // Anything already on disk that no longer holds notes is emptied, never
    // deleted: the file staying put is what shows a reviewer that a set was
    // emptied. A file that never existed is not created just to hold nothing —
    // a workspace whose notes are all in sets has no use for an empty shared
    // file sitting in its history.
    const onDisk = [...(await this.#scopeFiles()), ...((await exists(this.#path)) ? [this.#path] : [])];
    const emptied = onDisk.filter((f) => !wanted.has(f));

    // Serialise first, then keep only what a write would actually alter. The
    // comparison is on the exact bytes about to be saved, so it can never skip
    // a file that needed saving.
    const gaining = [...wanted]
      .map(([file, annotations]) => ({ file, text: serialise(annotations) }))
      .filter(({ file, text }) => digestOf(text) !== this.#digest.get(file));
    const losing = emptied
      .map((file) => ({ file, text: serialise([]) }))
      .filter(({ file, text }) => digestOf(text) !== this.#digest.get(file));

    if (gaining.length === 0 && losing.length === 0) return;

    // Check before writing any of them. Checking as we go could leave half a
    // change applied, which is worse than the conflict itself: the retry would
    // then run against a store we had already half rewritten.
    await this.#checkUnchanged([...gaining, ...losing].map((w) => w.file));

    // Gaining before losing, still: a note moving between sets must exist in
    // both files rather than neither if this stops half way.
    for (const { file, text } of gaining) await this.#write(file, text);
    for (const { file, text } of losing) await this.#write(file, text);
  }

  /**
   * Refuse to write over anything that moved since it was read.
   *
   * A file we never read counts as moved: another writer creating a set
   * between our read and our write is the case where we would otherwise empty
   * their brand-new file, having partitioned a list that never knew about it.
   */
  async #checkUnchanged(files: readonly string[]): Promise<void> {
    for (const file of new Set(files)) {
      const now = await markOf(file);
      if (now !== (this.#seen.get(file) ?? ABSENT)) throw new StoreChangedError(file);
    }
  }

  /**
   * Work out which file each note belongs in, and refuse a set whose name would
   * land on another set's file. Two different sets quietly sharing one file
   * would merge them, which is worse than saying no.
   */
  #partition(): Map<string, Annotation[]> {
    const byFile = new Map<string, Annotation[]>();
    const claimedBy = new Map<string, string>();

    for (const note of this.#data.annotations) {
      let file = this.#path;
      if (note.scope !== undefined) {
        file = join(dirname(this.#path), SCOPE_DIR, `${scopeFileName(note.scope)}.json`);
        const owner = claimedBy.get(file);
        if (owner !== undefined && owner !== note.scope) {
          throw new Error(
            `The sets "${owner}" and "${note.scope}" both want the file ${scopeFileName(note.scope)}.json. Rename one of them.`,
          );
        }
        claimedBy.set(file, note.scope);
      }
      const list = byFile.get(file);
      if (list) list.push(note);
      else byFile.set(file, [note]);
    }

    return byFile;
  }

  /**
   * Write one file via a temp file and rename. `rename` is atomic within a
   * filesystem, so a reader — or a crash — sees either the old file or the new
   * one, never a half-written store.
   */
  async #write(file: string, text: string): Promise<void> {
    const temp = `${file}.${process.pid}.${this.#tempCounter++}.tmp`;
    try {
      await writeFile(temp, text, "utf8");
      await rename(temp, file);
      // This instance is now the last writer, so what it just wrote is what it
      // has seen. Without this the next file in the same batch would report a
      // conflict against us, and the next write would think the file still
      // held what it held before.
      this.#seen.set(file, await markOf(file));
      this.#digest.set(file, digestOf(text));
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
  }
}

/** Where set files live, beside the shared store file. */
const SCOPE_DIR = "scopes";

/** Whether a path is readable. */
/** How many times a write redoes itself before giving up. */
const MAX_WRITE_ATTEMPTS = 8;

/** Upper bound on the pause between attempts, in milliseconds. */
const RETRY_BACKOFF_MS = 25;

/** The mark of a file that is not there. */
const ABSENT = "absent";

/**
 * Raised when a file changed between being read and being written over.
 * Internal to the retry in {@link AnnotationStore.mutate}: a caller never sees
 * it, because losing that race is not a failure, it is a reason to redo the
 * work against what the other writer left.
 */
class StoreChangedError extends Error {
  readonly file: string;

  constructor(file: string) {
    super(`${file} changed while it was being written`);
    this.name = "StoreChangedError";
    this.file = file;
  }
}

/**
 * What a file looks like right now, or {@link ABSENT}.
 *
 * The inode is the load-bearing part. Every write lands by renaming a temp
 * file into place, and a rename replaces the inode, so a changed inode means
 * somebody wrote — with no dependence on clock resolution, which two writes in
 * the same millisecond would defeat.
 */
async function markOf(file: string): Promise<string> {
  try {
    const found = await stat(file);
    return `${found.ino}:${found.size}:${found.mtimeMs}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return ABSENT;
  }
}

/**
 * Read a file and say what it looked like, with the two guaranteed to match.
 *
 * Marking only after the read would describe a file that may already have been
 * replaced, and the write check would then compare the new file against itself,
 * pass, and save stale notes. Marking on both sides and insisting they agree is
 * what ties the mark to the bytes in hand.
 */
async function readWithMark(
  file: string,
): Promise<{ annotations: Annotation[]; mark: string; digest: string }> {
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    const before = await markOf(file);
    const text = await readText(file);
    const after = await markOf(file);
    if (before === after) {
      return { annotations: parseAnnotations(text), mark: after, digest: digestOf(text ?? "") };
    }
  }
  throw new Error(`${file} is being rewritten faster than it can be read`);
}

/** Exactly the bytes a store file holds, so a digest describes the real file. */
function serialise(annotations: Annotation[]): string {
  const contents: StoreFile = { version: 1, annotations };
  return `${JSON.stringify(contents, null, 2)}\n`;
}

/** Content identity for "would this write change anything". */
function digestOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Read one store file, treating a missing file as empty. */
/** A file's raw text, or `undefined` when it is not there. */
async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return undefined;
  }
}

function parseAnnotations(text: string | undefined): Annotation[] {
  if (text === undefined) return [];
  const parsed = JSON.parse(text) as Partial<StoreFile>;
  return parsed.annotations ?? [];
}

/**
 * A set's file name. Readable first — a reviewer reads these in a diff — so
 * `pr/142` becomes `pr__142` rather than something percent-encoded end to end.
 * Everything outside a safe alphabet is escaped, which keeps a name like
 * `feature/../etc` inside the scopes folder instead of climbing out of it.
 *
 * The mapping is not reversible, and does not need to be: the set's real name is
 * stored inside the file. It only has to be unique, and {@link AnnotationStore}
 * refuses two sets that would land on one file.
 */
function scopeFileName(scope: string): string {
  return scope
    .replace(/\//g, "__")
    .replace(/[^A-Za-z0-9_-]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
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
 *
 * Exported because the editor sidebar sorts the same sets. Two copies of this
 * rule would eventually disagree, and then a tour would read one way for an
 * agent and another way for the person sitting next to it.
 */
export function bySequence(a: Annotation, b: Annotation): number {
  const left = a.order ?? Number.POSITIVE_INFINITY;
  const right = b.order ?? Number.POSITIVE_INFINITY;
  if (left !== right) return left - right;
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}
