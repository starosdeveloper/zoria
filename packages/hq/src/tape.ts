/* hq :: tape
   Перемотка записи в бюджете кадра (Ш2).

   Курсор журнала SDK (`openJournal`) держит снимки мира раз в 50 тактов и при
   перемотке назад восстанавливает ближайший и догоняет вперёд. Замер на
   настоящей записи 04.10: случайный `seek` — p50 63 мс, p95 1.2 с, худший
   1.9 с, то есть в десятки раз больше кадра. Шаг вперёд — 0.6 мс.

   Поэтому штаб не перематывает мир, а читает ленту: при загрузке партия один
   раз проходит вперёд (2.9 с на 1200 тактов, в Web Worker), на каждом такте
   снимается правда (69 мс на всю партию), и перемотка — чтение из массива
   (0.1 мкс). Вся лента — около 1.5 МБ. */

import { truthOf } from './truth.js';
import type { EngineView, WorldTruth } from './truth.js';

/** Что нужно от курсора журнала: шаг вперёд, мир после него и пилоты слотов. */
export interface Stepper {
  step(n?: number): number;
  done(): boolean;
  readonly engine: EngineView & { SIM: { pilot?: Record<string, (() => void) | undefined> } };
}

export class TruthTape {
  private readonly ticks: WorldTruth[] = [];

  /**
   * Проход вперёд до конца партии; `progress` — после каждого такта.
   *
   * Без `slot` снимается мир после шага такта. Со `slot` — мир в тот миг, когда
   * движок опрашивает бота этого слота: ровно то, из чего бот собрал кадр и свою
   * веру. Для Ш1 нужен второй: мир «после такта t−1» отличается от кадра такта t
   * событиями, которые движок проводит до опроса (выход машины с верфи и т. п.) —
   * на настоящей партии это 13 ложных расхождений своих машин против нуля.
   */
  static record(cursor: Stepper, progress?: (t: number) => void, slot?: string): TruthTape {
    const tape = new TruthTape();
    const sim = cursor.engine.SIM;
    const pilot = slot ? sim.pilot?.[slot] : undefined;
    if (slot && pilot && sim.pilot) {
      sim.pilot[slot] = () => {
        tape.ticks.push(truthOf(cursor.engine));
        pilot();
      };
    }
    while (!cursor.done()) {
      cursor.step(1);
      if (!pilot) tape.ticks.push(truthOf(cursor.engine));
      progress?.(sim.t);
    }
    if (slot && pilot && sim.pilot) sim.pilot[slot] = pilot;
    return tape;
  }

  get length(): number {
    return this.ticks.length;
  }

  /** Правда на такте `t`; вне записи — null. */
  at(t: number): WorldTruth | null {
    const first = this.ticks[0];
    if (!first) return null;
    return this.ticks[t - first.t] ?? null;
  }
}
