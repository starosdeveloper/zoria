/* Стан голови в слоті: снимок для служебного порта, смена пресета, обёртка
   такта с дневником и строка конца партии. Раньше всё это жило в теле
   `main.ts` и исполнялось при импорте — проверить его можно было только
   запуском процесса против вузла, и 171 мутант провода не был убит ничем.

   Ожидаемые строки и числа записаны целиком, литералом: проверка, которая
   собирает ожидание той же арифметикой, что и код, соглашается с любой его
   ошибкой. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeObserve } from '@zoria/protocol';
import { IDLE, quantile, Seat } from '../dist/seat.js';
import { Refusal } from '../dist/status.js';
import { HARVEST, presets } from '../dist/strategy.js';
import { manifestBytes, observe } from './frames.js';

const OPT = { preset: HARVEST, freeze: false, engine: '264a77c2a540ffff', beliefFile: '' };

const STATS = { ticks: 1198, orders: 1200, nacks: 0, bytesIn: 900, bytesOut: 800, resyncMs: 12, resumes: 1, faults: 0, deferred: 2, lastTickAt: 77 };

/** Провод после присяги: ровно те поля BotRun, которые голова читает. */
const fakeRun = () => ({
  slot: 'B',
  ack: { ticks: 1200, engine: '264a77c2a540aaaa' },
  stats: { ...STATS },
  done: new Promise(() => {}),
  close() {},
});

/** Ловит отказ головы и отдаёт [код, слово]; не отказ — провал проверки. */
function refusal(fn) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof Refusal, 'не Refusal: ' + String(e));
    return [e.code, e.message];
  }
  assert.fail('отказа не было');
}

test('до присяги снимок честно пустой: лобби, слота нет, требуемый хеш рушія', () => {
  const s = new Seat(OPT, Date.now() - 5000);
  const st = s.head.state();
  assert.equal(st.state, 'lobby');
  assert.equal(st.slot, null);
  assert.equal(st.preset, 'жатва');
  assert.equal(st.freeze, false);
  assert.equal(st.ticks, 0);
  assert.equal(st.tick, 0);
  assert.equal(st.frames, 0);
  assert.equal(st.why, '');
  assert.equal(st.engine, '264a77c2a540ffff', 'до присяги показывается хеш, которого требуем');
  assert.deepEqual(st.stats, { ticks: 0, orders: 0, nacks: 0, bytesIn: 0, bytesOut: 0, resyncMs: 0, resumes: 0, faults: 0, deferred: 0, lastTickAt: 0 });
  assert.deepEqual(st.belief, { frames: 0, ageMs: 0 }, 'дневник без единой записи не может быть старым');
  assert.ok(st.uptimeMs >= 5000 && st.uptimeMs < 60000, 'возраст головы: ' + st.uptimeMs);
  assert.deepEqual(st.presets, presets(), 'служебный порт должен видеть тот же список, по которому решает promote');

  /* снимок отдаёт копию: служебный порт не должен портить счётчики простоя */
  st.stats.orders = 99;
  assert.equal(IDLE.orders, 0, 'снимок отдал сам IDLE, а не копию');
  assert.equal(s.head.state().stats.orders, 0);
});

test('после присяги снимок берёт место, такты и хеш у провода', () => {
  const s = new Seat(OPT);
  s.run = fakeRun();
  s.phase = 'live';
  s.why = '';
  s.onTick(742, 740);
  const st = s.head.state();
  assert.equal(st.state, 'live');
  assert.equal(st.slot, 'B');
  assert.equal(st.ticks, 1200);
  assert.equal(st.engine, '264a77c2a540aaaa', 'хеш должен быть тем, что подтвердил вузол');
  assert.equal(st.tick, 742);
  assert.equal(st.frames, 740, 'разница tick и frames — это пропуски, её нельзя терять');
  assert.deepEqual(st.stats, STATS);
  st.stats.orders = 0;
  assert.equal(s.run.stats.orders, 1200, 'снимок отдал счётчики провода по ссылке');
});

test('кадр без заголовка такта не сбрасывает такт, но считается', () => {
  const s = new Seat(OPT);
  s.onTick(300, 299);
  s.onTick(null, 300);
  assert.equal(s.tick, 300);
  assert.equal(s.frames, 300);
  s.onTick(0, 301);
  assert.equal(s.tick, 0, 'такт 0 — тоже такт, а не «нет такта»');
});

test('смена пресета: имя проверяется первым, потом бой, потом заморозка', () => {
  const s = new Seat(OPT);
  assert.deepEqual(refusal(() => s.head.promote(undefined)), [400, 'preset']);
  assert.deepEqual(refusal(() => s.head.promote(7)), [400, 'preset']);
  assert.deepEqual(refusal(() => s.head.promote('нет такого')), [400, 'preset']);

  s.phase = 'live';
  assert.deepEqual(refusal(() => s.head.promote('шир')), [409, 'live'], 'смена игрока посреди боя');
  assert.deepEqual(refusal(() => s.head.promote('нет такого')), [400, 'preset'], 'кривое имя важнее фазы');
  assert.equal(s.preset, 'жатва');

  const frozen = new Seat({ ...OPT, freeze: true });
  assert.deepEqual(refusal(() => frozen.head.promote('шир')), [409, 'freeze']);
  frozen.phase = 'live';
  assert.deepEqual(refusal(() => frozen.head.promote('шир')), [409, 'live'], 'бой называется раньше заморозки');
  assert.equal(frozen.head.state().freeze, true);
});

