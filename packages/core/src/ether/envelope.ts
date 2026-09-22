// Envelope and frame (client spec §5.2). The seal is checked over the frame string's
// UTF-8 bytes exactly as received — the string is never re-serialized before verifying.

import {
  arrayOf,
  int,
  isRecord,
  isoTime,
  nullable,
  object,
  oneOf,
  str,
  type Reader,
} from '../util/guard.ts';
import { tryParseJson } from '../util/json.ts';
import { decodeBase64Url } from './base64url.ts';
import type { KeyRing } from './keyring.ts';

export interface Envelope {
  frame: string;
  seal: string;
  key: string;
}

const SEAL_RE = /^[A-Za-z0-9_-]{86}$/;
const KEY_ID_RE = /^[0-9a-f]{16}$/;

/** Cheap structural test used by the HTTP classifier to route 503 envelopes to the ether. */
export function looksLikeEnvelope(value: unknown): value is Envelope {
  return (
    isRecord(value) &&
    typeof value.frame === 'string' &&
    typeof value.seal === 'string' &&
    typeof value.key === 'string'
  );
}

/** Step 1: the body must be an object with `frame`, `seal`, `key` of the required form. */
export function parseEnvelope(text: string): Envelope | null {
  const parsed = tryParseJson(text);
  if (!parsed.ok || !looksLikeEnvelope(parsed.value)) return null;
  const { frame, seal, key } = parsed.value;
  if (!SEAL_RE.test(seal) || !KEY_ID_RE.test(key)) return null;
  return { frame, seal, key };
}

export const readHarbinger = object({
  opensIn: int,
  text: object({ uk: str, ru: str }),
});
export type Harbinger = NonNullable<ReturnType<typeof readHarbinger>>;

export const readWindow = object({ opensAt: isoTime, closesAt: isoTime });
export type EtherWindow = NonNullable<ReturnType<typeof readWindow>>;

export const readFragment = object({ n: int, of: int, text: str });
export type Fragment = NonNullable<ReturnType<typeof readFragment>>;

export const readRollEntry = object({ n: int, at: isoTime, sinceOpen: int, name: str });
export type RollEntry = NonNullable<ReturnType<typeof readRollEntry>>;

export const PHASES = ['static', 'window', 'after'] as const;
export type Phase = (typeof PHASES)[number];

export interface Frame {
  kind: 'signal' | 'roll';
  at: string;
  atMs: number;
  phase: Phase;
  window: EtherWindow | null;
  harbinger: Harbinger | null;
  fragment: Fragment | null;
  onAir: number;
  roll: RollEntry[] | null;
}

const readFrameBody = object({
  v: (x) => (x === 1 ? 1 : undefined),
  station: (x) => (x === 'zoria' ? 'zoria' : undefined),
  kind: oneOf('signal', 'roll'),
  at: isoTime,
  phase: oneOf(...PHASES),
  window: nullable(readWindow),
  harbinger: nullable(readHarbinger),
  fragment: nullable(readFragment),
  onAir: int,
});

const readRoll: Reader<RollEntry[] | null> = (v) => (v === undefined || v === null ? null : arrayOf(readRollEntry)(v));

/** Step 4: parse the verified frame string; `v: 1` and `station: "zoria"` are mandatory. */
export function parseFrame(frameText: string): Frame | null {
  const parsed = tryParseJson(frameText);
  if (!parsed.ok) return null;
  const body = readFrameBody(parsed.value);
  if (!body || !isRecord(parsed.value)) return null;
  const roll = readRoll(parsed.value.roll);
  if (roll === undefined) return null;
  return {
    kind: body.kind,
    at: body.at,
    atMs: Date.parse(body.at),
    phase: body.phase,
    window: body.window,
    harbinger: body.harbinger,
    fragment: body.fragment,
    onAir: body.onAir,
    roll,
  };
}

export type NoiseReason = 'malformed' | 'unknown-key' | 'bad-seal' | 'bad-frame';

export type Verdict = { kind: 'signal'; frame: Frame } | { kind: 'noise'; reason: NoiseReason };

/** Steps 1–4 of the frame check. Step 5 (ordering by `at`) belongs to the ether state. */
export async function verifyEnvelopeText(text: string, keys: KeyRing): Promise<Verdict> {
  const envelope = parseEnvelope(text);
  if (!envelope) return { kind: 'noise', reason: 'malformed' };

  const key = await keys.resolve(envelope.key);
  if (!key) return { kind: 'noise', reason: 'unknown-key' };

  const seal = decodeBase64Url(envelope.seal);
  if (!seal || seal.length !== 64) return { kind: 'noise', reason: 'malformed' };

  const valid = await crypto.subtle.verify({ name: 'Ed25519' }, key, seal, new TextEncoder().encode(envelope.frame));
  if (!valid) return { kind: 'noise', reason: 'bad-seal' };

  const frame = parseFrame(envelope.frame);
  return frame ? { kind: 'signal', frame } : { kind: 'noise', reason: 'bad-frame' };
}
