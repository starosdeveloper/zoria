/* Выбор цели: какую руину берём, где ставим голку, что живим, когда ставим на
   лот и что запоминаем из событий такта. Здесь мутируют границы («не дальше»,
   «не раньше», «не ближе»), а цена ошибки — тихая: пресет просто ходит не туда.

   Закрытые методы зовутся напрямую (см. plan.test.js), обстановка — общая
   (world.js). */

import test from 'node:test';
import assert from 'node:assert/strict';
import { key } from '../dist/valley.js';
import { DIALS, HarvestBot } from '../dist/harvest.js';
import { observe, task, unit, manifestBytes } from './frames.js';
import { cfg, head, NONE, oracle, RUIN, SEAT, valley } from './world.js';

test('берём ближнюю ничью руину, которую держит нить (7.2, 9.2)', () => {
  const b = head();
  const plan = b.takePlan(observe({ t: 300 }), valley, oracle, SEAT, NONE);
  assert.ok(plan, 'цели нет вовсе');
  assert.equal(plan.kind, 'take');
  assert.equal(b.owner.get(plan.key), null, 'цель не ничья');
  assert.ok(b.anchors.some((a) => oracle.linkOk(plan.at, a)), 'цель вне длины нити: голка не загорится');
});

test('чужую и свою голку в цели не берём, занятую планом — тоже', () => {
  const b = head();
  const first = b.takePlan(observe({ t: 300 }), valley, oracle, SEAT, NONE);
  b.owner.set(first.key, 'B');
  const second = b.takePlan(observe({ t: 300 }), valley, oracle, SEAT, NONE);
  assert.notEqual(second?.key, first.key, 'цель занята соперником, а мы идём');
  const third = b.takePlan(observe({ t: 300 }), valley, oracle, SEAT, new Set([second.key]));
  assert.notEqual(third?.key, second.key, 'цель уже в чужом плане');
});

test('кольцо Ключника — цель только после зори (22.3)', () => {
  const b = head([], []);
  b.anchors = [valley.cellOf(valley.ringKeys[0])]; // как будто мы уже у кольца
  const ringNear = valley.ringKeys.map((k) => valley.cellOf(k));
  const before = b.takePlan(observe({ t: valley.dawnAt - 1 }), valley, oracle, ringNear[0], NONE);
  assert.equal(
    before && valley.ringKeys.includes(before.key),
    false,
    'до зори целимся в кольцо: Ключник таранит',
  );
  const after = b.takePlan(observe({ t: valley.dawnAt }), valley, oracle, ringNear[0], NONE);
  assert.ok(after && valley.ringKeys.includes(after.key), 'после зори кольцо не берём');
});

test('дальше reach не ходим', () => {
  const near = head({ reach: 12 }).takePlan(observe({ t: 300 }), valley, oracle, SEAT, NONE);
  assert.ok(near, 'при reach 12 цели нет');
  const none = head({ reach: 0 }).takePlan(observe({ t: 300 }), valley, oracle, SEAT, NONE);
  assert.equal(none, null, 'при reach 0 цель всё равно нашлась');
});

test('стоянка у кольца: окно перед зорёй, соседняя сота, одна машина', () => {
  const ring = valley.cellOf(valley.ringKeys[0]);
  const b = head({ stage: 60 }, []);
  b.anchors = [ring];
  const obs = (t) => observe({ t });

  assert.equal(b.stagePlan(obs(valley.dawnAt - 61), valley, oracle, ring, NONE), null, 'окно ещё не открылось');
  const plan = b.stagePlan(obs(valley.dawnAt - 60), valley, oracle, ring, NONE);
  assert.ok(plan, 'в окне стоянки план не выбран');
  assert.equal(plan.kind, 'stage');
  assert.equal(valley.needles.has(plan.key), false, 'стоянка на самой голке провоцирует Ключника (21.6)');
  assert.equal(
    (Math.abs(plan.at.q - ring.q) + Math.abs(plan.at.r - ring.r) + Math.abs(plan.at.q - ring.q + plan.at.r - ring.r)) / 2,
    1,
    'стоянка не рядом с кольцом',
  );
  assert.equal(b.stagePlan(obs(valley.dawnAt), valley, oracle, ring, NONE), null, 'после зори стоять незачем');

  b.plans.set('T-A9', plan);
  assert.equal(b.stagePlan(obs(valley.dawnAt - 30), valley, oracle, ring, NONE), null, 'вторая машина на ту же стоянку');
});

