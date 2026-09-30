/* Дневник веры: форма кадра и дельты между полными (SDK 8, P2-05).
   Полный кадр каждые 200 тактов, между ними — только изменения own и dark. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { BeliefBook } from '../dist/belief.js';
import { observe } from './frames.js';

test('первый кадр полный и несёт свои голки', () => {
  const f = new BeliefBook('A').frame(observe());
  assert.equal(f.full, true);
  assert.deepEqual(f.own, { '5,-12': 'A', '7,-13': 'A' });
  assert.deepEqual(f.dark, {});
  assert.equal(f.pact, null);
  assert.deepEqual(f.pulse, { energy: 120, chan: 141, ear: 987, minutes: 0, needles: 2 });
});

test('следующий кадр без изменений не несёт ни own, ни dark', () => {
  const book = new BeliefBook('A');
  book.frame(observe());
  const f = book.frame(observe({ t: 2 }));
  assert.equal(f.full, undefined);
  assert.equal(f.own, undefined);
  assert.equal(f.dark, undefined);
  assert.equal(f.t, 2);
});

test('чужая голка в поле зрения приходит дельтой один раз', () => {
  const book = new BeliefBook('A');
  book.frame(observe());
  const seen = observe({ t: 3, own: [{ q: 1, r: -6, owner: 'B', dark: false }] });
  assert.deepEqual(book.frame(seen).own, { '1,-6': 'B' });
  assert.equal(book.frame(observe({ t: 4, own: seen.own })).own, undefined);
  assert.equal(book.ownerOf('1,-6'), 'B');
});

test('полный кадр возвращается каждые 200 вызовов', () => {
  const book = new BeliefBook('A');
  let full = 0;
  for (let t = 1; t <= 400; t++) if (book.frame(observe({ t })).full) full++;
  assert.equal(full, 2);
});

test('строка журнала разбирается обратно в кадр', () => {
  const f = new BeliefBook('A').frame(observe());
  const back = JSON.parse(JSON.stringify(f));
  assert.equal(back.t, 1);
  assert.equal(back.pulse.needles, 2);
});
