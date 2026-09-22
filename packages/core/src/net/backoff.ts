/** Exponential backoff with full jitter (CL-09): uniform in [0, min(60 s, 1 s × 2^n)]. */
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 60_000;

export function fullJitterDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
  return Math.floor(random() * ceiling);
}

/** Counter of consecutive failures; reset after a success. */
export class Backoff {
  private attempt = 0;
  private readonly random: () => number;

  constructor(random: () => number = Math.random) {
    this.random = random;
  }

  get failures(): number {
    return this.attempt;
  }

  next(): number {
    const delay = fullJitterDelay(this.attempt, this.random);
    this.attempt = Math.min(this.attempt + 1, 30);
    return delay;
  }

  reset(): void {
    this.attempt = 0;
  }
}
