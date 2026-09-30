/* Раскладки долины против констант спецификации.
   Источник истины — текст правил и приложение А, а не арифметика самого
   valley.ts: проверка, которая пересчитывает то же выражение, что и код,
   соглашается с любой его ошибкой. Манифест берётся у движителя.
   Так нашлось, что `cost` паспорта земли — множитель шага, а цена соты
   лежит в `min`: обе величины целые и обе маленькие, и подмена одной другой
   ничего не ломала видимо — она просто платила голкам не по той земле. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '@zoria/engine';
import { openMatch } from '@zoria/sdk';
import { decodeManifest } from '@zoria/protocol';
import { RulesOracle } from '@zoria/sdk';
import { dist, key, ring, Valley } from '../dist/valley.js';

const bytes = openMatch(createEngine, { seed: 2026, ticks: 1200 }).manifest;
const manifest = decodeManifest(bytes);
const valley = new Valley(manifest);

test('вершины стоят там, где их называет правило 5.4', () => {
  assert.deepEqual(manifest.seats, [
    { q: 6, r: -12 },
    { q: 6, r: 6 },
    { q: -12, r: 6 },
  ]);
  for (const seat of manifest.seats) assert.equal(dist(seat.q, seat.r, 0, 0), 12);
  assert.deepEqual(valley.seat('A'), { q: 6, r: -12 });
  assert.deepEqual(valley.seat('C'), { q: -12, r: 6 });
});

test('стартовые голки вершины A — (5,-12) и (7,-13), правило 5.4', () => {
  const a = manifest.needles.filter((n) => n.start === 'A').map((n) => key(n.q, n.r));
  assert.deepEqual(a.sort(), ['5,-12', '7,-13']);
});

test('долина — 1141 сота, правило 5.1', () => {
  let cells = 0;
  for (let rad = 0; rad <= manifest.terrain.radius - 1; rad++) cells += ring({ q: 0, r: 0 }, rad).length;
  assert.equal(cells, 1141);
});

test('изолированная голка накрывает 37 сот, правило 8.1', () => {
  let cells = 0;
  for (const rad of [0, 1, 2, 3]) cells += ring({ q: 0, r: 0 }, rad).length;
  assert.equal(cells, 37);
});

test('паспорта земли — приложение А.2 целиком', () => {
  /* имя, прохідна, будівництво, множитель шага, цена соты */
  const A2 = [
    ['bare', true, true, 1, 2],
    ['meadow', true, true, 1, 3],
    ['wood', true, true, 1, 2],
    ['sand', true, true, 1, 1],
    ['marsh', true, true, 2, 1],
    ['hill', true, true, 2, 1],
    ['water', false, false, 0, 0],
    ['mount', false, false, 0, 0],
  ];
  assert.equal(manifest.terrain.types.length, A2.length);
  manifest.terrain.types.forEach((t, i) => {
    assert.deepEqual([t.name, t.pass, t.build, t.cost, t.min], A2[i], 'земля ' + i);
  });
});

test('Valley разбирает паспорт по назначению полей', () => {
  const meadow = manifest.terrain.cells.find(([, , t]) => manifest.terrain.types[t].name === 'meadow');
  if (!meadow) return; // луга в этой долине нет — проверять нечего
  const [q, r] = meadow;
  assert.equal(valley.price(q, r), 3, 'цена соты луга — 3 (А.2)');
  assert.equal(valley.at(key(q, r)).step, 1, 'шаг по лугу — 1 (А.2)');
});

test('край долины — 19, а не 20: правило 5.1 и А.3 RADIUS', () => {
  assert.equal(valley.inValley(19, 0), true, 'сота на расстоянии 19 играется');
  assert.equal(valley.inValley(20, 0), false, 'RADIUS 20, играется RADIUS-1');
  assert.equal(valley.price(20, 0), 0, 'соты за краем в доходе не считаются (8.1)');
});

test('счёт голок: 51 руина, 12 голок кольца, 6 стартовых', () => {
  assert.equal(valley.ruins.length, 51, 'valleyRuins из А.1');
  assert.equal(valley.ringKeys.length, 12, 'кольцо — 12 голок, правило 5.5');
  assert.equal(manifest.needles.filter((n) => n.start !== null).length, 6);
  assert.equal(valley.needles.size, 51 + 12 + 6);
});

test('межа, зоря и множитель кольца — правила 5.5 и 22.1', () => {
  assert.equal(valley.cherta, 6);
  assert.equal(valley.dawnAt, 1200 - 200);
  assert.equal(manifest.dawn.ring, 2);
  assert.equal(valley.inCherta({ q: 0, r: 6 }), true);
  assert.equal(valley.inCherta({ q: 0, r: 7 }), false);
});

test('числа мира в манифесте — приложение А.1', () => {
  const A1 = {
    linkRange: 5,
    startEnergy: 120,
    costTkach: 90,
    costKlinok: 50,
    stepTkach: 2,
    stepKlinok: 1,
    weightTkach: 2,
    squadWeight: 8,
    costNeedle: 60,
    buildTicks: 8,
    heatNeedle: 8,
    heatDark: 16,
    heatEnemy: 24,
    capGrace: 60,
    jamHold: 20,
    embTicks: 8,
    energyCap: 360,
    minuteRate: 0.0005,
    orderBonus: 30,
    orderHoldTicks: 12,
    dawnRing: 2,
    pactTax: 0.1,
    chanOrder: 32,
    chanTick: 32,
    upFloor: 96,
    valleyRuins: 51,
  };
  for (const [k, want] of Object.entries(A1)) assert.equal(manifest.cfg[k], want, 'cfg.' + k);
});

test('travel считает дорогу теми же шагами, что и вузол', () => {
  const o = new RulesOracle(createEngine, bytes);
  const from = { q: 6, r: -12 };
  assert.equal(valley.travel(o, from, from, 'ткач'), 0, 'дорога на месте — ноль тактов');
  const near = { q: 5, r: -12 };
  assert.equal(valley.travel(o, from, near, 'ткач'), o.stepCost(from, near, 'ткач'));
  assert.ok(valley.travel(o, from, near, 'клинок') < valley.travel(o, from, near, 'ткач'), 'Клинок ходит быстрее Ткача (10.1)');
});
