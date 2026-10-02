/* Какая голова садится в слот. Ошибка здесь уже случалась и обошлась дорого:
   `main.ts` подставлял имя архетипа по умолчанию, и тридцать минут в темпе
   500 мс считало зеркало SDK, а лог при этом выглядел как обычная партия.
   Поймалось только тем, что рахунок совпал с прошлым прогоном символ в символ. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createStrategy, HARVEST, presets } from '../dist/strategy.js';
import { manifestBytes } from './frames.js';

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

test('вердикты доходят до головы через стратегию', () => {
  const s = createStrategy(HARVEST);
  s.init(manifestBytes, 'A');
  /* кривые байты не роняют: голова просто не разберёт вердикт */
  s.feedback(new Uint8Array([0xff]));
  assert.match(s.report(), /відмов 0/);
});
