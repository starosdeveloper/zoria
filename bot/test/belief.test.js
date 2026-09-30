/* Дневник веры: форма кадра и дельты между полными (SDK 8, P2-05).
   Полный кадр каждые 200 тактов, между ними — только изменения own и dark. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { BeliefBook } from '../dist/belief.js';
import { observe, START_NEEDLES } from './frames.js';

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

test('полный кадр — на первом вызове и потом каждый 200-й', () => {
  const book = new BeliefBook('A');
  const fullAt = [];
  for (let t = 1; t <= 401; t++) if (book.frame(observe({ t })).full) fullAt.push(t);
  /* не «сколько их», а «какие именно»: счёт полных кадров одинаков и при
     счётчике, идущем в другую сторону, — такая проверка мутанта не ловит */
  assert.deepEqual(fullAt, [1, 201, 401]);
});

test('смена владельца и смена молчания приходят отдельными дельтами', () => {
  const book = new BeliefBook('A');
  const cell = { q: 1, r: -6 };
  book.frame(observe({ t: 1, own: [{ ...cell, owner: 'B', dark: false }] }));

  const owner = book.frame(observe({ t: 2, own: [{ ...cell, owner: 'C', dark: false }] }));
  assert.deepEqual(owner.own, { '1,-6': 'C' });
  assert.equal(owner.dark, undefined, 'молчание не менялось, а дельта есть');

  const dark = book.frame(observe({ t: 3, own: [{ ...cell, owner: 'C', dark: true }] }));
  assert.deepEqual(dark.dark, { '1,-6': true });
  assert.equal(dark.own, undefined, 'владелец не менялся, а дельта есть');
});

test('свои голки в дельте помечены нашим слотом, и молчание своих тоже', () => {
  const book = new BeliefBook('B');
  const first = book.frame(observe({ t: 1 }));
  assert.deepEqual(first.own, { '5,-12': 'B', '7,-13': 'B' });
  const gone = book.frame(
    observe({ t: 2, mine: { needles: [{ q: 5, r: -12, dark: true, fed: false, weight: 0.5 }] } }),
  );
  assert.deepEqual(gone.dark, { '5,-12': true });
});

test('взятая голка приходит дельтой, а не только в полном кадре', () => {
  /* полный кадр печатает всю память и потому не показывает, работает ли
     сравнение с прошлым тактом: проверять надо на кадре между полными */
  const book = new BeliefBook('A');
  book.frame(observe({ t: 1 }));
  const taken = book.frame(
    observe({
      t: 2,
      mine: {
        needles: [...START_NEEDLES, { q: 2, r: -9, dark: false, fed: false, weight: 1 }],
      },
    }),
  );
  assert.deepEqual(taken.own, { '2,-9': 'A' }, 'новая своя голка не попала в дельту');
});

test('полный кадр несёт молчащие голки, а не пустой список', () => {
  const book = new BeliefBook('A', 1); // каждый кадр полный
  const f = book.frame(
    observe({ t: 1, mine: { needles: [{ q: 5, r: -12, dark: true, fed: false, weight: 0 }] } }),
  );
  assert.equal(f.full, true);
  assert.deepEqual(f.dark, { '5,-12': true });
});

test('видимое этим тактом идёт в кадр целиком: соперники, машины, шум, кличи', () => {
  const f = new BeliefBook('A').frame(
    observe({
      t: 5,
      foe: [{ id: 'K-B3', p: 'B', cls: 'клинок', q: 2, r: -9 }],
      noisy: [
        { q: 0, r: 0 },
        { q: 1, r: 1 },
      ],
      mine: {
        units: [{ id: 'T-A1', cls: 'ткач', q: 6, r: -12, mute: false, stuck: false, wait: 0, work: 0, away: 0, task: { goal: null, site: null, feed: null, jam: null, ram: null, home: false, path: 4 } }],
      },
      pub: { order: null, pact: { active: [], breaks: [] }, cries: [['C', 4]], dawn: false, score: [0, 0, 0] },
    }),
  );
  assert.deepEqual(f.foe, [['K-B3', 'B', 2, -9]]);
  assert.equal(f.noisy, 2, 'шум идёт числом, не списком');
  assert.deepEqual(f.units, [['T-A1', 6, -12, 4]], 'у машины пишется длина пути');
  assert.deepEqual(f.cries, [['C', 4]]);
});

test('пустые поля в кадр не попадают вовсе', () => {
  const f = new BeliefBook('A').frame(observe({ t: 7 }));
  assert.equal(f.foe, undefined);
  assert.equal(f.noisy, undefined);
  assert.equal(f.units, undefined);
  assert.equal(f.cries, undefined);
});

test('угода: в кадре стоит партнёр, а чужая угода — не наша', () => {
  const pact = (active) => ({ order: null, pact: { active, breaks: [] }, cries: [], dawn: false, score: [0, 0, 0] });
  /* запись угоды бывает написана в обе стороны, и обе обязаны дать партнёра:
     проверка одной стороны молчит, если читается только другая */
  const second = new BeliefBook('A').frame(observe({ t: 9, pub: pact([{ a: 'C', b: 'A', since: 5 }]) }));
  assert.equal(second.pact, 'C', 'мы в записи вторыми');
  const first = new BeliefBook('A').frame(observe({ t: 9, pub: pact([{ a: 'A', b: 'C', since: 5 }]) }));
  assert.equal(first.pact, 'C', 'мы в записи первыми');
  const theirs = new BeliefBook('A').frame(observe({ t: 9, pub: pact([{ a: 'B', b: 'C', since: 5 }]) }));
  assert.equal(theirs.pact, null);
});

test('строка журнала разбирается обратно в кадр', () => {
  const f = new BeliefBook('A').frame(observe());
  const back = JSON.parse(JSON.stringify(f));
  assert.equal(back.t, 1);
  assert.equal(back.pulse.needles, 2);
});
