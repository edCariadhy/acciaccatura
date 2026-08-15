import { describe, expect, it } from "vitest";

import { fingerprint, normalizeSnapshot } from "../src/anchor.js";

describe("snapshot newline normalization", () => {
  it("hashes CRLF and LF versions of the same text identically", () => {
    const lf = "line one\nline two";
    const crlf = "line one\r\nline two";
    expect(fingerprint(lf)).toBe(fingerprint(crlf));
  });

  it("normalizeSnapshot collapses CRLF to LF", () => {
    expect(normalizeSnapshot("a\r\nb\r\n")).toBe("a\nb\n");
  });
});
