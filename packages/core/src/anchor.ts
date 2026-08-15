import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Anchor, DriftStatus } from "./types.js";

/**
 * Normalize line endings before hashing or comparing snapshots. The read side
 * ({@link readRegion}) joins lines with "\n", so the write side must too — else
 * a CRLF file would hash differently and read as falsely "drifted".
 */
export function normalizeSnapshot(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** Stable content fingerprint used to detect anchor drift. */
export function fingerprint(text: string): string {
  return createHash("sha256").update(normalizeSnapshot(text), "utf8").digest("hex");
}

/**
 * Compare an anchor's captured snapshot against the current text of its lines.
 * `undefined` currentText (file gone / unreadable) yields "unknown" — we never
 * silently claim "aligned" when we could not check.
 */
export function driftStatus(anchor: Anchor, currentText: string | undefined): DriftStatus {
  if (currentText === undefined) return "unknown";
  return fingerprint(currentText) === anchor.snapshotHash ? "aligned" : "drifted";
}

/**
 * Read the text currently occupying an anchor's line range, relative to the
 * workspace root. Returns `undefined` if the file cannot be read (moved,
 * deleted, or the range now runs past EOF). This is the read side of
 * "degrade loudly": callers pair it with {@link driftStatus}.
 */
export async function readRegion(root: string, anchor: Anchor): Promise<string | undefined> {
  try {
    const text = await readFile(join(root, anchor.file), "utf8");
    const lines = text.split(/\r?\n/);
    if (anchor.startLine < 1 || anchor.endLine > lines.length) return undefined;
    return lines.slice(anchor.startLine - 1, anchor.endLine).join("\n");
  } catch {
    return undefined;
  }
}
