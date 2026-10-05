/* Вера бота по дневнику: восстановление от полного кадра через изменения.
   Ожидания записаны литералами по форме дневника (bot/src/belief.ts), а не
   пересчитаны той же сборкой, что в коде. */

import { describe, expect, it } from 'vitest';
import { BeliefTimeline, parseJournal } from '../src/belief.js';
import type { Belief } from '../src/belief.js';

/** Вера обязана быть: null здесь — провал проверки, а не тихий пропуск. */
function must(b: Belief | null): Belief {
  if (!b) throw new Error('веры на этом такте нет');
  return b;
}

const pulse = (energy: number) => ({ energy, chan: 141, ear: 1000, minutes: 0, needles: 2 });

/* полный кадр на 1, изменения на 2 и 3, дыра 4–9 (процесс мёртв), полный на 10 */
const JOURNAL = [
  { t: 1, full: true, pulse: pulse(120), own: { '5,-12': 'A', '2,-9': null }, dark: {}, units: [['T-A1', 6, -12, 0]] },
  { t: 2, pulse: pulse(121), own: { '2,-9': 'A' }, dark: { '5,-12': true }, foe: [['T-B1', 'B', 3, -9]] },
  { t: 3, pulse: pulse(122), own: { '2,-9': null }, dark: { '5,-12': false } },
  { t: 10, full: true, pulse: pulse(130), own: { '7,-13': 'A' }, dark: { '7,-13': true } },
]
  .map((f) => JSON.stringify(f))
  .join('\n');

describe('parseJournal', () => {
  it('разбирает строки и пропускает пустые', () => {
    expect(parseJournal(JOURNAL + '\n\n').map((f) => f.t)).toEqual([1, 2, 3, 10]);
  });

  it('кривая строка — ошибка с её номером', () => {
    expect(() => parseJournal(JOURNAL + '\n{"t":11}')).toThrow('строка 5: pulse не полный');
    expect(() => parseJournal('{"t":1,')).toThrow('строка 1: не JSON');
    expect(() => parseJournal(JSON.stringify({ t: 1, pulse: pulse(1), own: { a: 5 } }))).toThrow('own не карта владельцев');
    expect(() => parseJournal(JSON.stringify({ t: 1, pulse: pulse(1), dark: { a: 'да' } }))).toThrow('dark не карта флагов');
    expect(() => parseJournal(JSON.stringify({ t: 1, full: false, pulse: pulse(1) }))).toThrow('full не true');
  });

  it('такты обязаны расти', () => {
    const back = JSON.stringify({ t: 2, pulse: pulse(1) }) + '\n' + JSON.stringify({ t: 2, pulse: pulse(1) });
    expect(() => parseJournal(back)).toThrow('такт 2 после 2');
  });
});

describe('BeliefTimeline', () => {
  const tl = new BeliefTimeline(parseJournal(JOURNAL));

  it('до первого кадра веры нет', () => {
    expect(tl.at(0)).toBeNull();
    expect(tl.span).toEqual([1, 10]);
  });

  it('полный кадр: владельцы как есть, погасших нет', () => {
    const b = must(tl.at(1));
    expect([...b.own]).toEqual([
      ['5,-12', 'A'],
      ['2,-9', null],
    ]);
    expect([...b.dark]).toEqual([]);
    expect(b.units).toEqual([{ id: 'T-A1', q: 6, r: -12, path: 0 }]);
    expect(b.stale).toBe(0);
  });

  it('изменения ложатся поверх: руина стала нашей, голка погасла', () => {
    const b = must(tl.at(2));
    expect(b.own.get('2,-9')).toBe('A');
    expect(b.own.get('5,-12')).toBe('A');
    expect([...b.dark]).toEqual(['5,-12']);
    expect(b.foe).toEqual([{ id: 'T-B1', owner: 'B', q: 3, r: -9 }]);
    expect(b.pulse.energy).toBe(121);
  });

  it('null возвращает голку в ничьи, false — снова горит; машины не копятся', () => {
    const b = must(tl.at(3));
    expect(b.own.get('2,-9')).toBeNull();
    expect(b.own.has('2,-9')).toBe(true);
    expect([...b.dark]).toEqual([]);
    expect(b.foe).toEqual([]);
    expect(b.units).toEqual([]);
  });

  it('в дыре дневника вера — последний кадр, и видно, насколько она стара', () => {
    const b = must(tl.at(7));
    expect(b.at).toBe(3);
    expect(b.stale).toBe(4);
    expect(b.own.get('2,-9')).toBeNull();
  });

  it('полный кадр начинает заново: прежнее знание не протекает', () => {
    const b = must(tl.at(10));
    expect([...b.own]).toEqual([['7,-13', 'A']]);
    expect([...b.dark]).toEqual(['7,-13']);
    expect(must(tl.at(999)).stale).toBe(989);
  });

  it('дневник без полного кадра в начале — веры нет, а не мусор', () => {
    const tail = new BeliefTimeline(parseJournal(JSON.stringify({ t: 5, pulse: pulse(1), own: { a: 'A' } })));
    expect(tail.at(5)).toBeNull();
    expect(new BeliefTimeline([]).span).toBeNull();
  });
});
