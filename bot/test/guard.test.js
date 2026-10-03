/* Клинок-сторож: таран чужого Ткача, который стоит на нашей голке и греет её
   (9.2). Таран по Ткачу за работой чистый (11.7): Клинок жив, голка цела, у
   соперника минус Ткач. Замер до этой правки: 11–36 осад за партию на виду и
   10–35 потерянных голок, — голова их видела и ничего не делала.

   Ошибки здесь тихие: таран по своей или чужой-но-не-нашей соте принимается и
   тратит Клинка, а осада идёт дальше. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { key } from '../dist/valley.js';
import { observe, task, unit } from './frames.js';
import { head, hexDist, RUIN, SEAT, SITE, valley } from './world.js';

const GUARD = { guard: 1, klinoks: 1, tkachi: 3, jamChan: 0 };
const foe = (id, at, over = {}) => ({ id, p: 'B', cls: 'ткач', q: at.q, r: at.r, ...over });
const klinok = (at, over = {}) => unit('K-A1', { cls: 'клинок', q: at.q, r: at.r, ...over });

test('цель сторожа — чужой Ткач на нашей голке, ближайший', () => {
  const b = head(GUARD);
  b.owner.set(key(RUIN.q, RUIN.r), 'A');
  b.owner.set(key(SITE.q, SITE.r), 'A');
  const far = { q: SITE.q + 3, r: SITE.r };
  b.owner.set(key(far.q, far.r), 'A');
  const obs = observe({ t: 300, foe: [foe('T-B9', far), foe('T-B1', RUIN), foe('T-B2', SITE)] });
  /* Клинок вплотную к RUIN: до неё 1, до SITE 2, до дальней 5 */
  const from = { q: 2, r: -10 };
  assert.deepEqual([hexDist(from, RUIN), hexDist(from, SITE), hexDist(from, far)], [1, 2, 5]);
  const plan = b.guardPlan(obs, from, new Set());
  assert.ok(plan, 'осаду на виду пропустили');
  assert.equal(plan.kind, 'ram');
  assert.equal(plan.target, 'T-B1');
  assert.deepEqual(plan.at, RUIN);
});

test('не цель: чужой Клинок, чужой Ткач не на нашей голке, ничья руина', () => {
  const b = head(GUARD);
  b.owner.set(key(RUIN.q, RUIN.r), 'A');
  b.owner.set(key(SITE.q, SITE.r), 'B');
  const obs = observe({
    t: 300,
    foe: [foe('K-B1', RUIN, { cls: 'клинок' }), foe('T-B2', SITE), foe('T-C3', { q: 0, r: -4 }, { p: 'C' })],
  });
  assert.equal(b.guardPlan(obs, SEAT, new Set()), null);
});

test('Ткач Ключника на нашей голке кольца — тоже цель: таран его машин ответа не вызывает (21.5)', () => {
  const b = head(GUARD);
  b.owner.set(key(RUIN.q, RUIN.r), 'A');
  const plan = b.guardPlan(observe({ t: 300, foe: [foe('T-K1', RUIN, { p: 'K' })] }), SEAT, new Set());
  assert.equal(plan?.target, 'T-K1');
});

test('за одной целью не гонятся двое', () => {
  const b = head(GUARD);
  b.owner.set(key(RUIN.q, RUIN.r), 'A');
  const obs = observe({ t: 300, foe: [foe('T-B1', RUIN)] });
  assert.equal(b.guardPlan(obs, SEAT, new Set([key(RUIN.q, RUIN.r)])), null);
});

test('погоня кончается: ушёл с голки, пропал из вида, голка стала чужой', () => {
  const b = head(GUARD);
  const k = key(RUIN.q, RUIN.r);
  b.owner.set(k, 'A');
  const plan = { kind: 'ram', at: RUIN, key: k, since: 300, target: 'T-B1' };
  assert.equal(b.planDone(plan, observe({ t: 301, foe: [foe('T-B1', RUIN)] }), valley), false, 'осада идёт');
  assert.equal(b.planDone(plan, observe({ t: 301, foe: [foe('T-B1', SITE)] }), valley), true, 'ушёл с нашей голки');
  assert.equal(b.planDone(plan, observe({ t: 301, foe: [] }), valley), true, 'пропал из вида (11.6)');
  b.owner.set(k, 'B');
  assert.equal(b.planDone(plan, observe({ t: 301, foe: [foe('T-B1', RUIN)] }), valley), true, 'голку взяли — спасать нечего');
});

test('таран подаётся один раз: погоню ведёт вузол', () => {
  const b = head(GUARD);
  const plan = { kind: 'ram', at: RUIN, key: key(RUIN.q, RUIN.r), since: 300, target: 'T-B1' };
  assert.deepEqual(b.planStep(plan, klinok(SEAT)), { kind: 'ram', unit: 'K-A1', target: 'T-B1' });
  assert.equal(b.planStep(plan, klinok(SEAT, { task: task({ ram: 'T-B1', path: 3 }) })), null, 'повтор тарана посреди погони');
  assert.deepEqual(
    b.planStep(plan, klinok(SEAT, { task: task({ ram: 'T-B7', path: 3 }) })),
    { kind: 'ram', unit: 'K-A1', target: 'T-B1' },
    'гонится не за тем',
  );
  assert.equal(b.planStep({ ...plan, target: undefined }, klinok(SEAT)), null, 'таран без цели');
});

test('Клинок со сторожем таранит, без сторожа — глушит', () => {
  const k = key(RUIN.q, RUIN.r);
  const guard = head(GUARD);
  guard.owner.set(k, 'A');
  const obs = observe({ t: 300, foe: [foe('T-B1', RUIN)] });
  assert.equal(guard.pickPlan(klinok(SEAT), obs, valley, null)?.kind, 'ram');

  const jam = head({ guard: 0, klinoks: 1, jamChan: 0 });
  jam.owner.set(k, 'A');
  assert.notEqual(jam.pickPlan(klinok(SEAT), obs, valley, null)?.kind, 'ram', 'без сторожа Клинок таранит');
});
