import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { STALE_LOCK_MS, withStoreLock } from "../src/lock.js";

/**
 * Keeping two processes out of the store at once.
 *
 * Every case here is a way a lock stops being one: handed to two callers,
 * never released, or taken away from somebody still holding it.
 */

let dir: string;
let storePath: string;

const lockPath = (): string => join(dirname(storePath), ".lock");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "acc-lock-"));
  storePath = join(dir, ".acciaccatura", "annotations.json");
  await mkdir(dirname(storePath), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("withStoreLock", () => {
  it("runs the work and hands back its result", async () => {
    expect(await withStoreLock(storePath, async () => 42)).toBe(42);
  });

  it("lets go afterwards", async () => {
    await withStoreLock(storePath, async () => undefined);
    await expect(stat(lockPath())).rejects.toThrow();
  });

  it("lets go after the work throws", async () => {
    // A lock left behind by an error would stall every later write until it
    // aged out, turning one failure into ten seconds of silence.
    await expect(withStoreLock(storePath, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(stat(lockPath())).rejects.toThrow();
  });

  it("never lets two callers in at once", async () => {
    let inside = 0;
    let both = false;
    const work = async () => {
      inside++;
      if (inside > 1) both = true;
      await new Promise((r) => setTimeout(r, 15));
      inside--;
    };

    await Promise.all(Array.from({ length: 8 }, () => withStoreLock(storePath, work)));
    expect(both).toBe(false);
  });

  it("runs them all, not just the first", async () => {
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => withStoreLock(storePath, async () => { order.push(i); })),
    );
    expect(order.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("takes over a lock nobody has touched for long enough", async () => {
    // A process that died holding it must not wedge the store for good.
    const path = lockPath();
    await withStoreLock(storePath, async () => undefined);
    await writeFile(path, JSON.stringify({ pid: 999999, at: Date.now() - STALE_LOCK_MS - 1000 }), "utf8");
    const old = Date.now() - STALE_LOCK_MS - 1000;
    await utimes(path, new Date(old), new Date(old));

    await expect(withStoreLock(storePath, async () => "got in")).resolves.toBe("got in");
  });

  it("does not take over a lock that was only just created", async () => {
    // `wx` creates the file and fills it in as a second step, so a lock taken
    // a microsecond ago can still be empty. Reading that as rubbish and
    // clearing it hands the store to two writers, which is the bug this whole
    // file exists to prevent — and it only showed under real contention.
    await writeFile(lockPath(), "", { encoding: "utf8", flag: "wx" });

    const start = Date.now();
    await expect(withStoreLock(storePath, async () => undefined)).rejects.toThrow(/Timed out/);
    // It waited rather than walking straight in.
    expect(Date.now() - start).toBeGreaterThan(100);
    // Longer than the lock's own wait, or the test gives up before it does.
  }, 10_000);

  it("says who to blame when it cannot get in", async () => {
    await writeFile(lockPath(), JSON.stringify({ pid: 1, at: Date.now() }), { encoding: "utf8", flag: "wx" });
    await expect(withStoreLock(storePath, async () => undefined)).rejects.toThrow(/another process|delete the file/i);
  }, 10_000);

  it("leaves nothing behind in the store directory", async () => {
    await withStoreLock(storePath, async () => undefined);
    // The lock sits beside the store rather than inside it, and it goes when
    // it is done: nothing here should ever be mistaken for annotation data.
    expect(await readdir(dirname(storePath))).toEqual([]);
  });
});
