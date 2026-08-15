import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { driftStatus, fingerprint, readRegion, reanchor } from "../src/anchor.js";
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

describe("reanchor", () => {
  it("finds the anchor when lines are shifted down", () => {
    const snapshot = "  return a + b;\n}";
    const anchor = anchorFor(snapshot);
    const newText = "import { x } from 'y';\n\nfunction add(a, b) {\n  return a + b;\n}\n";
    
    const result = reanchor(anchor, newText);
    expect(result).toBeDefined();
    expect(result?.startLine).toBe(4);
    expect(result?.endLine).toBe(5);
  });

  it("finds the anchor when lines are shifted up", () => {
    const snapshot = "  return a + b;\n}";
    const anchor = { ...anchorFor(snapshot), startLine: 10, endLine: 11 };
    const newText = "function add(a, b) {\n  return a + b;\n}\n";
    
    const result = reanchor(anchor, newText);
    expect(result).toBeDefined();
    expect(result?.startLine).toBe(2);
    expect(result?.endLine).toBe(3);
  });

  it("finds the anchor when whitespace/formatting is modified", () => {
    const snapshot = "  function add(a, b) {\n    return a + b;\n  }";
    const anchor = anchorFor(snapshot);
    anchor.startLine = 1;
    anchor.endLine = 3;
    
    // Prettier formatted the code (changed indentation)
    const newText = "function add(a, b) {\n  return a + b;\n}\n";
    
    const result = reanchor(anchor, newText);
    expect(result).toBeDefined();
    expect(result?.startLine).toBe(1);
    expect(result?.endLine).toBe(3);
  });

  it("returns undefined when the anchor is completely missing or heavily modified", () => {
    const snapshot = "  return a + b;\n}";
    const anchor = anchorFor(snapshot);
    const newText = "function add(a, b) {\n  const sum = a + b;\n  return sum;\n}\n"; // Snapshot doesn't exist anymore
    
    const result = reanchor(anchor, newText);
    expect(result).toBeUndefined();
  });

  it("finds the anchor with partial matches (>=80%) for large blocks", () => {
    const snapshot = Array.from({length: 10}, (_, i) => `line ${i}`).join("\n");
    const anchor = anchorFor(snapshot);
    anchor.endLine = anchor.startLine + 9;
    
    // One line changed in the middle
    const currentLines = Array.from({length: 10}, (_, i) => i === 5 ? "changed line" : `line ${i}`);
    const newText = currentLines.join("\n");
    
    const result = reanchor(anchor, newText);
    expect(result).toBeDefined();
    expect(result?.startLine).toBe(1);
    expect(result?.endLine).toBe(10);
  });
});
