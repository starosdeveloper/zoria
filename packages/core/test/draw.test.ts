import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  checkBeacon,
  commitmentOf,
  compareCodePoints,
  drandRoundTime,
  drawPermutation,
  DRAW_ROUND,
  groupSizes,
  lotOf,
  RandomStream,
  saltOf,
  sliceGroups,
  TRIPLES,
} from '../src/draw/draw.ts';

const SECRET = '11'.repeat(32);
const RANDOMNESS = 'ab'.repeat(32);

describe('draw (scoring appendix A)', () => {
  it('announced drand round comes out 26.09 11:00 Kyiv (08:00 UTC)', () => {
    expect(drandRoundTime(DRAW_ROUND).toISOString()).toBe('2026-09-26T08:00:00.000Z');
  });

  it('commitment and salt hash raw bytes, not hex text (A.0)', async () => {
    expect(await commitmentOf(SECRET)).toBe(createHash('sha256').update(Buffer.from(SECRET, 'hex')).digest('hex'));
    const expected = createHash('sha256').update(Buffer.concat([Buffer.from(SECRET, 'hex'), Buffer.from(RANDOMNESS, 'hex')])).digest('hex');
    expect(await saltOf(SECRET, RANDOMNESS)).toBe(expected);
    await expect(saltOf('abc', RANDOMNESS)).rejects.toThrow();
  });

  it('beacon rule randomness = SHA-256(signature)', async () => {
    const signature = 'cd'.repeat(48);
    const randomness = createHash('sha256').update(Buffer.from(signature, 'hex')).digest('hex');
    expect(await checkBeacon({ signature, randomness })).toBe(true);
    expect(await checkBeacon({ signature, randomness: RANDOMNESS })).toBe(false);
  });

  it('stream block k = SHA-256(tag ‖ 0x00 ‖ s ‖ decimal k), uint32 little-endian (A.2)', async () => {
    const stream = RandomStream.fromString('seed');
    const got: number[] = [];
    for (let i = 0; i < 9; i++) got.push(await stream.nextUint32());
    const block = (k: number): Buffer => createHash('sha256').update(Buffer.concat([Buffer.from('zaria-tournament-v1'), Buffer.from([0]), Buffer.from('seed'), Buffer.from(String(k))])).digest();
    expect(got.slice(0, 8)).toEqual(Array.from({ length: 8 }, (_, i) => block(0).readUInt32LE(i * 4)));
    expect(got[8]).toBe(block(1).readUInt32LE(0));
  });

  it('bounded integers stay in range (A.3)', async () => {
    const stream = RandomStream.fromString('x');
    for (const n of [1, 2, 3, 7, 9, 1000, 2 ** 31 + 1]) {
      const v = await stream.nextBelow(n);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(n);
    }
  });

  it('permutation is a deterministic shuffle of code-point-sorted logins (A.1, A.4)', async () => {
    const logins = Array.from({ length: 50 }, (_, i) => `user${String(i).padStart(2, '0')}`).reverse();
    const salt = await saltOf(SECRET, RANDOMNESS);
    const a = await drawPermutation(salt, logins);
    const b = await drawPermutation(salt, [...logins].reverse());
    expect(a).toEqual(b);
    expect([...a].sort()).toEqual([...logins].sort());
    expect(a).not.toEqual([...logins].sort());
    expect(await drawPermutation(await saltOf(SECRET, 'cd'.repeat(32)), logins)).not.toEqual(a);
  });

  it('sorts by Unicode code points, not UTF-16 units', () => {
    expect(compareCodePoints('￿', '😀')).toBeLessThan(0);
    // JS default sort orders by UTF-16 units and would put the emoji first
    expect(['\uFFFF', '😀'].sort()).toEqual(['😀', '\uFFFF']);
    expect(['😀', '\uFFFF'].sort(compareCodePoints)).toEqual(['\uFFFF', '😀']);
    expect(compareCodePoints('ab', 'abc')).toBeLessThan(0);
    expect(compareCodePoints('b', 'b')).toBe(0);
  });

  it.each([
    [482, 54, 638],
    [420, 48, 546],
    [360, 40, 480],
    [300, 34, 393],
  ])('%i participants → %i groups, %i packs (calendar table)', (n, groups, packs) => {
    const sizes = groupSizes(n) ?? [];
    expect(sizes.length).toBe(groups);
    expect(sizes.reduce((s, x) => s + (x === 9 ? 12 : 7), 0)).toBe(packs);
    expect(sizes.reduce((s, x) => s + x, 0)).toBe(n);
    // nines first
    const firstSeven = sizes.indexOf(7);
    expect(firstSeven === -1 || sizes.slice(firstSeven).every((x) => x === 7)).toBe(true);
  });

  it.each([7, 9] as const)('triples of %i form a Steiner system: every pair exactly once', (v) => {
    const pairs = new Map<string, number>();
    const perPoint = new Array<number>(v).fill(0);
    for (const t of TRIPLES[v]) {
      for (const p of t) perPoint[p] = (perPoint[p] ?? 0) + 1;
      for (const [x, y] of [[t[0], t[1]], [t[0], t[2]], [t[1], t[2]]] as const) {
        const k = `${Math.min(x, y)}-${Math.max(x, y)}`;
        pairs.set(k, (pairs.get(k) ?? 0) + 1);
      }
    }
    expect(pairs.size).toBe((v * (v - 1)) / 2);
    expect([...pairs.values()].every((c) => c === 1)).toBe(true);
    expect(perPoint.every((c) => c === (v - 1) / 2)).toBe(true);
  });

  it('slicing strikes the non-admitted without reordering (A.5)', async () => {
    const logins = Array.from({ length: 26 }, (_, i) => `p${String(i).padStart(2, '0')}`);
    const perm = await drawPermutation(await saltOf(SECRET, RANDOMNESS), logins);
    const admitted = new Set(perm.filter((_, i) => i !== 3));
    const groups = sliceGroups(perm, admitted);
    expect(groups?.map((g) => g.members.length)).toEqual([9, 9, 7]);
    expect(groups?.flatMap((g) => g.members)).toEqual(perm.filter((l) => admitted.has(l)));
    expect(groups?.map((g) => g.packs.length)).toEqual([12, 12, 7]);
    expect(groups?.[2]?.packs[0]).toEqual([groups?.[2]?.members[0], groups?.[2]?.members[1], groups?.[2]?.members[3]]);
  });

  it('a count with no 9/7 split yields null instead of a wrong slicing', () => {
    expect(groupSizes(19)).toBeNull();
    expect(sliceGroups(['a', 'b'], new Set(['a', 'b']))).toBeNull();
  });

  it('lot is SHA-256(tag ‖ 0x00 ‖ salt ‖ 0x00 ‖ login) (5.8)', async () => {
    const salt = 'f'.repeat(64);
    const expected = createHash('sha256').update(Buffer.concat([Buffer.from('zaria-tournament-lot-v1'), Buffer.from([0]), Buffer.from(salt), Buffer.from([0]), Buffer.from('north')])).digest('hex');
    expect(await lotOf(salt, 'north')).toBe(expected);
  });
});
