/* Лента правды на подложном курсоре: мир меняется по тактам, лента обязана
   отдать на каждом такте ровно тот мир, что был после его шага. */

import { describe, expect, it } from 'vitest';
import { TruthTape } from '../src/tape.js';
import type { EngineView } from '../src/truth.js';
import type { Stepper } from '../src/tape.js';

/** Три такта: на 2-м Ткач A шагает, на 3-м голка 2,-9 становится нашей. */
function fakeCursor(): Stepper {
  const engine: EngineView = {
    SIM: { t: 0, world: { own: { '5,-12': 'A' }, lit: { A: { '5,-12': 1 } } }, units: [{ id: 'T-A1', p: 'A', q: 6, r: -12 }] },
  };
  return {
    engine,
    done: () => engine.SIM.t >= 3,
    step: () => {
      const s = engine.SIM;
      s.t++;
      if (s.t === 2) s.units = [{ id: 'T-A1', p: 'A', q: 6, r: -11 }];
      if (s.t === 3) s.world = { own: { '5,-12': 'A', '2,-9': 'A' }, lit: { A: { '5,-12': 1 } } };
      return s.t;
    },
  };
}

describe('TruthTape', () => {
  it('такт за тактом — мир после его шага, а не последний', () => {
    const seen: number[] = [];
    const tape = TruthTape.record(fakeCursor(), (t) => seen.push(t));
    expect(seen).toEqual([1, 2, 3]);
    expect(tape.length).toBe(3);
    expect(tape.at(1)?.units).toEqual([{ id: 'T-A1', owner: 'A', q: 6, r: -12 }]);
    expect(tape.at(2)?.units).toEqual([{ id: 'T-A1', owner: 'A', q: 6, r: -11 }]);
    expect([...(tape.at(2)?.own ?? [])]).toEqual([['5,-12', 'A']]);
    expect([...(tape.at(3)?.own ?? [])]).toEqual([
      ['5,-12', 'A'],
      ['2,-9', 'A'],
    ]);
    expect([...(tape.at(3)?.dark ?? [])]).toEqual(['2,-9']);
  });

  it('со слотом — мир в миг опроса бота, до событий шага', () => {
    /* пилот слота A зовётся внутри шага, до изменений этого такта */
    const cursor = fakeCursor();
    const sim = cursor.engine.SIM as typeof cursor.engine.SIM & { pilot: Record<string, () => void> };
    const calls: number[] = [];
    sim.pilot = { A: () => calls.push(sim.t) };
    const step = cursor.step.bind(cursor);
    cursor.step = () => {
      sim.t++;
      sim.pilot.A?.();
      sim.t--;
      return step();
    };
    const tape = TruthTape.record(cursor, undefined, 'A');
    expect(calls).toEqual([1, 2, 3]);
    /* на такте 2 бот видел Ткача ещё на старой соте: шаг такта 2 случился после опроса */
    expect(tape.at(2)?.units).toEqual([{ id: 'T-A1', owner: 'A', q: 6, r: -12 }]);
    expect(tape.at(3)?.units).toEqual([{ id: 'T-A1', owner: 'A', q: 6, r: -11 }]);
    /* после записи пилот возвращён: зов не пишет в ленту, а доходит до бота */
    expect(sim.pilot.A).toBeTypeOf('function');
    sim.pilot.A?.();
    expect(calls).toEqual([1, 2, 3, 3]);
    expect(tape.length).toBe(3);
  });

  it('вне записи — null', () => {
    const tape = TruthTape.record(fakeCursor());
    expect(tape.at(0)).toBeNull();
    expect(tape.at(4)).toBeNull();
    const empty = TruthTape.record({ ...fakeCursor(), done: () => true });
    expect(empty.at(1)).toBeNull();
    expect(empty.length).toBe(0);
  });
});