test('принятая смена пресета меняет и имя, и саму голову', () => {
  const s = new Seat(OPT);
  const before = s.strategy;
  assert.equal(before.constructor.name, 'HarvestStrategy');
  s.phase = 'done';
  assert.equal(s.head.promote('шир'), 'шир');
  assert.equal(s.preset, 'шир');
  assert.equal(s.head.state().preset, 'шир');
  assert.equal(s.strategy.constructor.name, 'MirrorStrategy', 'имя сменилось, а голова осталась прежней');

  assert.equal(s.head.promote(HARVEST), 'жатва');
  assert.equal(s.strategy.constructor.name, 'HarvestStrategy');
  assert.notEqual(s.strategy, before, 'между партиями память не переносится (25.4): нужна новая голова');
});

test('провод зовёт ту голову, что стоит сейчас, а не ту, что была при старте', () => {
  const s = new Seat(OPT);
  const calls = [];
  s.strategy = {
    init: (m, slot) => calls.push(['init', slot]),
    tick: () => (calls.push(['tick']), new Uint8Array([1, 2])),
    feedback: (v) => calls.push(['feedback', v.length]),
    belief: () => null,
    report: () => '',
  };
  s.bot.init(manifestBytes, 'C');
  const before = performance.now();
  assert.deepEqual(s.bot.tick(new Uint8Array(0)), new Uint8Array([1, 2]), 'ответ головы не дошёл до провода');
  const span = performance.now() - before;
  s.bot.feedback(new Uint8Array(3));
  assert.deepEqual(calls, [['init', 'C'], ['tick'], ['feedback', 3]]);
  assert.equal(s.think.length, 1, 'дума такта не записана');
  /* дума — длительность такта: не больше, чем прошло снаружи вызова */
  assert.ok(s.think[0] >= 0 && s.think[0] <= span, 'дума ' + s.think[0] + ' мс при такте ' + span + ' мс');

  /* у головы без вердиктов провод не падает */
  s.strategy = { ...s.strategy, feedback: undefined };
  s.bot.feedback(new Uint8Array(1));
});

test('без файла дневника ничего не пишется, но дума считается', () => {
  const s = new Seat(OPT);
  s.bot.init(manifestBytes, 'A');
  s.bot.tick(encodeObserve(observe({ t: 1 })));
  s.bot.tick(encodeObserve(observe({ t: 2 })));
  assert.equal(s.beliefFrames, 0);
  assert.equal(s.head.state().belief.ageMs, 0);
  assert.equal(s.think.length, 2);
});

test('дневник: init обнуляет файл, каждый такт с кадром дописывает строку', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seat-'));
  const file = join(dir, 'belief.ndjson');
  writeFileSync(file, 'хвост прошлой партии\n');
  const s = new Seat({ ...OPT, beliefFile: file });
  s.bot.init(manifestBytes, 'A');
  assert.equal(readFileSync(file, 'utf8'), '', 'хвост прошлой партии остался: память между партиями (25.4)');

  s.bot.tick(encodeObserve(observe({ t: 1 })));
  s.bot.tick(encodeObserve(observe({ t: 2 })));
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2, 'строк дневника: ' + lines.length);
  for (const l of lines) JSON.parse(l);
  assert.equal(s.beliefFrames, 2);
  assert.ok(s.beliefAt > 0);
  const age = s.head.state().belief;
  assert.equal(age.frames, 2);
  assert.ok(age.ageMs >= 0 && age.ageMs < 60000, 'возраст дневника: ' + age.ageMs);
});

test('голова без кадра дневника не пишет пустых строк', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seat-'));
  const file = join(dir, 'belief.ndjson');
  const s = new Seat({ ...OPT, beliefFile: file });
  s.strategy = { init() {}, tick: () => new Uint8Array(0), belief: () => null, report: () => '' };
  s.bot.init(manifestBytes, 'A');
  assert.ok(existsSync(file), 'init с файлом дневника обязан его создать');
  s.bot.tick(encodeObserve(observe({ t: 1 })));
  assert.equal(readFileSync(file, 'utf8'), '');
  assert.equal(s.beliefFrames, 0);
  assert.equal(s.beliefAt, 0);
});

test('перцентиль — ближайший ранг по отсортированному ряду', () => {
  assert.equal(quantile([], 50), '0');
  assert.equal(quantile([1, 2, 3, 4], 0), '1.0');
  assert.equal(quantile([1, 2, 3, 4], 50), '3.0');
  assert.equal(quantile([1, 2, 3, 4], 99), '4.0');
  assert.equal(quantile([1, 2, 3, 4], 100), '4.0', 'max вышел за край ряда');
  const hundred = Array.from({ length: 100 }, (_, i) => i + 0.25);
  assert.equal(quantile(hundred, 50), '50.3');
  assert.equal(quantile(hundred, 99), '99.3');
  assert.equal(quantile([7.04], 99), '7.0');
});

test('строка конца партии: счётчики провода и дума', () => {
  const s = new Seat(OPT);
  s.run = fakeRun();
  s.why = 'end';
  s.think.push(3, 1, 2, 40);
  assert.equal(s.summary(), 'партію закінчено (end): відповідей 1198, кидків 0, повернень 1; дума, мс: p50 3.0, p99 40.0, max 40.0');
  assert.deepEqual(s.think, [3, 1, 2, 40], 'итог отсортировал сам ряд думы, а не копию');

  const idle = new Seat(OPT);
  idle.why = 'close:4001';
  assert.equal(idle.summary(), 'партію закінчено (close:4001): відповідей 0, кидків 0, повернень 0; дума, мс: p50 0, p99 0, max 0');
  assert.deepEqual(idle.think, [], 'строка итога не должна трогать ряд думы');
});
