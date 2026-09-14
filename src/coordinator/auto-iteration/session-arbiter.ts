/**
 * Per-Session turn arbiter: at most one in-flight turn entry per Session,
 * different Sessions fully parallel. Manual input, automatic inbox wakeup,
 * and `/auto-continue` share this one entry point instead of reusing a
 * Project-wide submission tail (issue #8 §3: short transactions serialize,
 * runtimes parallel, same-Session arbitration).
 */

export type ArbitratedTurnSource = "manual-input" | "auto-wakeup" | "auto-continue";

export interface SessionTurnArbiter {
  /**
   * Runs `task` after every earlier entry for the same Session settled.
   * Entries for different Sessions never wait on each other.
   */
  submit<T>(sessionId: string, source: ArbitratedTurnSource, task: () => Promise<T>): Promise<T>;
  /** True while an entry for this Session has not settled yet. */
  busy(sessionId: string): boolean;
  /** Stops accepting new entries and waits for the in-flight ones. */
  close(): Promise<void>;
}

export function createSessionTurnArbiter(): SessionTurnArbiter {
  const tails = new Map<string, Promise<void>>();
  let closing = false;

  return Object.freeze({
    submit<T>(sessionId: string, _source: ArbitratedTurnSource, task: () => Promise<T>): Promise<T> {
      if (closing) {
        return Promise.reject(new Error("session-arbiter-closed"));
      }
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return Promise.reject(new Error("invalid-session-id"));
      }
      const prior = tails.get(sessionId) ?? Promise.resolve();
      const run = prior.then(task);
      const tail = run.then(
        () => undefined,
        () => undefined,
      );
      tails.set(sessionId, tail);
      void tail.then(() => {
        // Only drop the tail when nothing newer queued behind it.
        if (tails.get(sessionId) === tail) tails.delete(sessionId);
      });
      return run;
    },
    busy(sessionId: string): boolean {
      return tails.has(sessionId);
    },
    async close(): Promise<void> {
      closing = true;
      await Promise.allSettled([...tails.values()]);
      tails.clear();
    },
  });
}
