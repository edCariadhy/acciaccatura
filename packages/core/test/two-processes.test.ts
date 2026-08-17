import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Two writers, one store — the claim, tested against two real processes.
 *
 * The editor and the MCP server are separate processes. Ordering a process's
 * own writes does not help across that boundary, and neither does re-reading
 * before writing: the gap that loses notes is *after* the read, when the other
 * writer saves between your read and your rename and you then save a list that
 * never knew about it.
 *
 * Measured before the lock existed: two writers 40 ms apart lost one writer's
 * notes in full, five runs out of five. That is the number this file exists to
 * keep at zero.
 *
 * It spawns processes on purpose. Two `AnnotationStore` instances inside one
 * process share a write queue and pass happily, which is exactly the false
 * assurance that let this survive so long.
 */

const SRC = fileURLToPath(new URL("../src/store.ts", import.meta.url));
const BUILT = fileURLToPath(new URL("../dist/store.js", import.meta.url));

/**
 * A child process cannot use the source the way the rest of the suite does.
 * Vitest aliases `@acciaccatura/core` to TypeScript, and Node can strip types
 * but will not resolve the `.js` specifiers that source is written with. So
 * the writers run the build, and the build is made if it is missing or older
 * than the source — the suite still needs nothing done to it first.
 */
async function ensureBuilt(): Promise<void> {
  const [src, built] = await Promise.all([
    stat(SRC),
    stat(BUILT).catch(() => undefined),
  ]);
  if (built && built.mtimeMs >= src.mtimeMs) return;

  await new Promise<void>((resolve, reject) => {
    const tsc = spawn("npm", ["run", "build", "--workspace", "@acciaccatura/core"], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    tsc.stderr.on("data", (c) => (err += c));
    tsc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`build failed: ${err}`))));
  });
}

let dir: string;
let storePath: string;
let writerPath: string;

beforeAll(async () => {
  await ensureBuilt();
}, 120_000);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "acc-two-"));
  storePath = join(dir, ".acciaccatura", "annotations.json");
  writerPath = join(dir, "writer.mjs");
  // Run against the TypeScript source, so the suite needs no prior build —
  // the same reason the vitest configs alias the core package to it.
  await writeFile(
    writerPath,
    `
    import { AnnotationStore } from ${JSON.stringify(BUILT)};
    const [path, tag, count, gap] = process.argv.slice(2);
    const store = new AnnotationStore(path);
    await store.load();
    for (let i = 0; i < Number(count); i++) {
      if (Number(gap) > 0) await new Promise((r) => setTimeout(r, Number(gap)));
      await store.add({
        body: tag + "-" + i,
        anchor: { file: "src/a.ts", startLine: 1, endLine: 1, snapshot: "x" },
        provenance: tag === "A" ? "human" : "agent",
      });
    }
    `,
    "utf8",
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Run one writer to completion, as its own process. */
function writer(tag: string, count: number, gap: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [writerPath, storePath, tag, String(count), String(gap)],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`writer ${tag} failed: ${stderr}`)),
    );
  });
}

/** Every note body on disk, across the shared file and any set files. */
async function bodiesOnDisk(): Promise<Set<string>> {
  const root = dirname(storePath);
  const found = new Set<string>();
  const read = async (file: string): Promise<void> => {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as { annotations?: Array<{ body: string }> };
      for (const a of parsed.annotations ?? []) found.add(a.body);
    } catch {
      /* not a store file */
    }
  };
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const inner of await readdir(join(root, entry.name))) await read(join(root, entry.name, inner));
    } else {
      await read(join(root, entry.name));
    }
  }
  return found;
}

describe("two processes writing to one store", () => {
  it("loses nothing when both write at a human pace", async () => {
    await Promise.all([writer("A", 5, 40), writer("B", 5, 40)]);

    const found = await bodiesOnDisk();
    const missing = [
      ...Array.from({ length: 5 }, (_, i) => `A-${i}`),
      ...Array.from({ length: 5 }, (_, i) => `B-${i}`),
    ].filter((b) => !found.has(b));

    // Before the lock this failed every run, and not by one note: one writer's
    // whole contribution was gone.
    expect(missing).toEqual([]);
  }, 30_000);

  it("loses nothing when both write flat out", async () => {
    await Promise.all([writer("A", 20, 0), writer("B", 20, 0), writer("C", 20, 0)]);

    const found = await bodiesOnDisk();
    const expected = ["A", "B", "C"].flatMap((t) => Array.from({ length: 20 }, (_, i) => `${t}-${i}`));
    expect(expected.filter((b) => !found.has(b))).toEqual([]);
  }, 30_000);

  it("leaves no lock behind once everyone is done", async () => {
    await Promise.all([writer("A", 3, 0), writer("B", 3, 0)]);
    // A lock left lying about would stall the next write until it aged out.
    expect(await readdir(dirname(storePath))).not.toContain(".lock");
  }, 30_000);
});
