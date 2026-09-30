/* Последовательности пресета: что он подаёт в такт и, главное, чего не подаёт.
   Ошибка здесь ничего не печатает — партия просто идёт хуже, а половина
   отказов приходит на машины, которым нельзя было писать. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { HarvestBot } from '../dist/harvest.js';
import { manifestBytes, observe, task, unit } from './frames.js';

const head = () => {
  const b = new HarvestBot();
  b.init(manifestBytes, 'A');
  return b;
};

test('первый такт: один Ткач с верфи и больше ничего', () => {
  const out = head().think(observe());
  assert.deepEqual(out, [{ kind: 'yard', cls: 'ткач' }]);
});

test('заряда меньше цены Ткача — верфь молчит (А.1 costTkach 90)', () => {
  const out = head().think(observe({ pulse: { energy: 89 } }));
  assert.equal(
    out.some((o) => o.kind === 'yard'),
    false,
  );
});

test('машине посреди шага не пишут: правило 10.6, отказ «поворот»', () => {
  const walking = unit('T-A1', { wait: 2, task: task({ goal: { q: 1, r: -6 }, path: 4 }) });
  const out = head().think(observe({ t: 40, mine: { units: [walking] } }));
  assert.equal(
    out.some((o) => o.unit === 'T-A1'),
    false,
  );
});

test('канал расписан руками — платных команд нет: правила 13.6 и 13.7', () => {
  /* 141 байт канала (13.3) и четыре машины в работе: руки стоят 128, на
     команду остаётся 13. Наверх уходит только удержание слота. */
  const busy = ['T-A1', 'T-A2', 'T-A3', 'T-A4'].map((id) =>
    unit(id, { q: 4, r: -10, task: task({ goal: { q: 3, r: -9 }, path: 3 }) }),
  );
  const out = head().think(observe({ t: 100, mine: { units: busy } }));
  assert.ok(out.length <= 1, 'не больше одной команды: ' + JSON.stringify(out));
  if (out.length) assert.ok(out[0].kind === 'halt' || out[0].kind === 'watch', 'только удержание слота, а не работа');
});

test('слот не отдаётся приказу: непустой кадр чаще чем раз в 6 тактов (23.2)', () => {
  const bot = head();
  const busy = ['T-A1', 'T-A2', 'T-A3', 'T-A4'].map((id) =>
    unit(id, { q: 4, r: -10, task: task({ goal: { q: 3, r: -9 }, path: 3 }) }),
  );
  let gap = 0;
  let worst = 0;
  for (let t = 1; t <= 40; t++) {
    const out = bot.think(observe({ t, mine: { units: busy } }));
    gap = out.length ? 0 : gap + 1;
    worst = Math.max(worst, gap);
  }
  assert.ok(worst < 6, 'подряд молчащих тактов: ' + worst);
});

test('до зори в межу не целятся: правило 21.6', () => {
  const bot = head();
  /* Ткач стоит у самой межи с полным каналом и свободными руками */
  const free = unit('T-A1', { q: 0, r: 8 });
  const out = bot.think(observe({ t: 300, pulse: { chanAt: 400, energy: 200 }, mine: { units: [free] } }));
  for (const o of out) {
    if (o.q === undefined) continue;
    const inside = (Math.abs(o.q) + Math.abs(o.r) + Math.abs(o.q + o.r)) / 2 <= 6;
    assert.equal(inside && (o.kind === 'move' || o.kind === 'needle'), false, 'цель в меже: ' + JSON.stringify(o));
  }
});

test('отказ по земле запоминается, план снимается (12.2)', () => {
  const bot = head();
  const builder = unit('T-A1', { q: 8, r: -10 });
  const out = bot.think(observe({ t: 300, pulse: { chanAt: 400, energy: 300 }, mine: { units: [builder] } }));
  if (!out.length) return;
  bot.feedback(new Uint8Array(0)); // кривые байты вердикта не должны ронять голову
  bot.seen(out.map((_, i) => [i, false, 11]));
  const again = bot.think(observe({ t: 301, pulse: { chanAt: 400, energy: 300 }, mine: { units: [builder] } }));
  assert.notDeepEqual(again, out, 'после отказа по земле голова повторяет ту же команду');
});
