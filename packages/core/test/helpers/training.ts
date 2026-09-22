import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodeBase64Url } from '../../src/ether/base64url.ts';
import { KeyRing } from '../../src/ether/keyring.ts';

// Training key from client spec §5.2: its private half is public on purpose.
export const TRAINING_PUBLIC = 'GQgsc8G1w5aXEnExpTBE597_7acc0vGKMAT5wUW4L5g';
export const TRAINING_SEED = 'bJrTquHp22_7HTNSbyX62-wRZ6_-2fACAvvPx3FY-ew';
export const TRAINING_FINGERPRINT = 'f3a436df65614f08635f18fe0f64f145285203f1faa2905ecb25ffb90969a7de';
export const TRAINING_KEY_ID = 'f3a436df65614f08';

export const TRAINING_KEY_BODY = {
  algorithm: 'Ed25519',
  key: TRAINING_KEY_ID,
  publicKey: TRAINING_PUBLIC,
  fingerprint: TRAINING_FINGERPRINT,
};

export function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8');
}

export function trainingRing(pin: string | null = TRAINING_FINGERPRINT): { ring: KeyRing; fetches: () => number } {
  let count = 0;
  const ring = new KeyRing(() => {
    count++;
    return Promise.resolve(TRAINING_KEY_BODY);
  }, pin);
  return { ring, fetches: () => count };
}

let signingKey: Promise<CryptoKey> | null = null;

function privateKey(): Promise<CryptoKey> {
  signingKey ??= crypto.subtle.importKey(
    'jwk',
    { kty: 'OKP', crv: 'Ed25519', d: TRAINING_SEED, x: TRAINING_PUBLIC },
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
  return signingKey;
}

/** Seals an arbitrary frame object with the training key, producing an envelope body. */
export async function seal(frame: Record<string, unknown>, keyId = TRAINING_KEY_ID): Promise<string> {
  const frameText = JSON.stringify(frame);
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'Ed25519' }, await privateKey(), new TextEncoder().encode(frameText)),
  );
  return JSON.stringify({ frame: frameText, seal: encodeBase64Url(signature), key: keyId });
}

export function frame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    kind: 'signal',
    station: 'zoria',
    at: '2026-09-24T03:00:00.000Z',
    phase: 'static',
    window: null,
    harbinger: null,
    fragment: null,
    onAir: 0,
    ...overrides,
  };
}
