/* Какая голова садится в слот. Ошибка здесь уже случалась и обошлась дорого:
   `main.ts` подставлял имя архетипа по умолчанию, и тридцать минут в темпе
   500 мс считало зеркало SDK, а лог при этом выглядел как обычная партия.
   Поймалось только тем, что рахунок совпал с прошлым прогоном символ в символ. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createStrategy, HARVEST, presets } from '../dist/strategy.js';
import { manifestBytes, observe } from './frames.js';

test('по умолчанию в слот садится наш пресет, а не зеркало SDK', () => {
  const s = createStrategy();
  assert.equal(s.constructor.name, 'HarvestStrategy', 'по умолчанию не «жатва»');
  assert.equal(HARVEST, 'жатва');
});

test('имя пресета из окружения выбирает зеркало архетипа', () => {
  const mirror = createStrategy('обхідник');
  assert.equal(mirror.constructor.name, 'MirrorStrategy');
  assert.equal(createStrategy(HARVEST).constructor.name, 'HarvestStrategy');
});

test('список пресетов: наш первый, архетипы следом', () => {
  const list = presets();
  assert.equal(list[0], HARVEST, 'наш пресет не первый: ' + list.join(','));
  for (const name of ['рівний', 'шир', 'обхідник', 'проривник', 'облягач']) {
    assert.ok(list.includes(name), 'нет архетипа ' + name);
  }
  assert.equal(new Set(list).size, list.length, 'в списке повторы');
});

test('«жатва» отдаёт кадр дневника и свой отчёт, зеркало — свой', () => {
  const ours = createStrategy(HARVEST);
  ours.init(manifestBytes, 'A');
  assert.equal(ours.belief(null), null, 'без кадра наблюдения дневнику писать нечего');
  assert.match(ours.report(), /команд 0/, 'отчёт пустой головы: ' + ours.report());

  const mirror = createStrategy('рівний');
  mirror.init(manifestBytes, 'A');
  assert.equal(mirror.report(), '', 'зеркало своих команд не считает');
  /* и дневник у них разный по природе: зеркало пишет свой мир и без кадра
     наблюдения, а наша голова без кадра не знает ничего (SDK 8) */
  const frame = mirror.belief(null);
  assert.ok(frame && frame.full === true, 'зеркало не отдало кадр своего мира');
  assert.ok(Object.keys(frame.own).length > 0, 'кадр зеркала пустой');
});

test('без аргумента пресет берётся из ZARIA_PRESET', () => {
  const was = process.env.ZARIA_PRESET;
  try {
    process.env.ZARIA_PRESET = 'шир';
    assert.equal(createStrategy().constructor.name, 'MirrorStrategy', 'ZARIA_PRESET не прочитан');
    process.env.ZARIA_PRESET = '';
    assert.equal(createStrategy().constructor.name, 'HarvestStrategy', 'пустое имя должно давать «жатву»');
  } finally {
    if (was === undefined) delete process.env.ZARIA_PRESET;
    else process.env.ZARIA_PRESET = was;
  }
});

test('обе стратегии отдают голове init, tick и feedback как есть', () => {
  for (const name of [HARVEST, 'шир']) {
    const s = createStrategy(name);
    const calls = [];
    const answer = new Uint8Array([9, 8, 7]);
    s.head = {
      init: (m, slot) => calls.push(['init', m.length, slot]),
      tick: (o) => (calls.push(['tick', o.length]), answer),
      feedback: (v) => calls.push(['feedback', v.length]),
      mirror: () => null,
      report: () => 'своё',
    };
    s.init(manifestBytes, 'B');
    assert.equal(s.tick(new Uint8Array(4)), answer, name + ': ответ головы подменён');
    s.feedback(new Uint8Array(2));
    assert.deepEqual(calls, [['init', manifestBytes.length, 'B'], ['tick', 4], ['feedback', 2]], name + ': ' + JSON.stringify(calls));
  }
});

test('кадр дневника появляется только после init и только с кадром наблюдения', () => {
  const ours = createStrategy(HARVEST);
  const obs = observe({ t: 1 });
  assert.equal(ours.belief(obs), null, 'до init дневнику не с чем сверяться');
  ours.init(manifestBytes, 'A');
  const frame = ours.belief(obs);
  assert.ok(frame && frame.full === true, 'первый кадр дневника не полный');
  assert.equal(ours.report(), ours.head.report(), 'отчёт не головы');

  const mirror = createStrategy('шир');
  assert.equal(mirror.belief(null), null, 'зеркало без init написало кадр');
});

test('вердикты доходят до головы через стратегию', () => {
  const s = createStrategy(HARVEST);
  s.init(manifestBytes, 'A');
  /* кривые байты не роняют: голова просто не разберёт вердикт */
  s.feedback(new Uint8Array([0xff]));
  assert.match(s.report(), /відмов 0/);
});
