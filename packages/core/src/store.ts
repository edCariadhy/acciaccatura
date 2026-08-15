import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { fingerprint, normalizeSnapshot } from "./anchor.js";
import type { Annotation, NewAnnotation } from "./types.js";

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
    // Store the normalized snapshot so it matches its hash and the read side.
    const snapshot = normalizeSnapshot(input.anchor.snapshot);
    const annotation: Annotation = {
      id: randomUUID(),
      body: input.body,
      anchor: { ...input.anchor, snapshot, snapshotHash: fingerprint(snapshot) },
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
