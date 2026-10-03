/* bot :: seat
   стан голови в слоті: фаза партії, знімок для службового порту, зміна
   пресета, обгортка такту з щоденником віри і рядок кінця партії.

   Винесено з main.ts, бо там усе це жило в тілі модуля, а тіло модуля
   виконується при імпорті і без ZARIA_URL завершує процес: перевірити його
   можна було лише запуском процесу проти вузла. Тут нема ні мережі, ні
   оточення - лише стан, і його видно перевіркам напряму. Провід і змінні
   оточення лишилися в main.ts. */

import { appendFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { beliefLine } from '@zoria/sdk';
import type { BotRun, WireBot } from '@zoria/sdk';
import { decodeObserve } from '@zoria/protocol';
import { createStrategy, presets } from './strategy.js';
import type { Strategy } from './strategy.js';
import { Refusal } from './status.js';
import type { Head, HeadStats } from './status.js';

export const IDLE: HeadStats = { ticks: 0, orders: 0, nacks: 0, bytesIn: 0, bytesOut: 0, resyncMs: 0, resumes: 0, faults: 0, deferred: 0, lastTickAt: 0 };

export interface SeatOptions {
  preset: string;
  /* здачу заморожено: зміна пресета відповідає відмовою */
  freeze: boolean;
  /* хеш рушія, якого вимагаємо; до присяги знімок показує його */
  engine: string;
  /* файл щоденника віри (NDJSON); порожньо - не писати */
  beliefFile: string;
}

/* перцентиль уже відсортованого ряду: найближчий ранг, без інтерполяції -
   p99 мусить бути справжньою думою якогось такту, а не середнім двох */
export function quantile(sorted: readonly number[], p: number): string {
  if (!sorted.length) return '0';
  const v = sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))];
  return (v ?? 0).toFixed(1);
}

export class Seat {
  phase: 'lobby' | 'live' | 'done' = 'lobby';
  why = '';
  tick = 0;
  frames = 0;
  beliefFrames = 0;
  beliefAt = 0;
  run: BotRun | null = null;
  preset: string;
  strategy: Strategy;
  /* дума по тактах, мс: стратегія, кодеки і щоденник разом - ваша частка
     бюджету такту (500 мс від кадру, у них же провід) */
  readonly think: number[] = [];
  private readonly opt: SeatOptions;
  private readonly born: number;

  constructor(opt: SeatOptions, born = Date.now()) {
    this.opt = opt;
    this.born = born;
    this.preset = opt.preset;
    this.strategy = createStrategy(opt.preset);
  }

  /* знімок голови: усе, що про бій знає лише провід. Його читає службовий
     порт, і з нього control-plane стека збирає /health і /metrics */
  readonly head: Head = {
    state: () => {
      const run = this.run;
      const now = Date.now();
      return {
        state: this.phase,
        slot: run ? run.slot : null,
        preset: this.preset,
        presets: presets(),
        freeze: this.opt.freeze,
        tick: this.tick,
        frames: this.frames,
        ticks: run ? run.ack.ticks : 0,
        why: this.why,
        engine: run ? run.ack.engine : this.opt.engine,
        uptimeMs: now - this.born,
        stats: run ? { ...run.stats } : { ...IDLE },
        belief: { frames: this.beliefFrames, ageMs: this.beliefAt ? now - this.beliefAt : 0 },
      };
    },
    /* зміна стратегії - між партіями і лише до заморожування: зміна пресета
       посеред бою була б зміною гравця */
    promote: (value) => {
      if (typeof value !== 'string' || !presets().includes(value)) throw new Refusal(400, 'preset');
      if (this.phase === 'live') throw new Refusal(409, 'live');
      if (this.opt.freeze) throw new Refusal(409, 'freeze');
      this.preset = value;
      this.strategy = createStrategy(value);
      return value;
    },
  };

  /* стратегія береться при кожному виклику, а не один раз: між партіями
     службовий порт міг її замінити */
  readonly bot: WireBot = {
    init: (manifest, slot) => {
      this.strategy.init(manifest, slot);
      if (this.opt.beliefFile) writeFileSync(this.opt.beliefFile, '');
    },
    tick: (observe) => {
      const t0 = performance.now();
      const out = this.strategy.tick(observe);
      /* щоденник пишеться синхронно: процес, що впав, не забирає останні такти */
      if (this.opt.beliefFile) {
        const frame = this.strategy.belief(decodeObserve(observe));
        if (frame) {
          appendFileSync(this.opt.beliefFile, beliefLine(frame));
          this.beliefFrames++;
          this.beliefAt = Date.now();
        }
      }
      this.think.push(performance.now() - t0);
      return out;
    },
    feedback: (verdicts) => {
      this.strategy.feedback?.(verdicts);
    },
  };

  /* такт світу з заголовка кадру; null - кадр без заголовка, такт лишається */
  onTick(t: number | null, n: number): void {
    if (t !== null) this.tick = t;
    this.frames = n;
  }

  /* рядок кінця партії: лічильники проводу і дума по тактах */
  summary(): string {
    const run = this.run;
    const sorted = [...this.think].sort((a, b) => a - b);
    const s = run ? run.stats : IDLE;
    return (
      'партію закінчено (' +
      this.why +
      '): відповідей ' +
      s.ticks +
      ', кидків ' +
      s.faults +
      ', повернень ' +
      s.resumes +
      '; дума, мс: p50 ' +
      quantile(sorted, 50) +
      ', p99 ' +
      quantile(sorted, 99) +
      ', max ' +
      quantile(sorted, 100)
    );
  }
}
