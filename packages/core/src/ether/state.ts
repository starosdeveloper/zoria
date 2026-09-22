import type { EtherWindow, Frame, Harbinger, NoiseReason, Phase, RollEntry } from './envelope.ts';

/** How many recent clock samples we keep; the estimate is their maximum. */
const CLOCK_SAMPLES = 24;

export interface EtherSnapshot {
  /** Phase from the newest verified frame; `unknown` until the first signal. */
  phase: Phase | 'unknown';
  latestAt: string | null;
  latestAtMs: number | null;
  window: EtherWindow | null;
  harbinger: Harbinger | null;
  /** Opening moment by the harbinger: frame `at` + `opensIn` (server clock, epoch ms). */
  opensAtMs: number | null;
  onAir: number | null;
  roll: RollEntry[] | null;
  rollAtMs: number | null;
  /** Letter fragments collected from sealed frames, by `n` (CL-35). */
  fragments: ReadonlyMap<number, string>;
  fragmentsOf: number | null;
  /** serverTime − deviceTime, ms; add to Date.now() to get server time. */
  clockOffsetMs: number;
  lastSignalLocalMs: number | null;
  counters: Readonly<Record<'signal' | 'stale' | NoiseReason | 'transport', number>>;
}

export const INITIAL_ETHER: EtherSnapshot = {
  phase: 'unknown',
  latestAt: null,
  latestAtMs: null,
  window: null,
  harbinger: null,
  opensAtMs: null,
  onAir: null,
  roll: null,
  rollAtMs: null,
  fragments: new Map(),
  fragmentsOf: null,
  clockOffsetMs: 0,
  lastSignalLocalMs: null,
  counters: { signal: 0, stale: 0, malformed: 0, 'unknown-key': 0, 'bad-seal': 0, 'bad-frame': 0, transport: 0 },
};

export type EtherEvent =
  | { type: 'signal'; frame: Frame; receivedAtLocalMs: number }
  | { type: 'noise'; reason: NoiseReason }
  | { type: 'transport' };

/**
 * Pure reducer over verified frames (spec §5.2 step 5, CL-05). Echo and delayed frames are
 * genuine but old: they may add fragments and clock samples, never move phase backwards.
 */
export class EtherTracker {
  private snapshot: EtherSnapshot = INITIAL_ETHER;
  private readonly clockSamples: number[] = [];

  get state(): EtherSnapshot {
    return this.snapshot;
  }

  /** Returns true when the event changed phase-relevant state (for logging/notifications). */
  apply(event: EtherEvent): { fresh: boolean; phaseChanged: boolean } {
    const prev = this.snapshot;
    if (event.type === 'noise') {
      this.snapshot = { ...prev, counters: { ...prev.counters, [event.reason]: prev.counters[event.reason] + 1 } };
      return { fresh: false, phaseChanged: false };
    }
    if (event.type === 'transport') {
      this.snapshot = { ...prev, counters: { ...prev.counters, transport: prev.counters.transport + 1 } };
      return { fresh: false, phaseChanged: false };
    }

    const { frame, receivedAtLocalMs } = event;
    const fragments = mergeFragment(prev.fragments, frame);
    const fragmentsOf = prev.fragmentsOf ?? frame.fragment?.of ?? null;
    const clockOffsetMs = this.sampleClock(frame.atMs - receivedAtLocalMs);
    const rollNewer = frame.roll !== null && (prev.rollAtMs === null || frame.atMs > prev.rollAtMs);

    const base: EtherSnapshot = {
      ...prev,
      fragments,
      fragmentsOf,
      clockOffsetMs,
      lastSignalLocalMs: receivedAtLocalMs,
      roll: rollNewer ? frame.roll : prev.roll,
      rollAtMs: rollNewer ? frame.atMs : prev.rollAtMs,
    };

    const isFresh = prev.latestAtMs === null || frame.atMs > prev.latestAtMs;
    if (!isFresh) {
      this.snapshot = { ...base, counters: { ...prev.counters, stale: prev.counters.stale + 1 } };
      return { fresh: false, phaseChanged: false };
    }

    this.snapshot = {
      ...base,
      phase: frame.phase,
      latestAt: frame.at,
      latestAtMs: frame.atMs,
      window: frame.window,
      harbinger: frame.harbinger,
      opensAtMs: harbingerOpensAt(frame),
      onAir: frame.onAir,
      counters: { ...prev.counters, signal: prev.counters.signal + 1 },
    };
    return { fresh: true, phaseChanged: prev.phase !== frame.phase };
  }

  /** Current server time estimate. */
  serverNow(deviceNow: number = Date.now()): number {
    return deviceNow + this.snapshot.clockOffsetMs;
  }

  // A frame's `at` is stamped before it is sent, and delay noise holds a frame 2–8 s,
  // so (at − receivedAt) only ever underestimates the true offset. The max over recent
  // samples is therefore the tightest estimate we have.
  private sampleClock(sample: number): number {
    this.clockSamples.push(sample);
    if (this.clockSamples.length > CLOCK_SAMPLES) this.clockSamples.shift();
    return Math.max(...this.clockSamples);
  }
}

function mergeFragment(fragments: ReadonlyMap<number, string>, frame: Frame): ReadonlyMap<number, string> {
  const f = frame.fragment;
  if (!f || f.n < 1 || f.n > f.of || fragments.has(f.n)) return fragments;
  const next = new Map(fragments);
  next.set(f.n, f.text);
  return next;
}

function harbingerOpensAt(frame: Frame): number | null {
  return frame.phase === 'static' && frame.harbinger ? frame.atMs + frame.harbinger.opensIn * 1000 : null;
}

/** Registration may go out: the newest sealed frame says `window`. */
export function isWindowOpen(state: EtherSnapshot): boolean {
  return state.phase === 'window';
}
