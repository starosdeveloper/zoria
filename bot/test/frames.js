/* Кадр наблюдения для хост-тестов: форма из @zoria/protocol, значения по
   умолчанию — старт партии в вершине A (правила 4.1, 5.4, 13.3). */

import { createEngine } from '@zoria/engine';
import { openMatch } from '@zoria/sdk';

export const manifestBytes = openMatch(createEngine, { seed: 2026, ticks: 1200 }).manifest;

export const START_NEEDLES = [
  { q: 5, r: -12, dark: false, fed: false, weight: 1 },
  { q: 7, r: -13, dark: false, fed: false, weight: 1 },
];

export function task(over = {}) {
  return { goal: null, site: null, feed: null, jam: null, ram: null, home: false, path: 0, ...over };
}

export function unit(id, over = {}) {
  return { id, cls: 'ткач', q: 6, r: -12, mute: false, stuck: false, wait: 0, work: 0, away: 0, task: null, ...over };
}

export function observe(over = {}) {
  const pulse = {
    energy: 120,
    chan: 141,
    chanAt: 141, // подложка 96 и две стартовые голки — пример из правила 13.3
    ear: 987,
    earAt: 1120,
    minutes: 0,
    needles: 2,
    mercy: false,
    ...(over.pulse ?? {}),
  };
  const mine = {
    needles: START_NEEDLES,
    units: [],
    jams: [],
    losts: [],
    order: null,
    pact: { in: [], out: [], offersLeft: 2, cryAt: null },
    ledger: { pactTax: 0, stolen: 0 },
    ...(over.mine ?? {}),
  };
  return {
    t: 1,
    ...over,
    pulse,
    mine,
    own: over.own ?? [],
    foe: over.foe ?? [],
    noisy: over.noisy ?? [],
    pub: over.pub ?? { order: null, pact: { active: [], breaks: [] }, cries: [], dawn: false, score: [0, 0, 0] },
    events: over.events ?? [],
  };
}
