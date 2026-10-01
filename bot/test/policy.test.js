/* Сама политика: в каком порядке голова выбирает, что делать, и по каким
   числам сравнивает цели. Порядок — это и есть пресет; если он поедет, бот
   останется рабочим и по-прежнему зелёным, только станет играть хуже.

   Каждая проверка ставит голову в положение, где правильный ответ один. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DIALS } from '../dist/harvest.js';
import { key } from '../dist/valley.js';
import { observe, unit } from './frames.js';
import { cfg, head, oracle, RUIN, SEAT, valley } from './world.js';

const board = (cells, over = {}) => ({
  order: { cells, from: 200, to: 400, bonus: cfg['orderBonus'], holdTicks: cfg['orderHoldTicks'], ...over },
  pact: { active: [], breaks: [] },
  cries: [],
  dawn: false,
  score: [0, 0, 0],
});

test('замовлення важнее обычной руины: 30 минут — это целая голка за партию (18.4)', () => {
  const cells = [RUIN, { q: 4, r: -8 }, { q: 8, r: -9 }];
  const plain = head().pickPlan(unit('T-A1'), observe({ t: 300 }), valley, oracle);
  const withOrder = head().pickPlan(unit('T-A1'), observe({ t: 300, pub: board(cells) }), valley, oracle);
  assert.equal(withOrder.kind, 'take');
  assert.ok(
    cells.some((c) => key(c.q, c.r) === withOrder.key),
    'замовлення открыто, а голова идёт мимо: ' + withOrder.key + ' вместо одной из ' + cells.map((c) => key(c.q, c.r)).join('/'),
  );
  assert.ok(plain, 'без замовлення плана нет вовсе');
});

test('своя погасшая голка важнее новой руины: покрытие уже оплачено (7.4)', () => {
  const b = head({ buildGate: 0 });
  const cut = observe({
    t: 300,
    pulse: { energy: 300 },
    mine: { needles: [{ q: 10, r: -12, dark: true, fed: false, weight: 1 }] },
  });
  const plan = b.pickPlan(unit('T-A1'), cut, valley, oracle);
  assert.equal(plan.kind, 'build', 'вместо моста к своей погасшей голова пошла за новой целью');
  assert.ok(oracle.linkOk(plan.at, { q: 10, r: -12 }), 'мост не дотягивается до погасшей голки');
});

test('залитый заряд тратится на стройку, а не копится (8.9, energyCap 360)', () => {
  const flooded = observe({ t: 300, pulse: { energy: DIALS.flood } });
  const thin = observe({ t: 300, pulse: { energy: DIALS.flood - 1 } });
  assert.equal(head({ buildGate: 0 }).pickPlan(unit('T-A1'), flooded, valley, oracle).kind, 'build');
  assert.equal(head({ buildGate: 0 }).pickPlan(unit('T-A1'), thin, valley, oracle).kind, 'take', 'до порога дорога дешевле стройки');
});

test('живлення — последнее: когда брать и строить нечего (8.5)', () => {
  /* все руины долины разобраны соперниками, заряда на голку нет */
  const b = head();
  for (const k of valley.ruins) b.owner.set(k, 'B');
  const obs = observe({
    t: 300,
    pulse: { energy: 10 },
    mine: { needles: [{ q: 5, r: -12, dark: false, fed: false, weight: 1 }] },
  });
  const plan = b.pickPlan(unit('T-A1'), obs, valley, oracle);
  assert.equal(plan.kind, 'feed');
  assert.deepEqual(plan.at, { q: 5, r: -12 });
});

test('Клинку планы Ткача не выдаются, и наоборот (10.1)', () => {
  const b = head({ klinoks: 1 });
  b.owner.set(key(RUIN.q, RUIN.r), 'B');
  b.dark.set(key(RUIN.q, RUIN.r), false);
  const klinok = b.pickPlan(unit('K-A1', { cls: 'клинок' }), observe({ t: 300 }), valley, oracle);
  assert.equal(klinok.kind, 'jam', 'Клинок получил план Ткача');
  const tkach = b.pickPlan(unit('T-A1'), observe({ t: 300 }), valley, oracle);
  assert.notEqual(tkach.kind, 'jam', 'Ткач получил заваду, которую не умеет (11.1)');
});

test('цель сравнивается по цене дороги с прогревом, а не по одному расстоянию (9.2, 10.5)', () => {
  const b = head();
  /* две ничьи цели: одна рядом, другая дальше — берётся ближняя */
  const obs = observe({ t: 300 });
  const near = b.takePlan(obs, valley, oracle, SEAT, new Set());
  const walkNear = valley.travel(oracle, SEAT, near.at, 'ткач');
  const others = valley.ruins
    .filter((k) => k !== near.key && b.owner.get(k) === null)
    .map((k) => valley.cellOf(k))
    .filter((at) => b.anchors.some((a) => oracle.linkOk(at, a)))
    .map((at) => valley.travel(oracle, SEAT, at, 'ткач'))
    .filter((x) => x !== null);
  assert.ok(others.length, 'сравнивать не с чем');
  assert.ok(walkNear <= Math.max(...others), 'выбрана самая дальняя из доступных целей');
});

