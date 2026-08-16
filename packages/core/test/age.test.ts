import { describe, expect, it } from "vitest";

import { ageInDays, reportAge } from "../src/age.js";
import type { Annotation } from "../src/types.js";

/**
 * What a workspace is carrying.
 *
 * Deleting finished notes asks the caller for a cutoff date, and until now
 * nothing told them what picking one would cost. These are the counts that
 * answer it: open work by how long it has waited, finished work by how long it
 * has been safe to delete.
 *
 * `now` is passed in everywhere, so a test states an age instead of sleeping
 * for one.
 */

const NOW = new Date("2026-08-16T12:00:00.000Z");

/** An ISO date exactly `days` before {@link NOW}. */
function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

let nextId = 0;

function note(overrides: Partial<Annotation> = {}): Annotation {
  const at = daysAgo(0);
  nextId++;
  return {
    id: `n${nextId}`,
    body: "why this exists",
    anchor: { file: "src/pay.ts", startLine: 1, endLine: 1, snapshot: "x", snapshotHash: "h" },
    provenance: "agent",
    trust: "suggested",
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

/** The count in the bucket with this label. */
function bucket(buckets: ReadonlyArray<{ label: string; count: number }>, label: string): number {
  const found = buckets.find((b) => b.label === label);
  expect(found, `no bucket labelled ${label}`).toBeDefined();
  return found!.count;
}

describe("ageInDays", () => {
  it("counts whole days, rounding down", () => {
    expect(ageInDays(daysAgo(0), NOW)).toBe(0);
    expect(ageInDays(new Date(NOW.getTime() - 86_399_999).toISOString(), NOW)).toBe(0);
    expect(ageInDays(daysAgo(1), NOW)).toBe(1);
    expect(ageInDays(daysAgo(45), NOW)).toBe(45);
  });

  it("reads a date written with an offset, not just UTC", () => {
    // Same instant as 2026-08-16T00:00:00Z, twelve hours before NOW: still today.
    expect(ageInDays("2026-08-16T07:00:00+07:00", NOW)).toBe(0);
    // And a full day earlier, written the same way.
    expect(ageInDays("2026-08-15T07:00:00+07:00", NOW)).toBe(1);
  });

  it("reports a date it cannot read rather than guessing an age", () => {
    expect(ageInDays("not a date", NOW)).toBeUndefined();
    expect(ageInDays("", NOW)).toBeUndefined();
  });

  it("treats a date in the future as today, because clocks disagree", () => {
    expect(ageInDays(daysAgo(-5), NOW)).toBe(0);
  });
});

describe("reportAge", () => {
  it("counts nothing as nothing, with the buckets still there to read", () => {
    const report = reportAge([], NOW);
    expect(report.open.total).toBe(0);
    expect(report.finished.total).toBe(0);
    expect(report.open.oldestAt).toBeUndefined();
    expect(report.open.buckets.map((b) => b.label)).toEqual([
      "today",
      "1-6 days",
      "7-29 days",
      "30+ days",
    ]);
  });

  it("ages an open note from when it was written", () => {
    const report = reportAge([note({ createdAt: daysAgo(45) })], NOW);
    expect(report.open.total).toBe(1);
    expect(bucket(report.open.buckets, "30+ days")).toBe(1);
    expect(report.open.oldestAt).toBe(daysAgo(45));
    expect(report.finished.total).toBe(0);
  });

  it("ages a finished note from when it was finished, not when it was written", () => {
    // Written long ago, finished yesterday: a sweep with a week's cutoff must
    // not take it, so the age that counts is the one on the finish.
    const report = reportAge(
      [note({ createdAt: daysAgo(200), resolvedAt: daysAgo(1), resolvedBy: "human" })],
      NOW,
    );
    expect(report.open.total).toBe(0);
    expect(report.finished.total).toBe(1);
    expect(bucket(report.finished.buckets, "1-6 days")).toBe(1);
    expect(bucket(report.finished.buckets, "30+ days")).toBe(0);
    expect(report.finished.oldestAt).toBe(daysAgo(1));
  });

  it("puts each age in exactly one bucket, on the right side of every edge", () => {
    const ages = [0, 0.9, 1, 6, 6.9, 7, 29, 29.9, 30, 400];
    const report = reportAge(
      ages.map((d) => note({ createdAt: daysAgo(d) })),
      NOW,
    );
    expect(bucket(report.open.buckets, "today")).toBe(2);
    expect(bucket(report.open.buckets, "1-6 days")).toBe(3);
    expect(bucket(report.open.buckets, "7-29 days")).toBe(3);
    expect(bucket(report.open.buckets, "30+ days")).toBe(2);
  });

  it("keeps the buckets adding up to the total", () => {
    const report = reportAge(
      [
        note({ createdAt: daysAgo(0) }),
        note({ createdAt: daysAgo(3) }),
        note({ createdAt: daysAgo(3) }),
        note({ createdAt: daysAgo(90) }),
      ],
      NOW,
    );
    const inBuckets = report.open.buckets.reduce((sum, b) => sum + b.count, 0);
    expect(inBuckets + report.open.undated).toBe(report.open.total);
    expect(report.open.total).toBe(4);
  });

  it("says out loud when a date could not be read, instead of dropping the note", () => {
    const report = reportAge(
      [note({ createdAt: "sometime last week" }), note({ createdAt: daysAgo(2) })],
      NOW,
    );
    expect(report.open.total).toBe(2);
    expect(report.open.undated).toBe(1);
    const inBuckets = report.open.buckets.reduce((sum, b) => sum + b.count, 0);
    expect(inBuckets).toBe(1);
    // An age we cannot read must not become the oldest date we report.
    expect(report.open.oldestAt).toBe(daysAgo(2));
  });

  it("keeps open and finished apart, so a sweep count is not an open count", () => {
    const report = reportAge(
      [
        note({ createdAt: daysAgo(40) }),
        note({ createdAt: daysAgo(40) }),
        note({ createdAt: daysAgo(40), resolvedAt: daysAgo(40), resolvedBy: "human" }),
      ],
      NOW,
    );
    expect(report.open.total).toBe(2);
    expect(report.finished.total).toBe(1);
    expect(bucket(report.open.buckets, "30+ days")).toBe(2);
    expect(bucket(report.finished.buckets, "30+ days")).toBe(1);
  });

  it("reports the earliest date, not the first one it met", () => {
    const report = reportAge(
      [
        note({ createdAt: daysAgo(2) }),
        note({ createdAt: daysAgo(60) }),
        note({ createdAt: daysAgo(9) }),
      ],
      NOW,
    );
    expect(report.open.oldestAt).toBe(daysAgo(60));
  });

  it("compares dates as instants, so an offset does not read as older", () => {
    // The +07:00 note is 00:00Z, an hour EARLIER than the other, but it is the
    // larger string. Sorted as text the wrong one wins.
    const report = reportAge(
      [
        note({ createdAt: "2026-08-15T07:00:00+07:00" }), // 00:00Z
        note({ createdAt: "2026-08-15T01:00:00Z" }),
      ],
      NOW,
    );
    expect(report.open.oldestAt).toBe("2026-08-15T07:00:00+07:00");
  });

  it("defaults to the clock when no time is passed", () => {
    const report = reportAge([note({ createdAt: new Date().toISOString() })]);
    expect(bucket(report.open.buckets, "today")).toBe(1);
  });
});
