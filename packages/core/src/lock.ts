import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Keep two processes out of the store at the same time.
 *
 * The editor and the MCP server both read the whole store, change it, and save
 * it back. Ordering a process's own writes does not help — that is one queue
 * per process — and neither does checking that nothing moved since the read:
 * that catches "somebody wrote before me", and the case that loses notes is
 * "somebody is writing at the same moment as me". Two writers on a similar
 * cadence fall into step, both find the file unchanged, and both save. Measured
 * on a store with two writers 40 ms apart, one writer's notes were lost in full,
 * five runs out of five.
 *
 * So this is a real lock and not an optimistic one. `wx` either creates the
 * file or fails, in one step the kernel will not split, which is the only
 * primitive here that two processes can agree on.
 */

/** How long a lock may be held before it is assumed to be a crash. */
export const STALE_LOCK_MS = 10_000;

/** Longest a caller waits to get in before giving up. */
const ACQUIRE_TIMEOUT_MS = 5_000;

/** Upper bound on the pause between attempts. */
const RETRY_MS = 20;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run `work` with the store to yourself.
 *
 * The lock sits beside the store file rather than inside it, so it is never
 * mistaken for data and never committed by accident.
 */
export async function withStoreLock<T>(storePath: string, work: () => Promise<T>): Promise<T> {
  const lockPath = join(dirname(storePath), ".lock");
  await mkdir(dirname(storePath), { recursive: true });

  const until = Date.now() + ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      // `wx` fails when the file is already there. Create-if-absent has to be
      // one operation, or two processes both look, both find nothing, and both
      // decide they hold it.
      await writeFile(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }), {
        encoding: "utf8",
        flag: "wx",
      });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // A process that died holding the lock must not wedge the store for
      // good, so a lock nobody has touched for long enough is taken away.
      if (await isStale(lockPath)) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() > until) {
        // The EEXIST that put us here is the evidence, so it travels with the
        // message rather than being swallowed by it.
        throw new Error(
          `Timed out waiting for ${lockPath}. Another process is writing to this store; delete the file if nothing is.`,
          { cause: err },
        );
      }
      await sleep(Math.random() * RETRY_MS);
    }
  }

  try {
    return await work();
  } finally {
    // Released even when the work threw. A lock left behind by an error would
    // stall every later write until it went stale.
    await rm(lockPath, { force: true });
  }
}

/**
 * Whether a lock has been held long enough to count as abandoned.
 *
 * Age comes from the file's own timestamp, never from what is written inside
 * it. `wx` creates the file and fills it in as a second step, so a lock taken
 * a microsecond ago can still be empty — and an earlier version of this read
 * that empty file, failed to parse it, called it rubbish and deleted a lock
 * somebody was holding. Two writers were then inside at once, which is the
 * whole thing this exists to prevent. Only high contention showed it: four
 * processes flat out lost a few notes a round, scattered, with every write
 * reporting success.
 */
async function isStale(lockPath: string): Promise<boolean> {
  try {
    const held = await stat(lockPath);
    return Date.now() - held.mtimeMs > STALE_LOCK_MS;
  } catch (err) {
    // Gone while we looked: released, so not stale — free.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
