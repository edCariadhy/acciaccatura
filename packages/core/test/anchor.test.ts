import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { driftStatus, fingerprint, readRegion } from "../src/anchor.js";
import type { Anchor } from "../src/types.js";

function anchorFor(snapshot: string, file = "src/target.ts"): Anchor {
  return { file, startLine: 2, endLine: 3, snapshot, snapshotHash: fingerprint(snapshot) };
}

describe("anchor drift — the core hard problem", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "acciaccatura-anchor-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reports 'aligned' when the code is unchanged", async () => {
    const snapshot = "  return a + b;\n}";
    await writeFile(join(root, "target.ts"), `function add(a, b) {\n  return a + b;\n}\n`, "utf8");
    const anchor: Anchor = { ...anchorFor(snapshot), file: "target.ts" };

    const current = await readRegion(root, anchor);
    expect(driftStatus(anchor, current)).toBe("aligned");
  });

  it("reports 'drifted' — not a silent false 'aligned' — when the code changed under the anchor", async () => {
    const snapshot = "  return a + b;\n}";
    // Same line range, different code: a refactor moved logic in without moving the anchor.
    await writeFile(join(root, "target.ts"), `function add(a, b) {\n  return a - b;\n}\n`, "utf8");
    const anchor: Anchor = { ...anchorFor(snapshot), file: "target.ts" };

    const current = await readRegion(root, anchor);
    expect(driftStatus(anchor, current)).toBe("drifted");
  });

  it("reports 'unknown' when the file is gone, never a fabricated 'aligned'", async () => {
    const anchor: Anchor = { ...anchorFor("whatever"), file: "does-not-exist.ts" };
    const current = await readRegion(root, anchor);
    expect(current).toBeUndefined();
    expect(driftStatus(anchor, current)).toBe("unknown");
  });

  it("reports 'unknown' when the range now runs past end of file", async () => {
    await writeFile(join(root, "short.ts"), `only one line\n`, "utf8");
    const anchor: Anchor = { ...anchorFor("x"), file: "short.ts", startLine: 2, endLine: 5 };
    expect(await readRegion(root, anchor)).toBeUndefined();
  });
});
