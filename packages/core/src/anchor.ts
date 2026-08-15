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

/**
 * Attempt to find a drifted anchor in the current file text.
 * Uses a line-based sliding window, ignoring whitespace, to find the highest matching block.
 * If the best match exceeds a similarity threshold (e.g., 80%), returns an updated Anchor.
 * Otherwise, returns undefined, meaning the anchor is permanently lost ("degrade loudly").
 */
export function reanchor(anchor: Anchor, currentFileText: string): Anchor | undefined {
  const originalLines = normalizeSnapshot(anchor.snapshot).split("\n");
  const currentLines = currentFileText.split(/\r?\n/);
  
  const windowSize = originalLines.length;
  if (currentLines.length < windowSize || windowSize === 0) return undefined;

  // Strip all whitespace for robust comparison
  const normalizeForMatch = (line: string) => line.replace(/\s+/g, "");
  const normalizedOriginal = originalLines.map(normalizeForMatch);
  
  let bestMatchIndex = -1;
  let bestMatchScore = -1;

  for (let i = 0; i <= currentLines.length - windowSize; i++) {
    let currentScore = 0;
    for (let j = 0; j < windowSize; j++) {
      const currentLine = currentLines[i + j] ?? "";
      if (normalizedOriginal[j] === normalizeForMatch(currentLine)) {
        currentScore++;
      }
    }
    
    if (currentScore > bestMatchScore) {
      bestMatchScore = currentScore;
      bestMatchIndex = i;
    }
  }

  const similarity = bestMatchScore / windowSize;
  
  // Require at least 80% similarity. For 1-4 line snippets, requires 100%.
  const threshold = windowSize < 5 ? 1.0 : 0.8;
  if (similarity >= threshold) {
    const newSnapshotLines = currentLines.slice(bestMatchIndex, bestMatchIndex + windowSize);
    const newSnapshot = newSnapshotLines.join("\n");
    return {
      ...anchor,
      startLine: bestMatchIndex + 1, // 1-based
      endLine: bestMatchIndex + windowSize,
      snapshot: newSnapshot,
      snapshotHash: fingerprint(newSnapshot)
    };
  }

  return undefined;
}
