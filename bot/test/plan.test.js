/* Решения пресета по частям: цены прогрева, пригодность майданчика, что
   считается горящей нитью, что считается погасшим, и когда план закончен.
   Это те самые условия и границы, которые мутируют: одна перевёрнутая
   проверка здесь не печатает ничего — партия просто идёт хуже.

   Проверки зовут закрытые методы напрямую: `private` в TypeScript — правило
   сборки, а не защита в исполнении, и мерить надо тот код, который поедет. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { key } from '../dist/valley.js';
import { observe, task, unit } from './frames.js';
import { bareHead as head, cfg, manifest, RING, RUIN, SITE, START_B, valley } from './world.js';

test('цены прогрева — вся таблица правила 9.2', () => {
  const b = head();
  const k = key(RUIN.q, RUIN.r);
  assert.equal(b.heatTicks(k, valley, 100), cfg['heatNeedle'], 'ничья руина');

  b.owner.set(k, 'B');
  b.dark.set(k, false);
  assert.equal(b.heatTicks(k, valley, 100), cfg['heatEnemy'], 'чужая горящая');

  b.dark.set(k, true);
  assert.equal(b.heatTicks(k, valley, 100), cfg['heatDark'], 'чужая мовчазна — дешевле');

  const ringK = key(RING.q, RING.r);
  assert.equal(b.heatTicks(ringK, valley, 100), cfg['heatEnemy'], 'голка кольца до зори');
  assert.equal(b.heatTicks(ringK, valley, valley.dawnAt), cfg['heatNeedle'], 'после зори — как ничья');
});

test('гріти можно не всё: правило 9.3 и межа до зори', () => {
  const b = head();
  const k = key(RUIN.q, RUIN.r);
  assert.equal(b.heatable(k, RUIN.q, RUIN.r, valley, 100), true, 'ничья руина вне межи');

  b.owner.set(k, 'A');
  assert.equal(b.heatable(k, RUIN.q, RUIN.r, valley, 100), false, 'своя голка');

  b.owner.set(k, null);
  b.capAt.set(k, 100);
  assert.equal(b.heatable(k, RUIN.q, RUIN.r, valley, 100 + cfg['capGrace'] - 1), false, 'пауза после взятия');
  assert.equal(b.heatable(k, RUIN.q, RUIN.r, valley, 100 + cfg['capGrace']), true, 'пауза кончилась');

  assert.equal(b.heatable(key(START_B.q, START_B.r), START_B.q, START_B.r, valley, 100), false, 'стартовая под щитом');
  assert.equal(b.heatable('0,0', 0, 0, valley, 100), false, 'сота без голки');

  const ringK = key(RING.q, RING.r);
  assert.equal(b.heatable(ringK, RING.q, RING.r, valley, 100), false, 'кольцо до зори — внутри межи');
  assert.equal(b.heatable(ringK, RING.q, RING.r, valley, valley.dawnAt), true, 'после зори Ключника нет');
});

test('майданчик: условия правила 12.2', () => {
  const b = head();
  const free = { q: 3, r: -9 };
  assert.equal(b.buildable(key(free.q, free.r), free, valley), true, 'обычная сота вне межи');

  const onNeedle = RUIN;
  assert.equal(b.buildable(key(onNeedle.q, onNeedle.r), onNeedle, valley), false, 'на соте с голкой');
  assert.equal(b.buildable('0,6', { q: 0, r: 6 }, valley), false, 'внутри межи');
  assert.equal(b.buildable('30,0', { q: 30, r: 0 }, valley), false, 'за краем долины');

  const seat = valley.seat('A');
  assert.equal(b.buildable(key(seat.q, seat.r + 1), { q: seat.q, r: seat.r + 1 }, valley), false, 'ближе 2 от вогнища');
  assert.equal(b.buildable(key(seat.q + 3, seat.r), { q: seat.q + 3, r: seat.r }, valley), true, 'дальше 2 от вогнища');

  /* голка, поставленная в бою, в манифест не входит (26.2) — значит знать о ней
     можно только из памяти, и сота обязана перестать быть майданчиком */
  const raised = head();
  const spot = { q: SITE.q, r: SITE.r };
  const spotK = key(spot.q, spot.r);
  assert.equal(raised.buildable(spotK, spot, valley), true, 'свободная сота не годится в майданчик');
  raised.sync(observe({ t: 300, events: [{ type: 'raise', p: 'A', q: spot.q, r: spot.r }] }), valley);
  assert.equal(raised.buildable(spotK, spot, valley), false, 'на соте уже стоит своя голка, а майданчик годен');

  const seen = head();
  seen.sync(observe({ t: 300, own: [{ q: spot.q, r: spot.r, owner: 'B', dark: false }] }), valley);
  assert.equal(seen.buildable(spotK, spot, valley), false, 'чужую голку на соте не учли');

  const dead = [...valley.finds].find(([, kind]) => kind === 'dead');
  if (dead) {
    const at = valley.cellOf(dead[0]);
    assert.equal(b.buildable(dead[0], at, valley), false, 'гибла сота (16.6)');
  }

  const water = manifest.terrain.cells.find(([, , t]) => !manifest.terrain.types[t].pass);
  if (water) {
    const at = { q: water[0], r: water[1] };
    assert.equal(b.buildable(key(at.q, at.r), at, valley), false, 'непрохідна земля');
  }
});

