import type { KeyValueStore } from '../util/kv.ts';
import { tryParseJson } from '../util/json.ts';
import { readErrorBody } from '../api/types.ts';
import { sleep } from '../util/time.ts';

// Server-side limit (spec §5.6): bucket of 20 per address, +1 every 3 s, a request on an
// empty bucket or during jamming is a strike and doubles the jam. We keep a stricter local
// copy so the shared address still has room for other clients (four polite clients
// already drain the refill).
export const LOCAL_BUCKET_CAPACITY = 12;
export const LOCAL_REFILL_MS = 3_000;
/** Safety margin past Retry-After: the last second of a jam still answers 429 (spec §5.6). */
export const JAM_MARGIN_MS = 1_500;

export type Permit = { ok: true } | { ok: false; until: number };

interface GateSnapshot {
  silentUntil: number;
  tokens: number;
  refilledAt: number;
}

export interface GateOptions {
  store: KeyValueStore;
  storeKey: string;
  now?: () => number;
  capacity?: number;
  refillMs?: number;
}

/**
 * One gate per server. Every request passes through `acquire`; responses are fed back
 * through `observe`. State survives reloads so a refreshed tab cannot break the silence.
 */
export class RequestGate {
  private readonly now: () => number;
  private readonly capacity: number;
  private readonly refillMs: number;
  private state: GateSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly options: GateOptions;

  constructor(options: GateOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.capacity = options.capacity ?? LOCAL_BUCKET_CAPACITY;
    this.refillMs = options.refillMs ?? LOCAL_REFILL_MS;
    this.state = this.load();
  }

  get silentUntil(): number {
    return this.state.silentUntil;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Returns a permit, waiting for a local token when `counted`. While jammed, nothing is sent
   * at all — not even uncounted routes: a request during jamming doubles its term.
   */
  async acquire(counted: boolean, signal?: AbortSignal): Promise<Permit> {
    for (;;) {
      const now = this.now();
      if (now < this.state.silentUntil) return { ok: false, until: this.state.silentUntil };
      if (!counted) return { ok: true };
      this.refill(now);
      if (this.state.tokens >= 1) {
        this.state = { ...this.state, tokens: this.state.tokens - 1 };
        this.save();
        return { ok: true };
      }
      const wait = this.state.refilledAt + this.refillMs - now;
      await sleep(Math.max(50, wait), signal);
    }
  }

  observe(raw: { status: number; text: string; retryAfterSec: number | null }): void {
    if (raw.status !== 429) return;
    const parsed = tryParseJson(raw.text);
    const code = readErrorBody(parsed.ok ? parsed.value : undefined)?.error.code ?? null;
    // Only `jammed` silences the whole address. `rate-limited` and `authentication-busy`
    // are per-account / per-queue and the caller waits on that one request.
    if (code !== null && code !== 'jammed') return;
    const retryMs = (raw.retryAfterSec ?? 30) * 1000;
    const until = this.now() + retryMs + JAM_MARGIN_MS;
    if (until > this.state.silentUntil) {
      // Bucket is empty on the server side after a jam; start ours empty too.
      this.state = { silentUntil: until, tokens: 0, refilledAt: until };
      this.save();
      this.emit();
    }
  }

  private refill(now: number): void {
    const elapsed = now - this.state.refilledAt;
    if (elapsed < this.refillMs) return;
    const gained = Math.floor(elapsed / this.refillMs);
    this.state = {
      ...this.state,
      tokens: Math.min(this.capacity, this.state.tokens + gained),
      refilledAt: this.state.refilledAt + gained * this.refillMs,
    };
  }

  private load(): GateSnapshot {
    const fresh: GateSnapshot = { silentUntil: 0, tokens: this.capacity, refilledAt: this.now() };
    const raw = this.options.store.get(this.options.storeKey);
    if (raw === null) return fresh;
    const parsed = tryParseJson(raw);
    if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) return fresh;
    const v = parsed.value as Partial<GateSnapshot>;
    if (typeof v.silentUntil !== 'number' || typeof v.tokens !== 'number' || typeof v.refilledAt !== 'number') return fresh;
    return {
      silentUntil: v.silentUntil,
      tokens: Math.min(this.capacity, Math.max(0, v.tokens)),
      // A clock that went backwards must not freeze refills.
      refilledAt: Math.min(v.refilledAt, Math.max(this.now(), v.silentUntil)),
    };
  }

  private save(): void {
    this.options.store.set(this.options.storeKey, JSON.stringify(this.state));
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
