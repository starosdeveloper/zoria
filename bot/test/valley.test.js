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
import { DIRS, dist, key, ring, same, Valley } from '../dist/valley.js';
import { NEEDED, readNumbers } from '../dist/numbers.js';

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

test('шесть направлений соседа — список из правила 5.1', () => {
  assert.deepEqual(DIRS, [
    [1, 0],
    [1, -1],
    [0, -1],
    [-1, 0],
    [-1, 1],
    [0, 1],
  ]);
  for (const [dq, dr] of DIRS) assert.equal(dist(dq, dr, 0, 0), 1, 'направление не в соседнюю соту');
  const uniq = new Set(DIRS.map(([q, r]) => q + ',' + r));
  assert.equal(uniq.size, 6, 'направления повторяются');
});

test('same сравнивает обе оси', () => {
  assert.equal(same({ q: 3, r: -4 }, { q: 3, r: -4 }), true);
  assert.equal(same({ q: 3, r: -4 }, { q: 3, r: -5 }), false, 'разница только по r');
  assert.equal(same({ q: 3, r: -4 }, { q: 2, r: -4 }), false, 'разница только по q');
});

test('кольцо радиуса 0 — сама сота, радиуса rad — соты ровно на rad', () => {
  const c = { q: 2, r: -3 };
  assert.deepEqual(ring(c, 0), [c]);
  /* длины мало: она одинакова и при неверной арифметике обхода. Проверяется
     расстояние каждой соты и то, что повторов нет */
  for (const rad of [1, 2, 5]) {
    const cells = ring(c, rad);
    assert.equal(cells.length, 6 * rad);
    for (const x of cells) assert.equal(dist(x.q, x.r, c.q, c.r), rad, 'сота кольца ' + rad + ' на другом расстоянии');
    assert.equal(new Set(cells.map((x) => key(x.q, x.r))).size, cells.length, 'кольцо с повторами');
  }
  const near = new Set(ring(c, 1).map((x) => key(x.q, x.r)));
  for (const [dq, dr] of DIRS) assert.ok(near.has(key(c.q + dq, c.r + dr)), 'в кольце 1 нет соседа по направлению');
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

test('числа мира читаются по именам, и пропуск — отказ, а не подстановка (1.3, 1.4)', () => {
  const num = readNumbers(manifest.cfg);
  for (const k of NEEDED) assert.equal(num[k], manifest.cfg[k], 'число ' + k + ' прочитано не из манифеста');
  assert.equal(Object.keys(num).length, NEEDED.length, 'в наборе есть числа, которых нет в списке нужных');

  /* сдвиг мира переименовал или убрал ключ: играть по прошлогоднему числу
     хуже, чем не играть — поэтому отказ с именем ключа */
  for (const k of NEEDED) {
    const holed = Object.fromEntries(Object.entries(manifest.cfg).filter(([name]) => name !== k));
    assert.throws(() => readNumbers(holed), new RegExp(k), 'пропуск ' + k + ' прошёл молча');
  }
  assert.throws(() => readNumbers({ ...manifest.cfg, heatEnemy: Number.NaN }), /heatEnemy/);
  assert.throws(() => new Valley({ ...manifest, cfg: {} }), /числа мира/);
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

test('вершины: слот называет свою, все три', () => {
  assert.deepEqual(valley.seat('A'), { q: 6, r: -12 });
  assert.deepEqual(valley.seat('B'), { q: 6, r: 6 });
  assert.deepEqual(valley.seat('C'), { q: -12, r: 6 });
});

test('знахідки из манифеста лежат в долине по своим сотам (16.1)', () => {
  assert.equal(valley.finds.size, manifest.finds.length);
  assert.ok(valley.finds.size >= 4 && valley.finds.size <= 7, 'знахідок 4-7 (FIND_CFG)');
  for (const f of manifest.finds) assert.equal(valley.finds.get(key(f.q, f.r)), f.kind);
});

test('манифест без паспортов земли — отказ, а не тихая равнина', () => {
  assert.throws(() => new Valley({ ...manifest, terrain: { ...manifest.terrain, types: [] } }), /terrain types/);
});

test('сота с неизвестным типом земли читается как равнина', () => {
  const odd = new Valley({ ...manifest, terrain: { ...manifest.terrain, cells: [[0, -9, 99]] } });
  assert.equal(odd.price(0, -9), manifest.terrain.types[0].min, 'подстановка не равнина');
  assert.equal(odd.at(key(0, -9)).pass, true);
});

test('travel считает дорогу теми же шагами, что и вузол', () => {
  const o = new RulesOracle(createEngine, bytes);
  const from = { q: 6, r: -12 };
  const near = { q: 5, r: -12 };
  assert.equal(valley.travel(o, from, from, 'ткач'), 0, 'дорога на месте — ноль тактов');
  assert.equal(valley.travel(o, from, near, 'ткач'), o.stepCost(from, near, 'ткач'));
  assert.ok(valley.travel(o, from, near, 'клинок') < valley.travel(o, from, near, 'ткач'), 'Клинок ходит быстрее Ткача (10.1)');
  /* допущение, на котором стоит travel: шлях вузла не содержит соту, с которой
     машина начинает. Ценa соты в шаге не ноль, поэтому повтор начала завысил бы
     дорогу — правило 10.5 и stepCost(a,a) = 2 */
  assert.ok(o.stepCost(from, from, 'ткач') > 0, 'stepCost соты в себя стал нулём — допущение travel изменилось');
  assert.equal(
    o.path(from, near, 'ткач').some((c) => same(c, from)),
    false,
    'шлях вузла начал включать исходную соту',
  );
  const far = valley.travel(o, from, { q: 0, r: 6 }, 'ткач');
  assert.ok(far !== null && far > 20, 'дальняя дорога: ' + far);
});

test('дороги нет — travel отвечает null, а не нулём', () => {
  const o = new RulesOracle(createEngine, bytes);
  assert.equal(valley.travel(o, { q: 6, r: -12 }, { q: 30, r: 0 }, 'ткач'), null);
});
