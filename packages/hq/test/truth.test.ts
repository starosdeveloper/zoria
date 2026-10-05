/* Правда против веры на подложном мире: ожидания — литералы. */

import { describe, expect, it } from 'vitest';
import type { Belief } from '../src/belief.js';
import { divergence, truthOf } from '../src/truth.js';
import type { EngineView } from '../src/truth.js';

const world: EngineView = {
  SIM: {
    t: 300,
    world: {
      own: { '5,-12': 'A', '7,-13': 'A', '2,-9': 'B', '3,-9': undefined, '0,0': 'K' },
      lit: { A: { '5,-12': 1, '7,-13': 0 }, B: { '2,-9': 0.5 }, K: undefined },
    },
    units: [
      { id: 'T-A1', p: 'A', q: 6, r: -12 },
      { id: 'T-A2', p: 'A', q: 1, r: 1, dead: true },
      { id: 'T-B1', p: 'B', q: 3, r: -9 },
      { id: 'K-C1', p: 'C', q: 9, r: 9 },
    ],
  },
};

const belief = (over: Partial<Belief> = {}): Belief => ({
  t: 300,
  at: 300,
  stale: 0,
  pulse: { energy: 0, chan: 0, ear: 0, minutes: 0, needles: 0 },
  own: new Map<string, string | null>([
    ['5,-12', 'A'],
    ['7,-13', 'A'],
    ['2,-9', 'B'],
    ['0,0', 'K'],
  ]),
  dark: new Set(['7,-13', '0,0']),
  foe: [{ id: 'T-B1', owner: 'B', q: 3, r: -9 }],
  units: [{ id: 'T-A1', q: 6, r: -12, path: 0 }],
  noisy: 0,
  pact: null,
  ...over,
});

describe('truthOf', () => {
  it('владельцы без пустых, молчащие по весу нити, мёртвые машины не в счёт', () => {
    const t = truthOf(world);
    expect([...t.own]).toEqual([
      ['5,-12', 'A'],
      ['7,-13', 'A'],
      ['2,-9', 'B'],
      ['0,0', 'K'],
    ]);
    expect([...t.dark]).toEqual(['7,-13', '0,0']);
    expect(t.units.map((u) => u.id)).toEqual(['T-A1', 'T-B1', 'K-C1']);
    expect(t.t).toBe(300);
  });
});

describe('divergence', () => {
  it('вера, совпавшая с миром, — без расхождений, чужие вне видимости — туман', () => {
    const d = divergence(truthOf(world), belief(), 'A');
    expect(d.needles).toEqual([]);
    expect(d.ownUnits).toEqual([]);
    expect(d.ghosts).toEqual([]);
    expect(d.unseen).toBe(1);
  });

  it('чужой владелец, горит не так, голка не известна', () => {
    const b = belief({
      own: new Map<string, string | null>([
        ['5,-12', 'A'],
        ['7,-13', 'A'],
        ['2,-9', null],
      ]),
      dark: new Set(),
    });
    expect(divergence(truthOf(world), b, 'A').needles).toEqual([
      { cell: '7,-13', kind: 'dark', believedDark: false, actualDark: true },
      { cell: '2,-9', kind: 'owner', believed: null, actual: 'B' },
      { cell: '0,0', kind: 'unknown', actual: 'K' },
    ]);
  });

  it('своя машина не там или её нет, чужая — призрак', () => {
    const b = belief({
      units: [
        { id: 'T-A1', q: 6, r: -11, path: 2 },
        { id: 'T-A9', q: 0, r: 0, path: 0 },
      ],
      foe: [{ id: 'T-B1', owner: 'B', q: 4, r: -9 }],
    });
    const d = divergence(truthOf(world), b, 'A');
    expect(d.ownUnits).toEqual([
      { id: 'T-A1', believed: { q: 6, r: -11 }, actual: { q: 6, r: -12 } },
      { id: 'T-A9', believed: { q: 0, r: 0 }, actual: null },
    ]);
    expect(d.ghosts).toEqual(['T-B1']);
    /* призрак видим, только не там: вне видимости остаётся один K-C1 */
    expect(d.unseen).toBe(1);
  });
});
