import { describe, expect, it } from "vitest";

import { dedent } from "../../src/text.js";

/**
 * The whole job is to publish what you wrote and not the whitespace you needed
 * to put it at the right nesting level. Everything here is a way of getting
 * that wrong.
 */
describe("dedent", () => {
  it("keeps the newlines and drops the source indentation", () => {
    const text = dedent`
      First line.
      Second line.
    `;
    expect(text).toBe("First line.\nSecond line.");
  });

  it("keeps indentation that was meant, measured from the shallowest line", () => {
    // A list is indented relative to its lead, and that relative shape is
    // content — only the part that came from the code's nesting goes.
    const text = dedent`
      Take these in order:
        - the first
        - the second
    `;
    expect(text).toBe("Take these in order:\n  - the first\n  - the second");
  });

  it("keeps blank lines between paragraphs", () => {
    const text = dedent`
      One.

      Two.
    `;
    expect(text).toBe("One.\n\nTwo.");
  });

  it("measures the indent from the source, never from what was interpolated", () => {
    // A value is not source. If it were counted, a short one could make the
    // whole block look shallower and eat a real indent.
    const scope = "pr/142";
    const text = dedent`
      Set ${scope}.
        - indented under it
    `;
    expect(text).toBe("Set pr/142.\n  - indented under it");
  });

  it("survives a value holding a newline, without letting it re-cut the block", () => {
    const odd = "a\nb";
    const text = dedent`
      Value: ${odd}
      After.
    `;
    // The value lands verbatim; the lines around it keep their own trimming.
    expect(text).toBe("Value: a\nb\nAfter.");
  });

  it("does not touch a line that continues after a value", () => {
    const n = 3;
    expect(dedent`
      It holds ${n} notes, ${n - 1} of them open.
    `).toBe("It holds 3 notes, 2 of them open.");
  });

  it("leaves a single-line string alone", () => {
    expect(dedent`Just this.`).toBe("Just this.");
  });

  it("publishes a backtick as a backtick", () => {
    // Descriptions are full of them — `scope`, `line`, `file` — and they have
    // to be escaped to sit inside a template literal at all. Raw handling would
    // publish the backslash with them, which is why this is cooked.
    expect(dedent`Pass \`scope\` to read a set.`).toBe("Pass `scope` to read a set.");
  });
});
