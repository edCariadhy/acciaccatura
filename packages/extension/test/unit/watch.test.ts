import { describe, expect, it, vi } from "vitest";

import { watchStore } from "../../src/watch.js";

/**
 * The editor re-read only when you switched files, so a note an agent wrote
 * while you sat still stayed invisible. Watching fixes that, and every rule
 * here is a way watching goes wrong on a shared extension host: a redraw per
 * event, two redraws at once, or one bad read ending the watching for good.
 */

/** A subscription a test can fire by hand, plus the timing hooks. */
function harness(over: { refresh?: () => Promise<void> } = {}) {
  let handler: (() => void) | undefined;
  const unsubscribe = vi.fn();
  const waits: Array<() => void> = [];

  const refresh = vi.fn(over.refresh ?? (async () => undefined));
  const onError = vi.fn();

  const dispose = watchStore({
    onChange: (h) => {
      handler = h;
      return unsubscribe;
    },
    refresh,
    onError,
    quietMs: 10,
    // Every wait parks until the test lets it through, so nothing here sleeps.
    delay: () => new Promise<void>((resolve) => waits.push(resolve)),
  });

  return {
    fire: () => handler?.(),
    /** Let the pending quiet period elapse and give the loop a turn. */
    elapse: async () => {
      waits.splice(0).forEach((w) => w());
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    waiting: () => waits.length,
    refresh,
    onError,
    unsubscribe,
    dispose,
  };
}

describe("watching the store", () => {
  it("redraws once after a change", async () => {
    const h = harness();
    h.fire();
    await h.elapse();
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not redraw before the store has settled", async () => {
    const h = harness();
    h.fire();
    // The quiet period has not elapsed, so nothing has been drawn yet.
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("costs one redraw for a burst, not one per event", async () => {
    const h = harness();
    // An agent writing twenty notes is at least twenty events, and one logical
    // write is already several: a temp file, a rename, and a second file when
    // a note moves between sets.
    for (let i = 0; i < 20; i++) h.fire();
    await h.elapse();
    await h.elapse();
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("starts the wait again when a change lands during it", async () => {
    const h = harness();
    h.fire();
    h.fire();
    await h.elapse();
    // The second event reset the quiet period rather than being drawn on top
    // of a write that may still be in progress.
    expect(h.refresh).not.toHaveBeenCalled();
    await h.elapse();
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("never runs two redraws at once", async () => {
    let inFlight = 0;
    let overlapped = false;
    let release: (() => void) | undefined;
    const h = harness({
      refresh: () => {
        inFlight++;
        if (inFlight > 1) overlapped = true;
        return new Promise<void>((r) => {
          release = () => {
            inFlight--;
            r();
          };
        });
      },
    });

    h.fire();
    await h.elapse();
    // A change arrives while the first redraw is still reading files.
    h.fire();
    await h.elapse();
    release?.();
    await h.elapse();

    // A redraw reads every annotated file. Two at once would double that and
    // could draw from a store only half re-read.
    expect(overlapped).toBe(false);
  });

  it("picks up a change that arrived mid-redraw", async () => {
    let release: (() => void) | undefined;
    const h = harness({
      refresh: () => new Promise<void>((r) => { release = r; }),
    });

    h.fire();
    await h.elapse();
    h.fire();            // lands while the first redraw is still running
    release?.();
    await h.elapse();
    await h.elapse();

    // Refusing to overlap must not mean dropping it: the note written during
    // that redraw would stay invisible, which is the bug being fixed.
    expect(h.refresh).toHaveBeenCalledTimes(2);
  });

  it("keeps watching after a redraw fails", async () => {
    let calls = 0;
    const h = harness({
      refresh: async () => {
        calls++;
        if (calls === 1) throw new Error("store caught mid-write");
      },
    });

    h.fire();
    await h.elapse();
    expect(h.onError).toHaveBeenCalledTimes(1);

    // A store read during a write is broken JSON, and the very next event is
    // the one that fixes it. One bad read must not end the watching.
    h.fire();
    await h.elapse();
    expect(h.refresh).toHaveBeenCalledTimes(2);
  });

  it("says a redraw failed instead of losing it", async () => {
    const boom = new Error("bad json");
    const h = harness({ refresh: async () => { throw boom; } });
    h.fire();
    await h.elapse();
    expect(h.onError).toHaveBeenCalledWith(boom);
  });

  it("stops watching when disposed", async () => {
    const h = harness();
    h.dispose();
    expect(h.unsubscribe).toHaveBeenCalled();
    h.fire();
    await h.elapse();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("does not redraw after being disposed mid-wait", async () => {
    const h = harness();
    h.fire();
    h.dispose();
    await h.elapse();
    // The window is closing. Drawing into it is at best wasted work.
    expect(h.refresh).not.toHaveBeenCalled();
  });
});