test('нить держат только голки, горящие в полный вес (7.2, 7.4)', () => {
  const b = head();
  const anchors = b.litAnchors(
    observe({
      mine: {
        needles: [
          { q: 5, r: -12, dark: false, fed: false, weight: 1 },
          { q: 7, r: -13, dark: true, fed: false, weight: 1 },
          { q: 2, r: -9, dark: false, fed: false, weight: 0.5 },
        ],
      },
    }),
  );
  const keys = anchors.map((a) => key(a.q, a.r));
  assert.ok(keys.includes('6,-12'), 'вогнище — первая ланка цепи');
  assert.ok(keys.includes('5,-12'), 'горящая голка');
  assert.equal(keys.includes('7,-13'), false, 'заглушенная нить не проводит (7.3)');
  assert.equal(keys.includes('2,-9'), false, 'жарины нить не держат (7.4)');
  assert.equal(anchors.length, 2);
});

test('руки берут и Ткач без задания на голке, и никогда — Клинок (13.6, 13.6а)', () => {
  const b = head();
  b.t = 100;
  const at = { q: RUIN.q, r: RUIN.r };
  const tkach = unit('T-A1', { ...at });
  assert.equal(b.acting(tkach, valley), true, 'Ткач на голке, которую можно гріти');

  b.owner.set(key(at.q, at.r), 'A');
  assert.equal(b.acting(tkach, valley), false, 'своя голка: гріти нечего');

  b.owner.set(key(at.q, at.r), null);
  assert.equal(b.acting(unit('K-A1', { cls: 'клинок', ...at }), valley), false, 'Клинок не гріє');
  assert.equal(b.acting(unit('T-A2', { q: 6, r: -12 }), valley), false, 'на соте без голки и без задания');
  assert.equal(b.acting(unit('T-A3', { q: 6, r: -12, task: task({ goal: at }) }), valley), true, 'задание есть — руки нужны');
});

test('погасшая своя голка: обрыв нити чинится мостом, завада — нет (7.4, 11.4)', () => {
  const b = head();
  const dark = [{ q: 5, r: -12, dark: true, fed: false, weight: 1 }];
  assert.deepEqual(b.cutNeedles(observe({ t: 200, mine: { needles: dark } }), valley), [{ q: 5, r: -12 }]);

  b.jamAt.set('5,-12', 200 - cfg['jamHold'] + 1);
  assert.deepEqual(b.cutNeedles(observe({ t: 200, mine: { needles: dark } }), valley), [], 'заглушенную мостом не вернуть');

  b.jamAt.set('5,-12', 200 - cfg['jamHold']);
  assert.equal(b.cutNeedles(observe({ t: 200, mine: { needles: dark } }), valley).length, 1, 'завада истекла — это обрыв');

  const lit = [{ q: 5, r: -12, dark: false, fed: false, weight: 1 }];
  assert.deepEqual(b.cutNeedles(observe({ t: 200, mine: { needles: lit } }), valley), []);
});

