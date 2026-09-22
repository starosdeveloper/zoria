import type { ApiClient } from '../api/client.ts';
import { classify } from '../api/http.ts';
import type { Failure } from '../api/result.ts';
import type { TickOutcome } from '../net/poll.ts';
import { unknownValue } from '../util/guard.ts';
import { verifyEnvelopeText, type Verdict } from './envelope.ts';
import type { KeyRing } from './keyring.ts';
import { EtherTracker, type EtherSnapshot } from './state.ts';

/** Polling floors (CL-08). */
export const ETHER_INTERVAL_MS = 15_000;
export const ROLL_INTERVAL_MS = 60_000;

export interface EtherObservation {
  verdict: Verdict | { kind: 'transport'; failure: Failure };
  fresh: boolean;
  phaseChanged: boolean;
  state: EtherSnapshot;
}

/**
 * Owns the verified view of the ether. Any envelope seen anywhere — `/ether`, `/ether/roll`,
 * or a 503 from another route before the window — goes through `ingest`, so one sealed
 * frame is one source of truth no matter which request caught it.
 */
export class EtherMonitor {
  readonly tracker = new EtherTracker();
  private readonly api: ApiClient;
  private readonly keys: KeyRing;
  private readonly listeners = new Set<(o: EtherObservation) => void>();

  constructor(api: ApiClient, keys: KeyRing) {
    this.api = api;
    this.keys = keys;
  }

  get state(): EtherSnapshot {
    return this.tracker.state;
  }

  subscribe(listener: (o: EtherObservation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async ingest(body: string, receivedAtLocalMs: number): Promise<EtherObservation> {
    const verdict = await verifyEnvelopeText(body, this.keys);
    const effect =
      verdict.kind === 'signal'
        ? this.tracker.apply({ type: 'signal', frame: verdict.frame, receivedAtLocalMs })
        : this.tracker.apply({ type: 'noise', reason: verdict.reason });
    return this.emit({ verdict, ...effect, state: this.tracker.state });
  }

  /** One poll of `/ether` or `/ether/roll`; tells the loop how long to wait next. */
  async poll(path: '/ether' | '/ether/roll', signal?: AbortSignal): Promise<TickOutcome> {
    await this.keys.ensure();
    const sent = await this.api.etherRaw(path, signal);
    const receivedAt = Date.now();
    if (!sent.ok) return this.transportFailure(sent.error);

    const { raw } = sent;
    if (raw.status === 429) {
      const classified = classify(raw, { status: 200, read: unknownValue });
      if (!classified.ok && classified.error.kind === 'throttled') {
        this.transportFailure(classified.error);
        return { next: 'at', at: Date.now() + classified.error.retryAfterSec * 1000 + 1_500 };
      }
    }
    // 5xx with a stable error code and Retry-After: the node is silent (503 stopping) or restarting.
    // That is not a frame at all, so it is not counted as noise; wait as told, never faster than the floor.
    if (raw.status >= 500) {
      const classified = classify(raw, { status: 200, read: unknownValue });
      if (!classified.ok && classified.error.kind === 'server' && classified.error.code !== null) {
        this.transportFailure(classified.error);
        const retry = classified.error.retryAfterSec;
        return retry === null ? { next: 'backoff' } : { next: 'at', at: Date.now() + Math.max(retry * 1000, ETHER_INTERVAL_MS) };
      }
    }
    // Any other status/body is either an envelope or noise; the seal decides (CL-02).
    const observation = await this.ingest(raw.text, receivedAt);
    // A transport-level reset through a proxy shows as 502 without envelope: that is noise
    // before the window and an outage after it — either way keep the regular pace.
    return observation.verdict.kind === 'signal' || raw.status < 500 ? { next: 'interval' } : { next: 'backoff' };
  }

  private transportFailure(failure: Failure): TickOutcome {
    // Only 503 means a silent node: noise may fake 500/502/504 bodies with real codes, never 503.
    if (failure.kind === 'server' && failure.status === 503 && failure.code !== null) {
      this.tracker.apply({ type: 'silent', code: failure.code, retryAfterSec: failure.retryAfterSec, atLocalMs: Date.now() });
    } else {
      this.tracker.apply({ type: 'transport' });
    }
    this.emit({ verdict: { kind: 'transport', failure }, fresh: false, phaseChanged: false, state: this.tracker.state });
    if (failure.kind === 'silenced') return { next: 'at', at: failure.until };
    return { next: 'backoff' };
  }

  private emit(observation: EtherObservation): EtherObservation {
    for (const listener of this.listeners) listener(observation);
    return observation;
  }
}
