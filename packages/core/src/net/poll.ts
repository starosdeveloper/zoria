import { Backoff } from './backoff.ts';
import { isAbortError, sleep } from '../util/time.ts';

/** What one poll tick tells the loop to do next. */
export type TickOutcome =
  /** Success: wait the regular interval, reset backoff. */
  | { next: 'interval' }
  /** Transient failure (CL-09): wait the next full-jitter delay. */
  | { next: 'backoff' }
  /** Server told us when (429 Retry-After, jam silence): wait exactly until then. */
  | { next: 'at'; at: number };

export interface PollOptions {
  intervalMs: number;
  tick: (signal: AbortSignal) => Promise<TickOutcome>;
  signal: AbortSignal;
  /** Small spread so several loops do not fire in the same millisecond. */
  jitterMs?: number;
  onError?: (error: unknown) => void;
  now?: () => number;
}

/**
 * Runs `tick` until the signal aborts. The loop is the only owner of its timer, so
 * aborting the signal is enough to release everything (no escaping async work).
 */
export async function runPoll(options: PollOptions): Promise<void> {
  const backoff = new Backoff();
  const now = options.now ?? Date.now;
  // Read through a function: TS narrows the property after the loop check and would call later reads dead code.
  const aborted = (): boolean => options.signal.aborted;
  while (!aborted()) {
    let outcome: TickOutcome;
    try {
      outcome = await options.tick(options.signal);
    } catch (error) {
      if (isAbortError(error) || aborted()) return;
      options.onError?.(error);
      outcome = { next: 'backoff' };
    }
    let wait: number;
    switch (outcome.next) {
      case 'interval':
        backoff.reset();
        wait = options.intervalMs + Math.floor(Math.random() * (options.jitterMs ?? 0));
        break;
      case 'backoff':
        // A retry is still a request to the same route: never faster than its polling floor (CL-08).
        wait = Math.max(backoff.next(), options.intervalMs);
        break;
      case 'at':
        wait = Math.max(0, outcome.at - now());
        break;
    }
    try {
      await sleep(wait, options.signal);
    } catch (error) {
      if (isAbortError(error) || aborted()) return;
      throw error;
    }
  }
}
