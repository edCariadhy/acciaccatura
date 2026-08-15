import { describe, expect, it } from "vitest";

import { annotationFromSelection, EmptyAnnotationBodyError } from "../src/selection.js";
import type { CapturedSelection } from "../src/selection.js";

const sel: CapturedSelection = {
  file: "src/a.ts",
  startLine: 10,
  endLine: 12,
  snapshot: "const x = 1;",
};

describe("annotationFromSelection", () => {
  it("defaults provenance to 'human' (the editor is the human writer)", () => {
    const draft = annotationFromSelection({ selection: sel, body: "note" });
    expect(draft.provenance).toBe("human");
    expect(draft.anchor).toEqual(sel);
    expect(draft.body).toBe("note");
  });

  it("trims the body", () => {
    expect(annotationFromSelection({ selection: sel, body: "  spaced  " }).body).toBe("spaced");
  });

  it("rejects an empty/whitespace-only body loudly", () => {
    expect(() => annotationFromSelection({ selection: sel, body: "   " })).toThrow(
      EmptyAnnotationBodyError,
    );
  });

  it("rejects an inverted or non-positive range", () => {
    expect(() => annotationFromSelection({ selection: { ...sel, startLine: 12, endLine: 10 }, body: "x" })).toThrow(RangeError);
    expect(() => annotationFromSelection({ selection: { ...sel, startLine: 0, endLine: 0 }, body: "x" })).toThrow(RangeError);
  });

  it("passes an explicit provenance/author through (e.g. an agent path)", () => {
    const draft = annotationFromSelection({ selection: sel, body: "x", provenance: "agent", author: "bot" });
    expect(draft.provenance).toBe("agent");
    expect(draft.author).toBe("bot");
  });
});
