import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AnnotationStore } from "@acciaccatura/core";
import type { Annotation, NewAnnotation, ScopeIndexEntry } from "@acciaccatura/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addNoteToScope, checkScope, closeScope, deleteScope } from "../../src/scopes.js";

/**
 * The set-level flows a person runs from the editor, tested without a running
 * `vscode` host — the same seam `capture.ts` and `lifecycle.ts` use.
 *
 * Everything about scopes was agent-only until now: an agent could read a set,
 * check it and close it over MCP, and a person could do none of those.
 */

const CODE = "export function pay(a) {\n  return a * 2;\n}\n";

let dir: string;
let store: AnnotationStore;

function draft(over: Partial<NewAnnotation> = {}): NewAnnotation {
  return {
    body: "why this exists",
    provenance: "human",
    anchor: { file: "src/pay.ts", startLine: 2, endLine: 2, snapshot: "  return a * 2;" },
    ...over,
  };
}

function deps(over: Record<string, unknown> = {}) {
  return {
    store,
    workspaceRoot: dir,
    chooseScope: vi.fn(async (scopes: readonly ScopeIndexEntry[]) => scopes[0]?.scope),
    chooseNote: vi.fn(async (candidates: readonly Annotation[]) => candidates[0]),
    askScopeName: vi.fn(async () => "pr/142"),
    confirmClose: vi.fn(async () => true),
    confirmDelete: vi.fn(async () => true),
    notify: vi.fn(),
    ...over,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "acc-scopes-ui-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "pay.ts"), CODE, "utf8");
  store = new AnnotationStore(join(dir, ".acciaccatura", "annotations.json"));
  await store.load();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("closing a set from the editor", () => {
  it("finishes every open note in the set the sidebar picked", async () => {
    await store.add(draft({ scope: "pr/142", order: 1 }));
    await store.add(draft({ scope: "pr/142", order: 2 }));
    const d = deps();

    expect(await closeScope(d, "pr/142")).toBe(2);
    expect(store.query({ scope: "pr/142" })).toHaveLength(0);
  });

  it("records that a person closed it, not an agent", async () => {
    const note = await store.add(draft({ scope: "pr/142", order: 1 }));
    await closeScope(deps(), "pr/142");

    // Two writers, one store: who ended the work is part of the record.
    expect(store.get(note.id)?.resolvedBy).toBe("human");
  });

  it("asks which set when the command came from the palette", async () => {
    await store.add(draft({ scope: "pr/142", order: 1 }));
    const d = deps();

    await closeScope(d);
    expect(d.chooseScope).toHaveBeenCalled();
  });

  it("asks before closing, because a set can hold many notes", async () => {
    await store.add(draft({ scope: "pr/142", order: 1 }));
    const d = deps({ confirmClose: vi.fn(async () => false) });

    expect(await closeScope(d, "pr/142")).toBe(0);
    expect(store.query({ scope: "pr/142" })).toHaveLength(1);
  });

  it("says how many notes are at stake when it asks", async () => {
    await store.add(draft({ scope: "pr/142", order: 1 }));
    await store.add(draft({ scope: "pr/142", order: 2 }));
    const d = deps();

    await closeScope(d, "pr/142");
    expect(d.confirmClose).toHaveBeenCalledWith("pr/142", 2);
  });

  it("does not ask at all when the set has nothing open", async () => {
    const done = await store.add(draft({ scope: "pr/142", order: 1 }));
    await store.resolve(done.id, "agent");
    const d = deps();

    expect(await closeScope(d, "pr/142")).toBe(0);
    expect(d.confirmClose).not.toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledWith("info", expect.stringMatching(/nothing|no open/i));
  });

  it("says there are no sets rather than opening an empty picker", async () => {
    await store.add(draft());
    const d = deps();

    expect(await closeScope(d)).toBe(0);
    expect(d.chooseScope).not.toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledWith("info", expect.stringMatching(/no (named )?sets/i));
  });

  it("writes nothing when the user backs out of the picker", async () => {
    await store.add(draft({ scope: "pr/142", order: 1 }));
    const d = deps({ chooseScope: vi.fn(async () => undefined) });

    expect(await closeScope(d)).toBe(0);
    expect(store.query({ scope: "pr/142" })).toHaveLength(1);
  });

  it("sees a set an agent created since the sidebar last drew", async () => {
    // The MCP server writes to the same file while the editor is open.
    const agent = new AnnotationStore(join(dir, ".acciaccatura", "annotations.json"));
    await agent.load();
    await agent.add(draft({ scope: "pr/999", order: 1, provenance: "agent" }));

    const d = deps();
    expect(await closeScope(d, "pr/999")).toBe(1);
  });
});

describe("deleting a set from the editor", () => {
  it("deletes every note in the set, open or finished", async () => {
    const done = await store.add(draft({ scope: "pr/142", order: 1 }));
    await store.add(draft({ scope: "pr/142", order: 2 }));
    await store.resolve(done.id, "human");
    const d = deps();

    expect(await deleteScope(d, "pr/142")).toBe(2);
    expect(store.query({ scope: "pr/142", includeResolved: true })).toHaveLength(0);
  });

  it("asks which set when the command came from the palette", async () => {
    await store.add(draft({ scope: "pr/142", order: 1 }));
    const d = deps();

    await deleteScope(d);
    expect(d.chooseScope).toHaveBeenCalled();
  });

  it("asks before deleting, because it cannot be undone", async () => {
    await store.add(draft({ scope: "pr/142", order: 1 }));
    const d = deps({ confirmDelete: vi.fn(async () => false) });

    expect(await deleteScope(d, "pr/142")).toBe(0);
    expect(store.query({ scope: "pr/142" })).toHaveLength(1);
  });

  it("says how many notes are at stake when it asks, counting finished ones too", async () => {
    const done = await store.add(draft({ scope: "pr/142", order: 1 }));
    await store.add(draft({ scope: "pr/142", order: 2 }));
    await store.resolve(done.id, "human");
    const d = deps();

    await deleteScope(d, "pr/142");
    expect(d.confirmDelete).toHaveBeenCalledWith(expect.stringMatching(/2/));
  });

  it("says there are no sets rather than opening an empty picker", async () => {
    await store.add(draft());
    const d = deps();

    expect(await deleteScope(d)).toBe(0);
    expect(d.chooseScope).not.toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledWith("info", expect.stringMatching(/no (named )?sets/i));
  });

  it("writes nothing when the user backs out of the picker", async () => {
    await store.add(draft({ scope: "pr/142", order: 1 }));
    const d = deps({ chooseScope: vi.fn(async () => undefined) });

    expect(await deleteScope(d)).toBe(0);
    expect(store.query({ scope: "pr/142" })).toHaveLength(1);
  });
});

describe("checking a set against the code", () => {
  it("counts the notes that still match, and those that do not", async () => {
    await store.add(draft({ scope: "pr/142", order: 1 }));
    const report = await checkScope(deps(), "pr/142");

    expect(report?.aligned).toBe(1);
    expect(report?.drifted).toBe(0);
    expect(report?.gone).toBe(0);
  });

  it("notices when the code a set points at has moved", async () => {
    await store.add(draft({ scope: "pr/142", order: 1 }));
    await writeFile(join(dir, "src", "pay.ts"), `// added\n// added\n${CODE}`, "utf8");

    expect((await checkScope(deps(), "pr/142"))?.drifted).toBe(1);
  });

  it("notices when the code is gone entirely", async () => {
    await store.add(draft({ scope: "pr/142", order: 1 }));
    await rm(join(dir, "src", "pay.ts"));

    expect((await checkScope(deps(), "pr/142"))?.gone).toBe(1);
  });

  it("tells the reader the counts, not a verdict", async () => {
    await store.add(draft({ scope: "pr/142", order: 1 }));
    const d = deps();
    await checkScope(d, "pr/142");

    const [[, message]] = d.notify.mock.calls as [[string, string]];
    expect(message).toMatch(/1 aligned/);
    expect(message).not.toMatch(/%|score/i);
  });

  it("reports nothing for a set that is not there", async () => {
    const d = deps();
    expect(await checkScope(d, "pr/nope")).toBeUndefined();
  });
});

describe("putting a note into a set", () => {
  it("moves the chosen note into the named set, keeping its id", async () => {
    const note = await store.add(draft());
    const d = deps();

    await addNoteToScope(d, note);
    expect(store.get(note.id)?.scope).toBe("pr/142");
    expect(store.all()).toHaveLength(1);
  });

  it("offers the sets that already exist, so names stay consistent", async () => {
    await store.add(draft({ scope: "onboarding/billing" }));
    const note = await store.add(draft());
    const d = deps();

    await addNoteToScope(d, note);
    expect(d.askScopeName).toHaveBeenCalledWith(["onboarding/billing"]);
  });

  it("puts the note at the end of the set it joins", async () => {
    await store.add(draft({ scope: "pr/142", order: 1 }));
    await store.add(draft({ scope: "pr/142", order: 2 }));
    const note = await store.add(draft());

    await addNoteToScope(deps(), note);
    // Guessing a place in someone's sequence would be worse than the end.
    expect(store.get(note.id)?.order).toBe(3);
  });

  it("starts the sequence at one for a set that is new", async () => {
    const note = await store.add(draft());
    await addNoteToScope(deps(), note);
    expect(store.get(note.id)?.order).toBe(1);
  });

  it("writes nothing when the user backs out of naming a set", async () => {
    const note = await store.add(draft());
    const d = deps({ askScopeName: vi.fn(async () => undefined) });

    await addNoteToScope(d, note);
    expect(store.get(note.id)?.scope).toBeUndefined();
  });

  it("degrades in the open when the note was removed by the other writer", async () => {
    const note = await store.add(draft());
    await store.remove(note.id);
    const d = deps();

    await addNoteToScope(d, note);
    expect(d.notify).toHaveBeenCalledWith("warn", expect.stringMatching(/gone|removed/i));
  });
});