test('отказанная цель откладывается на forget тактов, и только она', () => {
  const b = head({ forget: 30 });
  b.t = 100;
  const busy = new Set(['1,1']);
  assert.equal(b.off('1,1', busy), true, 'занято чужим планом');
  assert.equal(b.off('2,2', busy), false);
  b.badGoal.set('2,2', 100);
  assert.equal(b.off('2,2', busy), true);
  b.t = 129;
  assert.equal(b.off('2,2', busy), true, 'окно ещё не вышло');
  b.t = 130;
  assert.equal(b.off('2,2', busy), false, 'окно вышло — цель снова годна');
});

test('план закончен ровно тогда, когда его причина исчезла', () => {
  const b = head();
  const at = { q: RUIN.q, r: RUIN.r };
  const k = key(at.q, at.r);
  const plan = (kind) => ({ kind, at, key: k, since: 0 });
  const obs = (over) => observe({ t: 300, ...over });

  assert.equal(b.planDone(plan('take'), obs(), valley), false, 'руина ещё ничья');
  b.owner.set(k, 'A');
  assert.equal(b.planDone(plan('take'), obs(), valley), true, 'голка взята');

  assert.equal(b.planDone(plan('feed'), obs({ mine: { needles: [{ ...at, dark: false, fed: false, weight: 1 }] } }), valley), false);
  assert.equal(b.planDone(plan('feed'), obs({ mine: { needles: [{ ...at, dark: true, fed: false, weight: 1 }] } }), valley), true, 'живлення погасшей голки');
  b.owner.set(k, 'B');
  assert.equal(b.planDone(plan('feed'), obs(), valley), true, 'голка уже не наша');

  assert.equal(b.planDone(plan('jam'), obs(), valley), false, 'чужая горящая — глушить есть что');
  b.dark.set(k, true);
  assert.equal(b.planDone(plan('jam'), obs(), valley), true, 'погасшая здобичи не даёт');
  b.dark.set(k, false);
  b.owner.set(k, 'K');
  assert.equal(b.planDone(plan('jam'), obs(), valley), true, 'голка Ключника — не цель завады');
  b.owner.set(k, null);
  assert.equal(b.planDone(plan('jam'), obs(), valley), true, 'ничью не глушат (11.3)');

  /* майданчик — сота без голки: RUIN голка носит, и стройка на ней закончена
     по первому же условию */
  const site = { q: 3, r: -9 };
  const siteK = key(site.q, site.r);
  const sitePlan = { kind: 'build', at: site, key: siteK, since: 0 };
  assert.equal(b.planDone(sitePlan, obs(), valley), false, 'майданчик свободен');
  assert.equal(b.planDone(plan('build'), obs(), valley), true, 'на соте уже стоит голка');
  b.badSite.add(siteK);
  assert.equal(b.planDone(sitePlan, obs(), valley), true, 'земля отказала');

  assert.equal(b.planDone(plan('stage'), obs({ t: valley.dawnAt - 1 }), valley), false, 'зори ещё нет');
  assert.equal(b.planDone(plan('stage'), obs({ t: valley.dawnAt }), valley), true, 'зоря настала');
});

