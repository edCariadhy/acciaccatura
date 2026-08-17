import { describe, expect, it } from "vitest";

import { resolveCaptureLines } from "../../src/lineRange.js";

describe("resolveCaptureLines", () => {
  it("keeps a normal multi-line selection as-is", () => {
    expect(resolveCaptureLines({ startLine: 2, endLine: 4, endChar: 5 })).toEqual({
      startLine: 2,
      endLineIdx: 4,
    });
  });

  it("excludes a later line the selection only touches at column 0", () => {
    expect(resolveCaptureLines({ startLine: 2, endLine: 5, endChar: 0 })).toEqual({
      startLine: 2,
      endLineIdx: 4,
    });
  });

  it("falls back to the caret's own line when nothing is selected", () => {
    // start === end (a caret, not a range) — the case that used to be refused.
    expect(resolveCaptureLines({ startLine: 7, endLine: 7, endChar: 3 })).toEqual({
      startLine: 7,
      endLineIdx: 7,
    });
  });
});
