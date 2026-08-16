/**
 * The annotation data model.
 *
 * Provenance and trust are first-class, not a later feature: humans annotate in
 * the editor and agents annotate over MCP, but both write to the SAME store, so
 * every record must say who wrote it and how far to trust it.
 */

/** Who created the annotation. */
export type Provenance = "human" | "agent";

/**
 * How much weight to give the note. A note is a hint, never the truth: trust
 * only says how seriously to take it next to the code, and the code always
 * wins when they disagree.
 */
export type TrustLevel = "authoritative" | "suggested" | "unverified";

/**
 * Result of comparing an anchor's captured snapshot against the code that now
 * occupies its lines. "unknown" means the current text could not be read.
 * Drift must surface loudly: a note silently pointing at changed code is worse
 * than no note at all.
 */
export type DriftStatus = "aligned" | "drifted" | "unknown";

/**
 * Where a note is attached. Line numbers are a best guess and WILL move as
 * code moves; `snapshot`/`snapshotHash` exist so that drift can be detected
 * rather than hidden. Robust re-anchoring is the core open problem — see the
 * anchoring notes in the design docs.
 */
export interface Anchor {
  /** Workspace-relative POSIX path, e.g. `src/store.ts`. */
  file: string;
  /** 1-based inclusive first line at time of writing. */
  startLine: number;
  /** 1-based inclusive last line at time of writing. */
  endLine: number;
  /** Exact text of the region when the annotation was created. */
  snapshot: string;
  /** SHA-256 of `snapshot`, for cheap drift checks. Derived on write. */
  snapshotHash: string;
}

export interface Annotation {
  id: string;
  body: string;
  anchor: Anchor;
  provenance: Provenance;
  trust: TrustLevel;
  author?: string;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601. */
  updatedAt: string;
  /**
   * ISO-8601 moment the work this note was about finished. Absent means the
   * note is still open — including on notes written before this field existed.
   *
   * A note is a working note between collaborators, not a permanent record: it
   * needs an end, or the store only grows and every stale note keeps spending
   * an agent's context. A finished note stays on disk, out of the way, until
   * someone sweeps it.
   */
  resolvedAt?: string;
  /** Who decided the work was done. Set together with {@link resolvedAt}. */
  resolvedBy?: Provenance;
}

/** Input to {@link AnnotationStore.add}; the store derives id, hash, timestamps. */
export interface NewAnnotation {
  body: string;
  anchor: Omit<Anchor, "snapshotHash">;
  provenance: Provenance;
  trust?: TrustLevel;
  author?: string;
}
