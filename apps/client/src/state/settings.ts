import { DEFAULT_SERVERS, isServerId, normalizeFingerprint, WebStorageStore, type ServerId, type ServerProfile } from '@zoria/core';

export const local = new WebStorageStore(() => window.localStorage, 'zoria.');
export const session = new WebStorageStore(() => window.sessionStorage, 'zoria.');

/** Server profiles: addresses and fingerprints come from build-time env, the choice from the user (CL-40). */
export function serverProfile(id: ServerId): ServerProfile {
  const env = import.meta.env;
  if (id === 'prod') {
    return { ...DEFAULT_SERVERS.prod, fingerprint: normalizeFingerprint(env.VITE_ZORIA_PROD_FINGERPRINT) };
  }
  const apiBase = env.VITE_ZORIA_STAND_API?.trim() || DEFAULT_SERVERS.stand.apiBase;
  return { ...DEFAULT_SERVERS.stand, apiBase: apiBase.replace(/\/+$/, ''), fingerprint: normalizeFingerprint(env.VITE_ZORIA_STAND_FINGERPRINT) };
}

export function initialServer(): ServerId {
  const saved = local.get('server');
  if (isServerId(saved)) return saved;
  const fromEnv = import.meta.env.VITE_ZORIA_SERVER;
  return isServerId(fromEnv) ? fromEnv : 'stand';
}

export function saveServer(id: ServerId): void {
  local.set('server', id);
}

export function initialListening(): boolean {
  return local.get('listen') !== 'off';
}

export function saveListening(on: boolean): void {
  local.set('listen', on ? 'on' : 'off');
}
