/* Сравнение пресетов по pack.json: ожидания — литералы. */

import { describe, expect, it } from 'vitest';
import { compare, summarize, valleyKey } from '../src/packs.js';
import type { PackRecord } from '../src/packs.js';

const b = (total: number, network: number, orders = 0, stolen = 0, pactTax = 0) => ({ total, network, orders, stolen, pactTax, jams: 0, rams: 0 });
const pack = (seed: number, shares: number, total: number, over: Partial<PackRecord> = {}): PackRecord => ({
  seed,
  ticks: 1200,
  roster: ['ваш бот', 'обхідник', 'рівний'],
  shares: [shares, 9 - shares, 3],
  absent: [
    [false, false, false],
    [false, false, false],
    [false, false, false],
  ],
  breakdown: [b(total, total - 30, 30), b(100, 100), b(50, 50)],
  ...over,
});

describe('summarize', () => {
  it('средняя доля за партию, статьи рахунка за партию, потолок', () => {
    const s = summarize('жатва', [pack(7, 9, 900), pack(8, 6, 600)]);
    expect(s).toEqual({
      name: 'жатва',
      packs: 2,
      matches: 6,
      shares: 15,
      maxShares: 18,
      meanShare: 2.5,
      perMatch: { total: 250, network: 240, orders: 10, stolen: 0, pactTax: 0 },
      absent: 0,
    });
  });

  it('пропуски присяги считаются по нашему месту', () => {
    const p = pack(7, 4, 300, {
      absent: [
        [true, false, true],
        [false, true, false],
        [false, false, false],
      ],
    });
    expect(summarize('x', [p]).absent).toBe(2);
    expect(summarize('пусто', [])).toMatchObject({ packs: 0, meanShare: 0, maxShares: 0 });
  });
});

describe('compare', () => {
  it('только общие долины; лучший первым; разные соперники — разные долины', () => {
    const other = { roster: ['ваш бот', 'шир', 'облягач'] };
    const c = compare({
      'жатва 120': [pack(7, 8, 800), pack(8, 7, 700), pack(9, 9, 900)],
      'жатва 60': [pack(7, 6, 600), pack(8, 9, 900), pack(9, 5, 500, other)],
    });
    expect(c.common).toEqual(['7/1200/обхідник+рівний', '8/1200/обхідник+рівний']);
    expect(c.dropped).toEqual(['9/1200/обхідник+рівний', '9/1200/шир+облягач']);
    expect(c.ranked.map((r) => [r.name, r.shares, r.meanShare])).toEqual([
      ['жатва 120', 15, 2.5],
      ['жатва 60', 15, 2.5],
    ]);
    expect(c.byValley).toEqual([
      { valley: '7/1200/обхідник+рівний', shares: { 'жатва 120': 8, 'жатва 60': 6 } },
      { valley: '8/1200/обхідник+рівний', shares: { 'жатва 120': 7, 'жатва 60': 9 } },
    ]);
  });

  it('ключ долины: жереб, длина партии и соперники', () => {
    expect(valleyKey(pack(2026, 9, 1))).toBe('2026/1200/обхідник+рівний');
  });
});