test('живлення: только своя горящая, ненакормленная, в полный вес (8.5)', () => {
  const b = head();
  const mine = (over) => observe({ t: 300, mine: { needles: [{ q: 2, r: -9, dark: false, fed: false, weight: 1, ...over }] } });
  assert.ok(b.feedPlan(mine(), valley, SEAT, NONE), 'кормить некого');
  assert.equal(b.feedPlan(mine({ dark: true }), valley, SEAT, NONE), null, 'погасшую не живим');
  assert.equal(b.feedPlan(mine({ weight: 0.5 }), valley, SEAT, NONE), null, 'жарины не живим');
  assert.equal(b.feedPlan(mine({ fed: true }), valley, SEAT, NONE), null, 'уже накормлена');
  assert.equal(b.feedPlan(mine(), valley, SEAT, new Set(['2,-9'])), null, 'уже в чужом плане');
});

test('замовлення: только пока окно открыто и пока успеваем (18.2, 18.3)', () => {
  const b = head();
  const cells = [RUIN, { q: 4, r: -8 }, { q: 8, r: -9 }];
  const board = (over) => ({
    order: { cells, from: 200, to: 290, bonus: cfg['orderBonus'], holdTicks: cfg['orderHoldTicks'], ...over },
    pact: { active: [], breaks: [] },
    cries: [],
    dawn: false,
    score: [0, 0, 0],
  });
  const plan = b.orderPlan(observe({ t: 210, pub: board() }), valley, oracle, SEAT, NONE);
  assert.ok(plan, 'замовлення рядом, а плана нет');
  assert.ok(cells.some((c) => key(c.q, c.r) === plan.key), 'план не по сотам замовлення');

  assert.equal(b.orderPlan(observe({ t: 291, pub: board() }), valley, oracle, SEAT, NONE), null, 'окно закрылось (18.5)');
  assert.equal(
    b.orderPlan(observe({ t: 289, pub: board() }), valley, oracle, SEAT, NONE),
    null,
    'на дорогу и прогрев до конца окна не хватает',
  );
  assert.equal(b.orderPlan(observe({ t: 210, pub: { ...board(), order: null } }), valley, oracle, SEAT, NONE), null, 'замовлення нет');

  for (const c of cells) b.owner.set(key(c.q, c.r), 'A');
  assert.equal(b.orderPlan(observe({ t: 210, pub: board() }), valley, oracle, SEAT, NONE), null, 'все три уже наши');
});

test('ставка на лот: сроки правила 17.3 и цена по 17.5', () => {
  const lot = valley.lots()[0];
  const b = head();
  b.anchors = [SEAT, ...lot.cells];
  const at = (t, energy) => observe({ t, pulse: { energy } });

  assert.equal(b.bidOrder(at(lot.at - 4, 300), valley, oracle), null, 'рано: конверт ещё подождёт');
  const bid = b.bidOrder(at(lot.at - 1, 300), valley, oracle);
  assert.ok(bid, 'ставка не подана в последний такт окна');
  assert.equal(bid.lot, 0);
  assert.equal(bid.amount, DIALS.bid, 'ставка не по ручке');
  assert.equal(b.reserve, DIALS.bid, 'заряд под ставку не отложен: верфь его потратит');

  assert.equal(b.bidOrder(at(lot.at, 300), valley, oracle), null, 'на такте розкриття — отказ торгов (17.3)');

  const poor = head();
  poor.anchors = [SEAT, ...lot.cells];
  const small = poor.bidOrder(at(lot.at - 1, 70), valley, oracle);
  assert.equal(small.amount, 70, 'ставка выше запаса недействительна на розкритті (17.5)');

  /* заряд копится по 0.25 за такт (8.9), а ставка — целое число (17.3):
     дробная сумма отбивается кодом `торги`, и конверт на лот пропадает */
  const frac = head();
  frac.anchors = [SEAT, ...lot.cells];
  const rounded = frac.bidOrder(at(lot.at - 1, 70.75), valley, oracle);
  assert.equal(Number.isInteger(rounded.amount), true, 'ставка дробная: ' + rounded.amount);
  assert.equal(rounded.amount, 70, 'округление не вниз: запас меньше ставки — отказ на розкритті');

  const broke = head();
  broke.anchors = [SEAT, ...lot.cells];
  assert.equal(broke.bidOrder(at(lot.at - 1, cfg['costNeedle']), valley, oracle), null, 'ставка не выше резерва торгов');
  assert.equal(broke.reserve, cfg['costNeedle'] + 1, 'заряд под будущую ставку не придержан');

  const far = head();
  far.anchors = [SEAT];
  assert.equal(far.bidOrder(at(lot.at - 1, 300), valley, oracle), null, 'лот вне нити: голки не загорятся');
});

