import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AnnotationStore } from "@acciaccatura/core";
import type { CapturedSelection } from "@acciaccatura/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { captureAnnotation } from "../../src/capture.js";

const selection: CapturedSelection = {
  file: "src/math.ts",
  startLine: 1,
  endLine: 2,
  snapshot: "export function add(a, b) {\n  return a + b;",
};

let dir: string;
let store: AnnotationStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "acc-ext-"));
  store = new AnnotationStore(join(dir, ".acciaccatura", "annotations.json"));
  await store.load();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("captureAnnotation", () => {
  it("writes a human-provenance annotation from a selection + note", async () => {
    const notify = vi.fn();
    const id = await captureAnnotation({
      getSelection: () => selection,
      promptForBody: async () => "add() is pure — keep it side-effect free.",
      store,
      notify,
    });

    expect(id).toBeDefined();
    const saved = store.get(id!);
    expect(saved?.provenance).toBe("human");
    expect(saved?.trust).toBe("authoritative"); // human default
    expect(saved?.anchor.file).toBe("src/math.ts");
    expect(notify).toHaveBeenCalledWith("info", expect.stringContaining("src/math.ts:1-2"));
  });

  it("warns and writes nothing when there is no selection", async () => {
    const notify = vi.fn();
    const id = await captureAnnotation({
      getSelection: () => undefined,
      promptForBody: async () => "unused",
      store,
      notify,
    });

    expect(id).toBeUndefined();
    expect(store.all()).toHaveLength(0);
    expect(notify).toHaveBeenCalledWith("warn", expect.stringMatching(/select/i));
  });

  it("writes nothing when the user cancels the prompt", async () => {
    const notify = vi.fn();
    const id = await captureAnnotation({
      getSelection: () => selection,
      promptForBody: async () => undefined, // cancelled
      store,
      notify,
    });

    expect(id).toBeUndefined();
    expect(store.all()).toHaveLength(0);
  });

  it("warns and writes nothing when the note is empty", async () => {
    const notify = vi.fn();
    const id = await captureAnnotation({
      getSelection: () => selection,
      promptForBody: async () => "   ",
      store,
      notify,
    });

    expect(id).toBeUndefined();
    expect(store.all()).toHaveLength(0);
    expect(notify).toHaveBeenCalledWith("warn", expect.stringMatching(/empty/i));
  });
});
