import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { fingerprint, normalizeSnapshot } from "./anchor.js";
import type { Anchor, Annotation, NewAnnotation, TrustLevel } from "./types.js";

/**
 * Default query bound. Context is the scarce resource: every annotation handed
 * back enters an agent's context window and is re-paid on every later turn, so
 * lookups return "the few that matter", never a full dump.
 */
export const DEFAULT_LIMIT = 3;

interface StoreFile {
  version: 1;
  annotations: Annotation[];
}

export interface QueryOptions {
  /** Workspace-relative POSIX path to look up. */
  file: string;
  /** Optional 1-based line to focus ranking around. */
  line?: number;
  /** Max results; defaults to {@link DEFAULT_LIMIT}. */
  limit?: number;
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

  constructor(path: string) {
    this.#path = path;
  }

  /** Load from disk. A missing file is an empty store, not an error. */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.#path, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoreFile>;
      this.#data = { version: 1, annotations: parsed.annotations ?? [] };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      this.#data = { version: 1, annotations: [] };
    }
    this.#loaded = true;
  }

  async add(input: NewAnnotation): Promise<Annotation> {
    this.#ensureLoaded();
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
      createdAt: now,
      updatedAt: now,
    };
    this.#data.annotations.push(annotation);
    await this.#persist();
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
    this.#ensureLoaded();
    const index = this.#data.annotations.findIndex((a) => a.id === id);
    if (index === -1) return undefined;

    const existing = this.#data.annotations[index]!;
    const updated: Annotation = {
      ...existing,
      body: changes.body ?? existing.body,
      anchor: changes.anchor ? sealAnchor(changes.anchor) : existing.anchor,
      trust: changes.trust ?? existing.trust,
      author: changes.author ?? existing.author,
      updatedAt: new Date().toISOString(),
    };
    this.#data.annotations[index] = updated;
    await this.#persist();
    return updated;
  }

  get(id: string): Annotation | undefined {
    this.#ensureLoaded();
    return this.#data.annotations.find((a) => a.id === id);
  }

  async remove(id: string): Promise<boolean> {
    this.#ensureLoaded();
    const before = this.#data.annotations.length;
    this.#data.annotations = this.#data.annotations.filter((a) => a.id !== id);
    const removed = this.#data.annotations.length < before;
    if (removed) await this.#persist();
    return removed;
  }

  /**
   * Bounded, ranked lookup for one file. An exact line overlap outranks
   * proximity; ties break toward the most recently updated note. Results are
   * capped at `limit` so callers cannot accidentally flood a context window.
   */
  query({ file, line, limit = DEFAULT_LIMIT }: QueryOptions): Annotation[] {
    this.#ensureLoaded();
    return this.#data.annotations
      .filter((a) => a.anchor.file === file)
      .map((a) => ({ a, s: relevance(a, line) }))
      .sort((x, y) => y.s - x.s || byUpdatedDesc(x.a, y.a))
      .slice(0, Math.max(0, limit))
      .map((r) => r.a);
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

  async #persist(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(this.#path, `${JSON.stringify(this.#data, null, 2)}\n`, "utf8");
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
