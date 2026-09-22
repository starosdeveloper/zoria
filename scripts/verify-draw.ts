#!/usr/bin/env node
// Independent check of the 26.09 draw (scoring appendix A), without the organizers' code.
//
//   node scripts/verify-draw.ts --draw draw.json [--commit <hash from 21.09>] [--me <login>]
//   node scripts/verify-draw.ts --secret <hex> --logins logins.txt [--round 32535412] [--me <login>]
//
// The draw.json layout is not published yet; fields are looked up by likely names and every
// value can be given explicitly with a flag. Exit code 0 — every check passed, 1 — something differs.

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  checkBeacon,
  commitmentOf,
  DRAND_MIRRORS,
  DRAND_QUICKNET_CHAIN,
  drandRoundTime,
  drawPermutation,
  DRAW_ROUND,
  groupSizes,
  saltOf,
} from '../packages/core/src/index.ts';

const { values } = parseArgs({
  options: {
    draw: { type: 'string' },
    secret: { type: 'string' },
    commit: { type: 'string' },
    round: { type: 'string' },
    logins: { type: 'string' },
    me: { type: 'string' },
  },
});

type Json = Record<string, unknown>;
const draw: Json = values.draw ? (JSON.parse(readFileSync(values.draw, 'utf8')) as Json) : {};

function pick(obj: Json, ...paths: string[]): unknown {
  for (const path of paths) {
    let cur: unknown = obj;
    for (const part of path.split('.')) cur = typeof cur === 'object' && cur !== null ? (cur as Json)[part] : undefined;
    if (cur !== undefined && cur !== null) return cur;
  }
  return undefined;
}
const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v.toLowerCase() : undefined);
const asList = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : undefined);

let failed = 0;
function verdict(ok: boolean | null, label: string, detail = ''): void {
  if (ok === false) failed++;
  console.log(`${ok === null ? 'skip' : ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
}

interface Beacon {
  round: number;
  randomness: string;
  signature: string;
}

async function fetchBeacon(base: string, round: number): Promise<Beacon | null> {
  try {
    const res = await fetch(`${base}/${DRAND_QUICKNET_CHAIN}/public/${round}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const b = (await res.json()) as Partial<Beacon>;
    return typeof b.randomness === 'string' && typeof b.signature === 'string' ? { round, randomness: b.randomness, signature: b.signature } : null;
  } catch {
    return null;
  }
}

const secret = asString(values.secret ?? pick(draw, 'secret', 'reveal', 'commit.secret', 'secretHex'));
const commitment = asString(values.commit ?? pick(draw, 'commitment', 'commit', 'commit.hash', 'secretHash'));
const round = Number(values.round ?? pick(draw, 'round', 'drand.round', 'beacon.round') ?? DRAW_ROUND);
const publishedRandomness = asString(pick(draw, 'randomness', 'drand.randomness', 'beacon.randomness'));
const publishedSalt = asString(pick(draw, 'salt'));
const logins =
  (values.logins ? readFileSync(values.logins, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean) : undefined) ??
  asList(pick(draw, 'logins', 'registered', 'participants', 'input'));
const publishedPermutation = asList(pick(draw, 'permutation', 'order', 'shuffled'));

console.log(`round ${round}: ${drandRoundTime(round).toISOString()}`);
if (round !== DRAW_ROUND) console.log(`note: announced round was ${DRAW_ROUND}; a different one is valid only if a news item moved it (A.0)`);

if (!secret) {
  console.error('нет секрета: --secret <64 hex> или поле secret в draw.json');
  process.exit(1);
}

verdict(commitment ? (await commitmentOf(secret)) === commitment : null, 'обязательство SHA-256(секрет) = хеш от 21.09', commitment ? '' : '(передайте --commit)');

// A.0: take the round from two mirrors and require they agree.
const beacons = (await Promise.all(DRAND_MIRRORS.map((m) => fetchBeacon(m, round)))).filter((b): b is Beacon => b !== null);
const beacon = beacons[0];
verdict(beacons.length >= 2 && beacons.every((b) => b.randomness === beacon?.randomness), `маяк drand с двух адресов`, `получено ${beacons.length}`);
if (!beacon) {
  console.error('раунд drand недоступен (ещё не вышел или нет сети)');
  process.exit(1);
}
verdict(await checkBeacon(beacon), 'правило маяка randomness = SHA-256(signature)');
if (publishedRandomness) verdict(publishedRandomness === beacon.randomness, 'randomness в draw.json совпадает с маяком');

const salt = await saltOf(secret, beacon.randomness);
verdict(publishedSalt ? publishedSalt === salt : null, 'соль SHA-256(секрет ‖ randomness)', salt);

if (!logins) {
  console.error('нет списка логинов: --logins <файл> или поле logins в draw.json');
  process.exit(failed === 0 ? 0 : 1);
}
const permutation = await drawPermutation(salt, logins);
verdict(publishedPermutation ? publishedPermutation.join('\n') === permutation.join('\n') : null, `перестановка ${permutation.length} логинов`);

const sizes = groupSizes(permutation.length);
console.log(`разбиение всех зарегистрированных: ${sizes ? `${sizes.filter((s) => s === 9).length}×9 + ${sizes.filter((s) => s === 7).length}×7` : 'нет'} (окончательное — после вычёркивания 11.10)`);

if (values.me) {
  const me = values.me.trim().toLowerCase();
  const place = permutation.indexOf(me);
  verdict(place !== -1, `вы в перестановке`, place === -1 ? me : `${me}: место ${place + 1} из ${permutation.length}`);
}

console.log(failed === 0 ? 'сошлось' : `не сошлось: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
