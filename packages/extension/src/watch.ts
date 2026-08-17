/**
 * Notice when the other writer changes the store.
 *
 * The editor re-read only when you switched files, so a note an agent wrote
 * while you sat in one file stayed invisible until you happened to move. "Two
 * writers, one store" was true of the data and not of what you could see.
 *
 * Nothing here imports `vscode`: the watching is a subscription and a redraw,
 * both handed in, so the timing rules below can be tested without launching an
 * editor. `extension.ts` supplies a real file-system watcher.
 */

/** How long the store must sit still before a redraw is worth doing. */
export const DEFAULT_QUIET_MS = 250;

export interface WatchDeps {
  /**
   * Subscribe to changes under the store directory. Returns the unsubscribe.
   *
   * One logical write can raise several events — the store writes a temp file
   * and renames it, and a set moving between files touches two of them — which
   * is exactly why the handler below does not redraw per event.
   */
  onChange: (handler: () => void) => () => void;
  /** Re-read the store and redraw whatever shows it. */
  refresh: () => Promise<void>;
  /** Told about a refresh that failed, rather than the failure vanishing. */
  onError?: (error: unknown) => void;
  /** Quiet period before redrawing. Defaults to {@link DEFAULT_QUIET_MS}. */
  quietMs?: number;
  /** Injected so a test can state a delay instead of waiting one. */
  delay?: (ms: number) => Promise<void>;
}

/**
 * Redraw after the store settles, and stop when disposed.
 *
 * Three rules, and each one is a way this goes wrong on a shared extension
 * host:
 *
 * - **Wait for quiet.** An agent writing twenty notes is twenty events. Each
 *   one restarts the wait, so it costs one redraw rather than twenty.
 * - **Never overlap.** A redraw reads every annotated file. A second one
 *   starting underneath the first would double that work and could draw a
 *   half-read store; changes arriving mid-refresh take another turn instead.
 * - **Survive a failure.** A store caught mid-write reads as broken JSON, and
 *   the next event fixes it. One bad read must not end the watching.
 */
export function watchStore(deps: WatchDeps): () => void {
  const quietMs = deps.quietMs ?? DEFAULT_QUIET_MS;
  const delay = deps.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let pending = false;
  let running = false;
  let disposed = false;

  const drain = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      while (pending) {
        pending = false;
        await delay(quietMs);
        // The only disposal check that does anything. Testing it in the loop
        // condition as well reads as care and can never come out differently:
        // whatever gets past there arrives here before anything is drawn.
        if (disposed) return;
        // Something landed while we waited: start the quiet period again
        // rather than redrawing on top of a write still in progress.
        if (pending) continue;
        try {
          await deps.refresh();
        } catch (error) {
          deps.onError?.(error);
        }
      }
    } finally {
      running = false;
    }
  };

  const unsubscribe = deps.onChange(() => {
    if (disposed) return;
    pending = true;
    void drain();
  });

  return () => {
    disposed = true;
    unsubscribe();
  };
}
