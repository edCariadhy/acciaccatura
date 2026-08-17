/** A selection's endpoints in 0-based editor coordinates. */
export interface RawSelection {
  startLine: number;
  endLine: number;
  /** Column of the selection's end. Only the "at column 0" case matters here. */
  endChar: number;
}

/**
 * Vscode-free core of {@link selectionFrom} (`extension.ts`): decides which
 * whole lines a selection covers. Deliberately takes plain numbers, not
 * `vscode.Selection`, so it can be unit-tested without an editor host — the
 * same split `capture.ts`/`selection.ts` already draw between pure logic and
 * `vscode` glue.
 */
export function resolveCaptureLines(sel: RawSelection): { startLine: number; endLineIdx: number } {
  // A selection ending at column 0 of a later line does not include that line.
  const endLineIdx =
    sel.endChar === 0 && sel.endLine > sel.startLine ? sel.endLine - 1 : sel.endLine;
  return { startLine: sel.startLine, endLineIdx };
}
