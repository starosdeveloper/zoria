// Server address is a setting (CL-40): prod and stand switch without code changes.

export type ServerId = 'prod' | 'stand';

export interface ServerProfile {
  id: ServerId;
  label: string;
  apiBase: string;
  /**
   * SHA-256 of the station's public key (64 hex). Prod: the value published in ТЗ part 1 §3
   * on 21.09. Null = trust on first use: the key is still checked for self-consistency and
   * the UI shows that it was not compared with the ТЗ.
   */
  fingerprint: string | null;
}

export const DEFAULT_SERVERS: Record<ServerId, Omit<ServerProfile, 'fingerprint'>> = {
  prod: { id: 'prod', label: 'Боевой сервер', apiBase: 'https://zoria.net/api/v1' },
  stand: { id: 'stand', label: 'Учебный стенд', apiBase: 'https://stand.zoria.net/api/v1' },
};

const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

export function normalizeFingerprint(value: string | null | undefined): string | null {
  const v = value?.trim().toLowerCase() ?? '';
  return FINGERPRINT_RE.test(v) ? v : null;
}

export function isServerId(value: unknown): value is ServerId {
  return value === 'prod' || value === 'stand';
}
