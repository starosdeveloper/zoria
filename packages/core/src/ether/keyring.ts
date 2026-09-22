import { readEtherKey } from '../api/types.ts';
import { decodeBase64Url, sha256Hex } from './base64url.ts';

export type KeyTrust =
  /** Fingerprint matches the one pinned from the task text (CL-04). */
  | 'pinned'
  /** No fingerprint configured: key is self-consistent but not checked against the ТЗ. */
  | 'unpinned';

export interface TrustedKey {
  id: string;
  publicKey: string;
  fingerprint: string;
  trust: KeyTrust;
}

export type KeyLoadError =
  | 'fetch-failed'
  | 'bad-shape'
  | 'bad-algorithm'
  | 'bad-public-key'
  | 'fingerprint-mismatch'
  | 'id-mismatch'
  | 'pin-mismatch';

/** Fetches `GET /ether/key` and returns the parsed JSON body, or null if unreachable/unparseable. */
export type KeyFetcher = () => Promise<unknown>;

/**
 * Holds verified station keys by 16-hex id. A key is accepted only when its SHA-256 equals
 * the advertised fingerprint, the id is the fingerprint prefix, and — if a pin is set —
 * the fingerprint equals the pin. An unknown id triggers exactly one reload (spec §5.2 step 2).
 */
export class KeyRing {
  private readonly keys = new Map<string, { info: TrustedKey; key: CryptoKey }>();
  private lastError: KeyLoadError | null = null;
  private inflight: Promise<void> | null = null;
  private lastReloadAt = Number.NEGATIVE_INFINITY;
  private readonly fetchKey: KeyFetcher;
  private readonly pinnedFingerprint: string | null;
  /** Forgeries carry random key ids; do not refetch the key for every one of them. */
  private readonly reloadCooldownMs: number;
  private readonly now: () => number;

  constructor(fetchKey: KeyFetcher, pinnedFingerprint: string | null, reloadCooldownMs = 60_000, now: () => number = Date.now) {
    this.fetchKey = fetchKey;
    this.pinnedFingerprint = pinnedFingerprint;
    this.reloadCooldownMs = reloadCooldownMs;
    this.now = now;
  }

  get error(): KeyLoadError | null {
    return this.lastError;
  }

  get known(): TrustedKey[] {
    return [...this.keys.values()].map((k) => k.info);
  }

  /** Restores a key saved earlier (CL-04: fetch once and keep). Re-validated like a fresh one. */
  async restore(info: { publicKey: string; fingerprint: string }): Promise<boolean> {
    const result = await this.admit({ algorithm: 'Ed25519', key: info.fingerprint.slice(0, 16), ...info });
    return result === null;
  }

  async resolve(id: string): Promise<CryptoKey | null> {
    const hit = this.keys.get(id);
    if (hit) return hit.key;
    if (this.keys.size > 0 && this.now() - this.lastReloadAt < this.reloadCooldownMs) return null;
    await this.reload();
    return this.keys.get(id)?.key ?? null;
  }

  /**
   * While no key is known yet (node not on air, 503 stopping), retry at most once per cooldown.
   * Once a key is held, only an unknown key id triggers a reload.
   */
  async ensure(): Promise<void> {
    if (this.keys.size > 0 || this.now() - this.lastReloadAt < this.reloadCooldownMs) return;
    await this.reload();
  }

  /** Coalesces concurrent reloads into one request. */
  reload(): Promise<void> {
    if (!this.inflight) this.lastReloadAt = this.now();
    this.inflight ??= this.fetchKey()
      .then(async (body) => {
        this.lastError = body === null ? 'fetch-failed' : await this.admit(body);
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async admit(body: unknown): Promise<KeyLoadError | null> {
    const info = readEtherKey(body);
    if (!info) return 'bad-shape';
    if (info.algorithm !== 'Ed25519') return 'bad-algorithm';
    const raw = decodeBase64Url(info.publicKey);
    if (!raw || raw.length !== 32) return 'bad-public-key';
    const fingerprint = await sha256Hex(raw);
    if (fingerprint !== info.fingerprint.toLowerCase()) return 'fingerprint-mismatch';
    if (info.key !== fingerprint.slice(0, 16)) return 'id-mismatch';
    const pin = this.pinnedFingerprint?.trim().toLowerCase() || null;
    if (pin !== null && pin !== fingerprint) return 'pin-mismatch';

    let key: CryptoKey;
    try {
      key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
    } catch {
      return 'bad-public-key';
    }
    this.keys.set(info.key, {
      key,
      info: { id: info.key, publicKey: info.publicKey, fingerprint, trust: pin === null ? 'unpinned' : 'pinned' },
    });
    return null;
  }
}

export function describeKeyError(error: KeyLoadError): string {
  switch (error) {
    case 'fetch-failed':
      return 'Не удалось получить ключ печати.';
    case 'bad-shape':
      return 'Ответ /ether/key не по контракту.';
    case 'bad-algorithm':
      return 'Ключ печати не Ed25519.';
    case 'bad-public-key':
      return 'Открытый ключ печати повреждён.';
    case 'fingerprint-mismatch':
      return 'Отпечаток ключа не совпадает с SHA-256 самого ключа.';
    case 'id-mismatch':
      return 'ID ключа не совпадает с отпечатком.';
    case 'pin-mismatch':
      return 'Отпечаток ключа не совпадает с отпечатком из ТЗ. Ключ отклонён.';
  }
}
