import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AnnotationStore } from "../src/store.js";
import { reportScope } from "../src/scope.js";
import type { NewAnnotation } from "../src/types.js";

/**
 * A scope's rollup is what an agent reads to decide whether a set still
 * describes the code, or whether a finished one can go. It reports counts and
 * never a score: "2 notes point at code that is gone" is something to act on,
 * where "staleness: 0.72" would be an authority we made up.
 */

let dir: string;
let storePath: string;

const CODE = "export function pay(a) {\n  return a * 2;\n}\n";

function draft(overrides: Partial<NewAnnotation> = {}): NewAnnotation {
  return {
    body: "why this exists",
    provenance: "agent",
    anchor: { file: "src/pay.ts", startLine: 2, endLine: 2, snapshot: "  return a * 2;" },
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "acc-scope-"));
  storePath = join(dir, ".acciaccatura", "annotations.json");
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "pay.ts"), CODE, "utf8");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function loaded(): Promise<AnnotationStore> {
  const store = new AnnotationStore(storePath);
  await store.load();
  return store;
}

describe("the scope index", () => {
  it("lists each named set once, with how many notes it holds", async () => {
    const store = await loaded();
    await store.add(draft({ scope: "pr/142", order: 1 }));
    await store.add(draft({ scope: "pr/142", order: 2 }));
    await store.add(draft({ scope: "onboarding/billing", order: 1 }));

    const index = store.scopes();
    expect(index.map((s) => [s.scope, s.notes])).toEqual([
      ["onboarding/billing", 1],
      ["pr/142", 2],
    ]);
  });

  it("leaves out notes that belong to no set", async () => {
    const store = await loaded();
    await store.add(draft());
    await store.add(draft({ scope: "pr/142" }));

    expect(store.scopes()).toHaveLength(1);
  });

  it("says how many notes are still open and how many are finished", async () => {
    const store = await loaded();
    const done = await store.add(draft({ scope: "pr/142", order: 1 }));
    await store.add(draft({ scope: "pr/142", order: 2 }));
    await store.resolve(done.id, "agent");

    const [pr] = store.scopes();
    expect(pr?.open).toBe(1);
    expect(pr?.finished).toBe(1);
    expect(pr?.notes).toBe(2);
  });

  it("reports when the set was opened, so age can be judged", async () => {
    const store = await loaded();
    const first = await store.add(draft({ scope: "pr/142", order: 1 }));
    await store.add(draft({ scope: "pr/142", order: 2 }));

    // The set is as old as its oldest note, not its newest.
    expect(store.scopes()[0]?.openedAt).toBe(first.createdAt);
  });

  it("is empty when nothing is in a set at all", async () => {
    const store = await loaded();
    await store.add(draft());
    expect(store.scopes()).toEqual([]);
  });

  it("reads no files, so listing stays cheap however many sets there are", async () => {
    const store = await loaded();
    await store.add(draft({ scope: "pr/142", anchor: { file: "src/gone.ts", startLine: 1, endLine: 1, snapshot: "x" } }));

    // src/gone.ts does not exist. Listing must not care: the index is metadata,
    // and the check that reads code is a separate, per-scope cost.
    expect(() => store.scopes()).not.toThrow();
    expect(store.scopes()[0]?.notes).toBe(1);
  });
});

describe("checking one scope against the code", () => {
  it("counts a note as aligned while its code is untouched", async () => {
    const store = await loaded();
    await store.add(draft({ scope: "pr/142", order: 1 }));

    const report = await reportScope("pr/142", store.all(), dir);
    expect(report?.aligned).toBe(1);
    expect(report?.drifted).toBe(0);
    expect(report?.gone).toBe(0);
  });

  it("counts a note as drifted when its code moved", async () => {
    const store = await loaded();
    await store.add(draft({ scope: "pr/142", order: 1 }));
    // Push the anchored line down; the code still exists, elsewhere.
    await writeFile(join(dir, "src", "pay.ts"), `// added\n// added\n${CODE}`, "utf8");

    const report = await reportScope("pr/142", store.all(), dir);
    expect(report?.drifted).toBe(1);
    expect(report?.aligned).toBe(0);
  });

  it("counts a note as gone when its code is nowhere in the file", async () => {
    const store = await loaded();
    await store.add(draft({ scope: "pr/142", order: 1 }));
    await writeFile(join(dir, "src", "pay.ts"), "export const unrelated = 1;\n", "utf8");

    const report = await reportScope("pr/142", store.all(), dir);
    expect(report?.gone).toBe(1);
  });

  it("counts a note as gone when the file itself is deleted", async () => {
    const store = await loaded();
    await store.add(draft({ scope: "pr/142", order: 1 }));
    await rm(join(dir, "src", "pay.ts"));

    const report = await reportScope("pr/142", store.all(), dir);
    expect(report?.gone).toBe(1);
  });

  it("checks only notes still open, because a finished note's code no longer matters", async () => {
    const store = await loaded();
    const done = await store.add(draft({ scope: "pr/142", order: 1 }));
    await store.resolve(done.id, "agent");
    await rm(join(dir, "src", "pay.ts"));

    const report = await reportScope("pr/142", store.all(), dir);
    // The set is finished; its code being gone is not a problem to report.
    expect(report?.gone).toBe(0);
    expect(report?.finished).toBe(1);
  });

  it("does not look at notes from another set", async () => {
    const store = await loaded();
    await store.add(draft({ scope: "pr/142", order: 1 }));
    await store.add(
      draft({
        scope: "onboarding/billing",
        anchor: { file: "src/missing.ts", startLine: 1, endLine: 1, snapshot: "x" },
      }),
    );

    const report = await reportScope("pr/142", store.all(), dir);
    expect(report?.gone).toBe(0);
    expect(report?.notes).toBe(1);
  });

  it("reports nothing for a set that does not exist", async () => {
    const store = await loaded();
    await store.add(draft({ scope: "pr/142" }));

    // Absent, not an empty set of zeroes: those are different answers, and an
    // agent must be able to tell "no such set" from "a set with no problems".
    expect(await reportScope("pr/999", store.all(), dir)).toBeUndefined();
  });

  it("carries the index counts through, so one call answers the whole question", async () => {
    const store = await loaded();
    const done = await store.add(draft({ scope: "pr/142", order: 1 }));
    await store.add(draft({ scope: "pr/142", order: 2 }));
    await store.resolve(done.id, "agent");

    const report = await reportScope("pr/142", store.all(), dir);
    expect(report?.notes).toBe(2);
    expect(report?.open).toBe(1);
    expect(report?.finished).toBe(1);
    expect(report?.openedAt).toBeTruthy();
  });
});