test('шаг плана: стоять и гріти, живити на месте, строить на месте', () => {
  const b = head();
  const at = { q: RUIN.q, r: RUIN.r };
  const k = key(at.q, at.r);
  const plan = (kind) => ({ kind, at, key: k, since: 0 });
  const here = unit('T-A1', { ...at });
  const away = unit('T-A1', { q: 6, r: -12 });

  assert.equal(b.planStep(plan('take'), here), null, 'стоянка на голке и есть прогрев');
  assert.equal(b.planStep(plan('stage'), here), null, 'стоянка у кольца — ничего не подавать');
  assert.deepEqual(b.planStep(plan('take'), away), { kind: 'move', unit: 'T-A1', q: at.q, r: at.r, goal: null, home: false });
  assert.equal(b.planStep(plan('take'), unit('T-A1', { q: 6, r: -12, task: task({ path: 3 }) })), null, 'шлях уже проложен');

  assert.deepEqual(b.planStep(plan('feed'), here), { kind: 'feed', unit: 'T-A1', q: at.q, r: at.r });
  assert.equal(b.planStep(plan('feed'), unit('T-A1', { ...at, task: task({ feed: at }) })), null, 'живлення уже стоит');

  /* стройка — на свободной соте: на соте с голкой команда вернулась бы отказом,
     и шаг плана обязан это увидеть сам, а не узнать от воротаря */
  const site = { q: SITE.q, r: SITE.r };
  const sitePlan = { kind: 'build', at: site, key: key(site.q, site.r), since: 0 };
  const atSite = unit('T-A1', { ...site });
  assert.deepEqual(b.planStep(sitePlan, atSite), { kind: 'needle', unit: 'T-A1', q: site.q, r: site.r });
  assert.equal(b.planStep(sitePlan, unit('T-A1', { ...site, task: task({ site }) })), null, 'стройка уже идёт');
  assert.equal(b.planStep(sitePlan, unit('K-A1', { cls: 'клинок', ...site })), null, 'Клинок не строит (12.5)');
  assert.equal(b.planStep(plan('build'), here), null, 'стройка на соте с голкой: отказ не подаётся вовсе');
  assert.equal(b.badSite.has(k), true, 'негодная сота не запомнена');
});

test('занятая сота целью не называется: отказ `земля` стоит балла K3 (10.7)', () => {
  const b = head();
  const at = { q: RUIN.q, r: RUIN.r };
  const plan = { kind: 'take', at, key: key(at.q, at.r), since: 0 };
  const away = unit('T-A1', { q: 6, r: -12 });
  assert.ok(b.planStep(plan, away), 'сота свободна, а хода нет');

  b.bodies.set(key(at.q, at.r), 'K-B7'); // чужая машина стоит на цели
  assert.equal(b.planStep(plan, away), null, 'ход на занятую соту подан');

  b.bodies.set(key(at.q, at.r), 'T-A1'); // на цели стоит она сама
  assert.ok(b.planStep(plan, unit('T-A1', { q: 6, r: -12 })), 'своё же тело приняли за помеху');
});

test('фокус ставится не чаще раза в 40 тактов и только на работу', () => {
  const b = head();
  const working = [unit('T-A1', { q: 2, r: -9, task: task({ goal: { q: 2, r: -9 } }) })];
  const first = b.watchOrder(observe({ t: 100, mine: { units: working } }), valley, 2);
  assert.deepEqual(first, { kind: 'watch', q: 2, r: -9, keep: 0 });
  assert.equal(b.watchOrder(observe({ t: 120, mine: { units: working } }), valley, 2), null, 'раньше 40 тактов');
  assert.equal(b.watchOrder(observe({ t: 200, mine: { units: working } }), valley, 2), null, 'работа там же, где фокус');
  assert.equal(b.watchOrder(observe({ t: 100, mine: { units: [unit('T-A1')] } }), valley, 2), null, 'машин в работе нет');
  assert.equal(b.watchOrder(observe({ t: 300, mine: { units: working } }), valley, 0), null, 'канала на команду нет');
});

test('удержание слота: halt простаивающей машине бесплатен, иначе watch (23.2, 13.4)', () => {
  const b = head({ quiet: 3 });
  b.lastOk = 100;
  const idle = unit('T-A1');
  const busy = unit('T-A2', { task: task({ goal: { q: 1, r: 1 }, path: 2 }) });

  assert.equal(b.keepAlive(observe({ t: 102, mine: { units: [idle] } }), valley), null, 'молчания ещё нет');
  assert.deepEqual(b.keepAlive(observe({ t: 103, mine: { units: [idle] } }), valley), { kind: 'halt', unit: 'T-A1' });
  assert.equal(
    b.keepAlive(observe({ t: 103, mine: { units: [unit('T-A1', { wait: 2 })] } }), valley).kind,
    'watch',
    'машине посреди шага halt не подать (10.6)',
  );
  assert.equal(b.keepAlive(observe({ t: 103, mine: { units: [busy] } }), valley).kind, 'watch');
  assert.equal(
    b.keepAlive(observe({ t: 103, pulse: { chanAt: 31 }, mine: { units: [busy] } }), valley),
    null,
    'на watch не хватает канала',
  );
});
