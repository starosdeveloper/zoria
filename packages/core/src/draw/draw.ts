// Draw and groups, scoring appendix A. Independent re-implementation to check the
// organizers' draw.json / groups.json: salt (A.0), random stream (A.2), bounded integer
// (A.3), Fisher–Yates (A.4), slicing (A.5), triples (A.6), tie-break lot (5.8).

import { decodeHex, toHex } from '../ether/base64url.ts';

export const DRAND_QUICKNET_CHAIN = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';
export const DRAND_QUICKNET_GENESIS = 1_692_803_367;
export const DRAND_QUICKNET_PERIOD = 3;
/** Announced round (scoring A.0, calendar): 26.09 11:00 Kyiv. Moves only by a news item if the window is extended. */
export const DRAW_ROUND = 32_535_412;
/** Organizers' commitment published 21.09 (ТЗ части 1 §7): SHA-256 of their 32 secret bytes. */
export const DRAW_COMMITMENT = '49f5304dd735a00f4999ff518b4dc6f85e3288c828b71853b786e572bac73ab0';
export const DRAND_MIRRORS = ['https://api.drand.sh', 'https://api2.drand.sh', 'https://api3.drand.sh', 'https://drand.cloudflare.com'];

const STREAM_TAG = 'zaria-tournament-v1';
const LOT_TAG = 'zaria-tournament-lot-v1';
const encoder = new TextEncoder();

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function drandRoundTime(round: number): Date {
  return new Date((DRAND_QUICKNET_GENESIS + (round - 1) * DRAND_QUICKNET_PERIOD) * 1000);
}

/** Commitment published 21.09: SHA-256 of the 32 secret bytes, lowercase hex. */
export async function commitmentOf(secretHex: string): Promise<string> {
  const secret = decodeHex(secretHex, 32);
  if (!secret) throw new Error('secret must be 64 hex characters (32 bytes)');
  return toHex(await sha256(secret));
}

/** drand rule: randomness = SHA-256(signature). */
export async function checkBeacon(beacon: { randomness: string; signature: string }): Promise<boolean> {
  const signature = decodeHex(beacon.signature);
  if (!signature) return false;
  return toHex(await sha256(signature)) === beacon.randomness.toLowerCase();
}

/** A.0: salt = SHA-256(secret ‖ randomness) over 64 raw bytes, as 64 lowercase hex characters. */
export async function saltOf(secretHex: string, randomnessHex: string): Promise<string> {
  const secret = decodeHex(secretHex, 32);
  const randomness = decodeHex(randomnessHex, 32);
  if (!secret || !randomness) throw new Error('secret and randomness must be 32 bytes each (64 hex)');
  return toHex(await sha256(concat(secret, randomness)));
}

/** A.2: blocks SHA-256("zaria-tournament-v1" ‖ 0x00 ‖ s ‖ decimal(k)), each read as eight uint32 LE. */
export class RandomStream {
  private readonly seed: Uint8Array;
  private block = 0;
  private buffer: number[] = [];

  constructor(s: Uint8Array) {
    this.seed = s;
  }

  static fromString(s: string): RandomStream {
    return new RandomStream(encoder.encode(s));
  }

  async nextUint32(): Promise<number> {
    if (this.buffer.length === 0) {
      const digest = await sha256(concat(encoder.encode(STREAM_TAG), new Uint8Array([0]), this.seed, encoder.encode(String(this.block))));
      this.block++;
      const view = new DataView(digest.buffer);
      for (let i = 0; i < 8; i++) this.buffer.push(view.getUint32(i * 4, true));
    }
    // Buffer was just filled with eight values when empty.
    return this.buffer.shift() ?? 0;
  }

  /** A.3: rejection sampling, x ≥ floor(2^32 / n)·n is discarded. */
  async nextBelow(n: number): Promise<number> {
    if (!Number.isInteger(n) || n <= 0 || n > 2 ** 32) throw new RangeError(`n out of range: ${n}`);
    const limit = Math.floor(2 ** 32 / n) * n;
    for (;;) {
      const x = await this.nextUint32();
      if (x < limit) return x % n;
    }
  }
}

/** Unicode code point order (A.1), not JS's default UTF-16 unit order. */
export function compareCodePoints(a: string, b: string): number {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done || y.done) return x.done && y.done ? 0 : x.done ? -1 : 1;
    const cx = x.value.codePointAt(0) ?? 0;
    const cy = y.value.codePointAt(0) ?? 0;
    if (cx !== cy) return cx - cy;
  }
}

/** A.1 + A.4: sorted logins, shuffled in place from the end with stream `salt ‖ 0x00 ‖ "split"`. */
export async function drawPermutation(saltHex: string, logins: readonly string[]): Promise<string[]> {
  const list = [...logins].sort(compareCodePoints);
  const stream = new RandomStream(concat(encoder.encode(saltHex), new Uint8Array([0]), encoder.encode('split')));
  for (let i = list.length - 1; i >= 1; i--) {
    const j = await stream.nextBelow(i + 1);
    const tmp = list[i] as string;
    list[i] = list[j] as string;
    list[j] = tmp;
  }
  return list;
}

/** 5.4: sizes 9 and 7 summing to N with as few sevens as possible, nines first. */
export function groupSizes(n: number): number[] | null {
  for (let sevens = 0; sevens * 7 <= n; sevens++) {
    const rest = n - sevens * 7;
    if (rest % 9 === 0) return [...Array<number>(rest / 9).fill(9), ...Array<number>(sevens).fill(7)];
  }
  return null;
}

/** A.6: point numbers inside a group. */
export const TRIPLES: Readonly<Record<7 | 9, readonly (readonly [number, number, number])[]>> = {
  9: [
    [0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 7], [1, 4, 8], [2, 5, 6],
    [0, 4, 6], [1, 5, 7], [2, 3, 8], [1, 3, 6], [2, 4, 7], [0, 5, 8],
  ],
  7: [
    [0, 1, 3], [1, 2, 4], [2, 3, 5], [3, 4, 6], [0, 4, 5], [1, 5, 6], [0, 2, 6],
  ],
};

export interface Group {
  number: number;
  members: string[];
  packs: [string, string, string][];
}

/** A.5: strike the non-admitted without reordering, slice in nines then sevens. */
export function sliceGroups(permutation: readonly string[], admitted: ReadonlySet<string>): Group[] | null {
  const list = permutation.filter((login) => admitted.has(login));
  const sizes = groupSizes(list.length);
  if (!sizes) return null;
  const groups: Group[] = [];
  let at = 0;
  sizes.forEach((size, i) => {
    const members = list.slice(at, at + size);
    at += size;
    const triples = TRIPLES[size as 7 | 9];
    groups.push({
      number: i + 1,
      members,
      packs: triples.map(([a, b, c]) => [members[a] as string, members[b] as string, members[c] as string]),
    });
  });
  return groups;
}

/** 5.8 step 4: lot = SHA-256("zaria-tournament-lot-v1" ‖ 0x00 ‖ salt ‖ 0x00 ‖ login); lower hex wins. */
export async function lotOf(saltHex: string, login: string): Promise<string> {
  return toHex(await sha256(concat(encoder.encode(LOT_TAG), new Uint8Array([0]), encoder.encode(saltHex), new Uint8Array([0]), encoder.encode(login))));
}
