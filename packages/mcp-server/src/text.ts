/**
 * Write a long string the way it will be read.
 *
 * Tool and prompt descriptions are the product's documentation for agents: they
 * say *when* to call a thing, not only what it does, so they run long on
 * purpose. On a single source line — one reached 807 characters — they were
 * unreadable exactly where they get maintained, and a description nobody can
 * read is one that quietly drifts from the behaviour it describes.
 *
 * Two earlier attempts are worth knowing about, because both were worse:
 *
 * - **Wrapping at a column** turned one 807-character line into nine
 *   92-character fragments that broke mid-clause. The line-length number
 *   improved and the reading did not.
 * - **An array of sentences** read better, but it was a workaround for a
 *   constraint that turned out not to exist. It was chosen to keep the joined
 *   text byte-identical while a published surface was reformatted; descriptions
 *   are not a compatibility surface, so nothing needed protecting once the
 *   golden file made changes visible.
 *
 * So the string is now simply written as it reads, newlines and all. `dedent`
 * removes the source indentation that would otherwise be published with it, so
 * the text can sit at the nesting level of the code around it.
 */
export function dedent(strings: TemplateStringsArray, ...values: unknown[]): string {
  // Cooked, not raw. These strings are full of backticks — `scope`, `line`,
  // `file` — which have to be escaped to sit inside a template literal at all,
  // and raw would publish the backslash along with them.
  const parts = strings.map((part) => part ?? "");

  // The indent is measured from the source alone, never from the interpolated
  // result. A set named pr/142 must not be able to change how the text around
  // it is trimmed.
  const starts = parts
    .flatMap((part) => part.split("\n").slice(1))
    .filter((line) => line.trim() !== "");
  const pad = starts.length === 0 ? 0 : Math.min(...starts.map((l) => /^[ \t]*/.exec(l)![0].length));

  // Within a part the first segment continues whatever line the previous
  // interpolation left open, so only the segments that begin a line are cut.
  const cut = parts.map((part) =>
    part
      .split("\n")
      .map((segment, i) => (i === 0 ? segment : segment.slice(pad)))
      .join("\n"),
  );

  return cut.map((part, i) => (i < values.length ? part + String(values[i]) : part)).join("").trim();
}
