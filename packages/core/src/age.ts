import type { Annotation } from "./types.js";

/**
 * How old the notes in a workspace are.
 *
 * A note is a working note, not a permanent record, so a store that keeps
 * filling up is telling you something: work that stalled, or notes nobody
 * finished. Deleting them is a person's decision and nothing sweeps on a timer,
 * which leaves a gap — the person deciding has no idea what they are holding.
 * `sweepResolved` asks the caller for a cutoff date and gives them nothing to
 * pick it with. This is that missing half.
 *
 * Counts and buckets, never a score. "6 open notes, 30 days or more" is
 * something a reader can act on; a single "health: 0.4" would be an authority
 * we made up. Same rule the staleness rollup follows.
 */

/** How long a bucket covers, and how many notes fall in it. */
export interface AgeBucket {
  /** Lower edge in whole days, counted in. */
  fromDays: number;
  /** Upper edge in whole days, counted out. Absent on the last bucket. */
  toDays?: number;
  /** Short label for a message bar or a tool answer, e.g. `7-29 days`. */
  label: string;
  count: number;
}

/**
 * One group of notes, split by age.
 *
 * `total` always equals the bucket counts plus `undated`, so a reader can trust
 * the split adds up.
 */
export interface AgeBreakdown {
  total: number;
  buckets: AgeBucket[];
  /**
   * Notes whose date could not be read, so they sit in no bucket. Normally 0 —
   * the store writes ISO-8601 — but a store file is a text file someone may
   * have edited, and a note we cannot age is better said out loud than quietly
   * dropped or filed under the oldest bucket it never earned.
   */
  undated: number;
  /** The earliest date in this group, absent when there is none to report. */
  oldestAt?: string;
}

/** What a workspace is carrying, open work and finished work kept apart. */
export interface AgeReport {
  /** Open notes, aged from when each was written. */
  open: AgeBreakdown;
  /** Finished notes, aged from when each was finished — what a sweep would take. */
  finished: AgeBreakdown;
}

/**
 * Bucket edges in whole days.
 *
 * Fixed rather than passed in, because the reason to read this is to decide
 * something and a caller inventing its own edges is a caller inventing its own
 * meaning. A month is the edge that matters: a working note still open after a
 * month has outlived the work it was written for.
 */
const EDGES: ReadonlyArray<{ fromDays: number; toDays?: number; label: string }> = [
  { fromDays: 0, toDays: 1, label: "today" },
  { fromDays: 1, toDays: 7, label: "1-6 days" },
  { fromDays: 7, toDays: 30, label: "7-29 days" },
  { fromDays: 30, label: "30+ days" },
];

const MS_PER_DAY = 86_400_000;

/**
 * Whole days between an ISO-8601 date and `now`, or `undefined` when the date
 * cannot be read.
 *
 * A date in the future reads as 0 rather than a negative number: clocks
 * disagree, and "written tomorrow" is a machine problem, not an age.
 */
export function ageInDays(iso: string, now: Date = new Date()): number | undefined {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return undefined;
  return Math.max(0, Math.floor((now.getTime() - then) / MS_PER_DAY));
}

/**
 * Summarise how old a workspace's notes are. Metadata only — this reads no
 * code and touches no file, so it stays cheap enough to call on a keystroke.
 *
 * Open notes are aged from `createdAt`, finished ones from `resolvedAt`,
 * because the two answer different questions: how long has this been waiting,
 * and how long has this been safe to delete.
 */
export function reportAge(annotations: readonly Annotation[], now: Date = new Date()): AgeReport {
  const open: string[] = [];
  const finished: string[] = [];
  for (const note of annotations) {
    if (note.resolvedAt) finished.push(note.resolvedAt);
    else open.push(note.createdAt);
  }
  return { open: breakdown(open, now), finished: breakdown(finished, now) };
}

/** Split one group of dates into the buckets. */
function breakdown(dates: readonly string[], now: Date): AgeBreakdown {
  const buckets: AgeBucket[] = EDGES.map((edge) => ({ ...edge, count: 0 }));
  let undated = 0;
  let oldestAt: string | undefined;
  let oldestMs = Number.POSITIVE_INFINITY;

  for (const date of dates) {
    const days = ageInDays(date, now);
    if (days === undefined) {
      undated++;
      continue;
    }
    // Both edges are checked, so the buckets stay right if this list is ever
    // reordered or re-cut. The last one has no upper edge.
    const bucket = buckets.find(
      (b) => days >= b.fromDays && (b.toDays === undefined || days < b.toDays),
    );
    if (bucket) bucket.count++;
    // Compared as instants, not as text: two ISO dates may carry different
    // offsets, and the earlier one is not always the smaller string.
    const at = Date.parse(date);
    if (at < oldestMs) {
      oldestMs = at;
      oldestAt = date;
    }
  }

  return { total: dates.length, buckets, undated, oldestAt };
}