test('события такта запоминаются: кто взял, кто глушит, что вышло с верфи', () => {
  const b = head();
  const k = key(RUIN.q, RUIN.r);
  b.pending['ткач'] = 1;
  b.yardAt = 300;
  b.sync(
    observe({
      t: 300,
      events: [
        { type: 'cap', p: 'B', q: RUIN.q, r: RUIN.r, from: null, ring: false },
        { type: 'jam', p: 'C', q: 5, r: -12, own: 'A' },
        { type: 'build', p: 'A', cls: 'ткач' },
        { type: 'raise', p: 'C', q: 3, r: -9 },
      ],
    }),
    valley,
  );
  assert.equal(b.owner.get(k), 'B', 'захват чужим не записан');
  assert.equal(b.capAt.get(k), 300, 'пауза после взятия не отмечена (9.3)');
  assert.equal(b.jamAt.get('5,-12'), 300, 'завада по своей голке не отмечена');
  assert.equal(b.owner.get('3,-9'), 'C', 'чужая новая голка не записана');
  assert.equal(b.pending['ткач'], 0, 'корпус вышел с верфи, а счётчик держит');
});

test('лот достался сопернику — соты записаны за ним (17.6)', () => {
  const b = head();
  const lot = valley.lots()[1];
  b.sync(observe({ t: 400, events: [{ type: 'lot', lot: 1, p: 'B' }] }), valley);
  for (const c of lot.cells) assert.equal(b.owner.get(key(c.q, c.r)), 'B');

  const nobody = head();
  nobody.sync(observe({ t: 400, events: [{ type: 'lot', lot: 1, p: null }] }), valley);
  for (const c of lot.cells) assert.equal(nobody.owner.get(key(c.q, c.r)), null, 'лот никому — соты остались ничьими');
});

test('потерянная голка записывается за новым владельцем (14.12)', () => {
  const b = head();
  b.sync(observe({ t: 300, mine: { losts: [{ q: 5, r: -12, t: 299, owner: 'C', dark: false }] } }), valley);
  assert.equal(b.owner.get('5,-12'), 'C');
});

test('вершина определяется по своим стартовым голкам, а не по букве слота (5.4)', () => {
  const b = new HarvestBot();
  b.init(manifestBytes, 'A');
  /* кадр вершины C: если голова поверит букве, она будет считать нить от чужого вогнища */
  b.fixSeat(observe({ mine: { needles: [{ q: -11, r: 5, dark: false, fed: false, weight: 1 }] } }));
  assert.deepEqual(b.hearth, valley.seat('C'));
  b.fixSeat(observe({ mine: { needles: [{ q: 5, r: -12, dark: false, fed: false, weight: 1 }] } }));
  assert.deepEqual(b.hearth, valley.seat('C'), 'вершина определяется один раз за партию');
});

test('план машины не выдаётся посреди шага и не дублируется', () => {
  const b = head();
  const walking = unit('T-A1', { wait: 1, task: task({ path: 2 }) });
  assert.equal(b.unitOrder(walking, observe({ t: 300 }), valley, oracle), null, 'команда машине посреди шага (10.6)');
  const free = unit('T-A2');
  const first = b.unitOrder(free, observe({ t: 300 }), valley, oracle);
  assert.ok(first, 'свободной машине плана не дали');
  assert.equal(b.plans.size, 1, 'план не запомнен');
});

test('Клинок глушит ближнюю чужую горящую голку у своей сети (8.7, 10.8)', () => {
  const b = head({ klinoks: 1 });
  b.owner.set(key(RUIN.q, RUIN.r), 'B');
  b.dark.set(key(RUIN.q, RUIN.r), false);
  const plan = b.jamPlan(observe({ t: 300 }), valley, SEAT, NONE);
  assert.ok(plan, 'цель для завады не выбрана');
  assert.equal(plan.kind, 'jam');
  assert.deepEqual(plan.at, RUIN);

  /* та же голка, но далеко от нашей сети: Клинок там жил бы на повідці */
  const lone = head({ klinoks: 1 }, []);
  lone.anchors = [SEAT];
  const far = valley.cellOf(valley.ruins.find((k) => valley.cellOf(k).q < -8));
  lone.owner.set(key(far.q, far.r), 'B');
  lone.dark.set(key(far.q, far.r), false);
  assert.equal(lone.jamPlan(observe({ t: 300 }), valley, SEAT, NONE), null, 'цель вне зоны связи');

  assert.equal(b.jamPlan(observe({ t: valley.dawnAt }), valley, SEAT, NONE), null, 'после зори заваду не начинаем');
});
