/**
 * Write a long string as readable lines, send it as one paragraph.
 *
 * Tool and prompt descriptions are the product's documentation for agents: they
 * say *when* to call a thing, not only what it does, so they run long on
 * purpose. On a single source line — one of them reached 807 characters — they
 * were unreadable exactly where they get maintained, and a description nobody
 * can read is one that quietly drifts from the behaviour it describes.
 *
 * Parts are joined with a single space, so no part carries a leading or
 * trailing space of its own. Nothing here changes the text an agent sees, and
 * that is not a promise to take on trust: the golden file in
 * test/integration/surface.golden.md holds the joined result word for word.
 */
export function paragraph(...parts: string[]): string {
  return parts.join(" ");
}