test('голка кольца после зори весит больше обычной руины (22.4)', () => {
  const b = head([], []);
  const ring = valley.cellOf(valley.ringKeys[0]);
  /* сеть дотянута и до кольца, и до обычной руины: выбор должен пасть на кольцо */
  b.anchors = [ring, RUIN];
  const plan = b.takePlan(observe({ t: valley.dawnAt + 10 }), valley, oracle, ring, new Set());
  assert.ok(plan, 'после зори цели нет');
  assert.ok(valley.ringKeys.includes(plan.key), 'кольцо тянет вдвое, а выбрана обычная руина');
});

test('верфь: сроки и заряд (10.3, и последние 200 тактов)', () => {
  const at = (t, energy) => observe({ t, pulse: { chanAt: 400, energy } });
  assert.ok(head().yardOrder(at(10, cfg['costTkach']), valley), 'заряда ровно на Ткача, а верфь молчит');
  assert.equal(head().yardOrder(at(10, cfg['costTkach'] - 1), valley), null, 'заказ без заряда');
  assert.equal(head().yardOrder(at(valley.ticks - 199, 300), valley), null, 'поздний Ткач не окупается');
  assert.ok(head().yardOrder(at(valley.ticks - 200, 300), valley), 'на границе окна заказ ещё нужен');

  const reserved = head();
  reserved.reserve = 300;
  assert.equal(reserved.yardOrder(at(10, 300), valley), null, 'верфь съела заряд, отложенный под ставку');
});

test('рой не перебирается через вес 8 (10.2)', () => {
  const b = head({ tkachi: 8 });
  const four = ['T-A1', 'T-A2', 'T-A3', 'T-A4'].map((id) => unit(id));
  assert.equal(
    b.yardOrder(observe({ t: 10, pulse: { chanAt: 400, energy: 900 }, mine: { units: four } }), valley),
    null,
    'пятый Ткач при полном рое',
  );
  const three = four.slice(0, 3);
  assert.ok(b.yardOrder(observe({ t: 10, pulse: { chanAt: 400, energy: 900 }, mine: { units: three } }), valley), 'место есть, а заказа нет');
});

test('что видно и что помнится: свои голки, чужие голки, молчание (26.3)', () => {
  const b = head();
  b.sync(
    observe({
      t: 300,
      own: [
        { q: 2, r: -9, owner: 'B', dark: true },
        { q: 4, r: -8, owner: null, dark: false },
      ],
      mine: { needles: [{ q: 5, r: -12, dark: false, fed: false, weight: 1 }] },
    }),
    valley,
  );
  assert.equal(b.owner.get('2,-9'), 'B');
  assert.equal(b.dark.get('2,-9'), true, 'молчание чужой голки не записано: цена прогрева будет завышена (9.2)');
  assert.equal(b.owner.get('4,-8'), null, 'ничья голка перестала быть ничьей');
  assert.equal(b.owner.get('5,-12'), 'A');
  assert.equal(b.dark.get('5,-12'), false);
});

test('план машины, которой больше нет, забывается', () => {
  const b = head();
  const free = unit('T-A1');
  b.unitOrder(free, observe({ t: 300 }), valley, oracle);
  assert.equal(b.plans.size, 1);
  b.sync(observe({ t: 301, mine: { units: [] } }), valley);
  assert.equal(b.plans.size, 0, 'план погибшей машины держит цель занятой до конца партии');
});

test('такт после зори: верфь молчит и стройка молчит (22.2)', () => {
  /* сеть в кадре — своя, у вершины: think считает нить сам и заданные руками
     якоря затирает, поэтому здесь проверяется только то, что он перестал
     тратить заряд, а выбор кольца — на уровне выбора цели ниже */
  const out = head().think(
    observe({
      t: valley.dawnAt + 1,
      pulse: { chanAt: 400, energy: 300 },
      mine: { units: [unit('T-A1')] },
    }),
  );
  assert.equal(
    out.some((o) => o.kind === 'yard' || o.kind === 'needle'),
    false,
    'после зори голова всё ещё тратит заряд: ' + JSON.stringify(out),
  );
});

test('после зори выбирается кольцо, если нить до него дотянута (22.3, 22.4)', () => {
  const b = head([], []);
  const ring = valley.cellOf(valley.ringKeys[0]);
  b.anchors = [ring];
  const at = { q: ring.q + 1, r: ring.r };
  const plan = b.pickPlan(unit('T-A1', at), observe({ t: valley.dawnAt + 1, pulse: { energy: 300 } }), valley, oracle);
  assert.ok(plan && valley.ringKeys.includes(plan.key), 'кольцо не выбрано: ' + JSON.stringify(plan));
});
