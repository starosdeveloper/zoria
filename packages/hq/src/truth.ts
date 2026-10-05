/* hq :: truth
   Правда против веры (Ш1): что было в мире на такте и во что бот верил.

   Правда берётся из мира движка, воспроизводящего журнал (`openJournal` SDK):
   `world.own` — владелец голки по соте `"q,r"`, `world.lit[владелец][сота]` —
   вес нити (0 — голка молчит), `SIM.units` — все машины. Тип ниже — ровно эти
   поля и ничего сверх, чтобы пакет не тянул SDK, а адаптер оставался проверяем
   на подложном мире.

   Расхождения — только те, что бот мог бы знать иначе: чужой владелец голки,
   которую бот считает своей или ничьей; горит/молчит не так; голка, о которой
   бот не знает вовсе; своя машина не там. Чужие машины вне видимости — не
   ошибка веры, а туман (14): их число показывается, но расхождением не считается. */

import type { Belief } from './belief.js';

/** Поля мира движка, которые читает штаб. */
export interface EngineView {
  SIM: {
    t: number;
    world: { own: Record<string, string | undefined>; lit: Record<string, Record<string, number> | undefined> };
    units: readonly { id: string; p: string; q: number; r: number; cls?: string; dead?: boolean }[];
  };
}

export interface WorldTruth {
  t: number;
  /** владелец каждой голки, у которой он есть */
  own: Map<string, string>;
  /** голки, которые молчат у своего владельца */
  dark: Set<string>;
  units: { id: string; owner: string; q: number; r: number }[];
}

export function truthOf(E: EngineView): WorldTruth {
  const w = E.SIM.world;
  const own = new Map<string, string>();
  const dark = new Set<string>();
  for (const [k, owner] of Object.entries(w.own)) {
    if (!owner) continue;
    own.set(k, owner);
    if (!(w.lit[owner]?.[k] ?? 0)) dark.add(k);
  }
  const units = E.SIM.units.filter((u) => !u.dead).map((u) => ({ id: u.id, owner: u.p, q: u.q, r: u.r }));
  return { t: E.SIM.t, own, dark, units };
}

export type NeedleMiss =
  /** бот считает голку чужой/своей/ничьей не так, как есть */
  | { cell: string; kind: 'owner'; believed: string | null; actual: string | null }
  /** владелец верный, а горит/молчит — нет */
  | { cell: string; kind: 'dark'; believedDark: boolean; actualDark: boolean }
  /** у голки есть владелец, а бот о ней не знает вовсе */
  | { cell: string; kind: 'unknown'; actual: string };

export interface Divergence {
  t: number;
  /** на сколько тактов вера старше правды (дыра в дневнике) */
  stale: number;
  needles: NeedleMiss[];
  /** свои машины, которых нет там, где бот их видит */
  ownUnits: { id: string; believed: { q: number; r: number } | null; actual: { q: number; r: number } | null }[];
  /** чужие машины, которые бот видел в этом такте, а их там нет */
  ghosts: string[];
  /** чужих машин вне видимости — туман, не ошибка */
  unseen: number;
}

export function divergence(truth: WorldTruth, belief: Belief, slot: string): Divergence {
  const needles: NeedleMiss[] = [];
  for (const [cell, believed] of belief.own) {
    const actual = truth.own.get(cell) ?? null;
    if (believed !== actual) {
      needles.push({ cell, kind: 'owner', believed, actual });
      continue;
    }
    if (actual === null) continue;
    const believedDark = belief.dark.has(cell);
    const actualDark = truth.dark.has(cell);
    if (believedDark !== actualDark) needles.push({ cell, kind: 'dark', believedDark, actualDark });
  }
  for (const [cell, actual] of truth.own) {
    if (!belief.own.has(cell)) needles.push({ cell, kind: 'unknown', actual });
  }

  const at = (q: number, r: number) => `${String(q)},${String(r)}`;
  const mine = truth.units.filter((u) => u.owner === slot);
  const ownUnits: Divergence['ownUnits'] = [];
  for (const u of mine) {
    const b = belief.units.find((x) => x.id === u.id);
    if (!b || at(b.q, b.r) !== at(u.q, u.r)) ownUnits.push({ id: u.id, believed: b ? { q: b.q, r: b.r } : null, actual: { q: u.q, r: u.r } });
  }
  for (const b of belief.units) {
    if (!mine.some((u) => u.id === b.id)) ownUnits.push({ id: b.id, believed: { q: b.q, r: b.r }, actual: null });
  }

  const foes = truth.units.filter((u) => u.owner !== slot);
  const ghosts = belief.foe.filter((f) => !foes.some((u) => u.id === f.id && u.q === f.q && u.r === f.r)).map((f) => f.id);
  const unseen = foes.filter((u) => !belief.foe.some((f) => f.id === u.id)).length;

  return { t: truth.t, stale: belief.stale, needles, ownUnits, ghosts, unseen };
}
