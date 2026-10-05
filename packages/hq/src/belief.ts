/* hq :: belief
   Вера бота на любом такте — из его дневника (P2-05, `belief-N.ndjson`).

   Дневник пишется так (bot/src/belief.ts и `BeliefTrace` SDK): полный кадр раз
   в 200 тактов, между ними — только изменения. В полном кадре `own` перечисляет
   всё, что бот знает о голках, а `dark` — только погасшие (нет ключа — горит).
   В кадре изменений `own` и `dark` несут лишь то, что поменялось; `null` в
   `own` — голка стала ничьей. Чужие машины, свои машины, шум, угода и кличи
   приходят в каждом кадре заново и не копятся.

   Штаб спрашивает веру на произвольном такте при перемотке (Ш1, Ш2), поэтому
   поиск — двоичный по номеру такта, а сборка — от ближайшего полного кадра:
   не больше 200 шагов на любой такт партии. */

export interface BeliefPulse {
  energy: number;
  chan: number;
  ear: number;
  minutes: number;
  needles: number;
}

/** Строка дневника — форма `BeliefFrame` SDK. */
export interface BeliefFrame {
  t: number;
  full?: true;
  pulse: BeliefPulse;
  own?: Record<string, string | null>;
  dark?: Record<string, boolean>;
  foe?: [string, string, number, number][];
  noisy?: number;
  units?: [string, number, number, number][];
  pact?: string | null;
  cries?: [string, number][];
}

/** Во что бот верил на такте. */
export interface Belief {
  /** такт, о котором спрашивали */
  t: number;
  /** такт кадра, из которого вера собрана; меньше `t` — дневник на `t` молчал */
  at: number;
  /** на сколько тактов вера старше вопроса: процесс мёртв, кадра не было */
  stale: number;
  pulse: BeliefPulse;
  /** владелец голки по соте `"q,r"`; null — ничья */
  own: Map<string, string | null>;
  /** погасшие голки; нет ключа — горит */
  dark: Set<string>;
  foe: { id: string; owner: string; q: number; r: number }[];
  units: { id: string; q: number; r: number; path: number }[];
  noisy: number;
  pact: string | null;
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Разбирает дневник; кривая строка — ошибка с её номером, а не тихий пропуск. */
export function parseJournal(text: string): BeliefFrame[] {
  const out: BeliefFrame[] = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    let f: unknown;
    try {
      f = JSON.parse(line);
    } catch {
      throw new Error(`дневник, строка ${String(i + 1)}: не JSON`);
    }
    const why = shapeError(f);
    if (why) throw new Error(`дневник, строка ${String(i + 1)}: ${why}`);
    out.push(f as BeliefFrame);
  });
  out.reduce<BeliefFrame | null>((prev, cur) => {
    if (prev && cur.t <= prev.t) throw new Error(`дневник: такт ${String(cur.t)} после ${String(prev.t)} — такты обязаны расти`);
    return cur;
  }, null);
  return out;
}

function shapeError(f: unknown): string | null {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return 'не объект';
  const o = f as Record<string, unknown>;
  if (!isNum(o['t'])) return 'нет такта t';
  if (o['full'] !== undefined && o['full'] !== true) return 'full не true';
  const p = o['pulse'] as Record<string, unknown> | undefined;
  if (!p || !['energy', 'chan', 'ear', 'minutes', 'needles'].every((k) => isNum(p[k]))) return 'pulse не полный';
  const own = o['own'];
  if (own !== undefined && (typeof own !== 'object' || own === null || Object.values(own).some((v) => v !== null && typeof v !== 'string'))) return 'own не карта владельцев';
  const dark = o['dark'];
  if (dark !== undefined && (typeof dark !== 'object' || dark === null || Object.values(dark).some((v) => typeof v !== 'boolean'))) return 'dark не карта флагов';
  return null;
}

export class BeliefTimeline {
  private readonly frames: readonly BeliefFrame[];
  /** номера полных кадров в `frames`, по возрастанию */
  private readonly fulls: number[];

  constructor(frames: readonly BeliefFrame[]) {
    this.frames = frames;
    this.fulls = frames.flatMap((f, i) => (f.full ? [i] : []));
  }

  /** первый и последний такт, о которых дневник что-то знает */
  get span(): [number, number] | null {
    const a = this.frames[0];
    const b = this.frames[this.frames.length - 1];
    return a && b ? [a.t, b.t] : null;
  }

  /** Вера на такте `t`; null — до первого кадра дневника или без полного кадра перед ним. */
  at(t: number): Belief | null {
    const i = this.lastAtOrBefore(t);
    if (i < 0) return null;
    const base = this.lastFullAtOrBefore(i);
    if (base < 0) return null;

    const own = new Map<string, string | null>();
    const dark = new Set<string>();
    for (const g of this.frames.slice(base, i + 1)) {
      if (g.full) {
        own.clear();
        dark.clear();
      }
      for (const [k, v] of Object.entries(g.own ?? {})) own.set(k, v);
      for (const [k, v] of Object.entries(g.dark ?? {})) {
        if (v) dark.add(k);
        else dark.delete(k);
      }
    }
    const f = this.frames[i];
    if (!f) return null;
    return {
      t,
      at: f.t,
      stale: t - f.t,
      pulse: { ...f.pulse },
      own,
      dark,
      foe: (f.foe ?? []).map(([id, owner, q, r]) => ({ id, owner, q, r })),
      units: (f.units ?? []).map(([id, q, r, path]) => ({ id, q, r, path })),
      noisy: f.noisy ?? 0,
      pact: f.pact ?? null,
    };
  }

  private lastAtOrBefore(t: number): number {
    let lo = 0;
    let hi = this.frames.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((this.frames[mid]?.t ?? Infinity) <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  private lastFullAtOrBefore(i: number): number {
    let ans = -1;
    for (const j of this.fulls) {
      if (j > i) break;
      ans = j;
    }
    return ans;
  }
}
