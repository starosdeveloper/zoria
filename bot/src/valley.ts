/* bot :: valley
   Static knowledge of the match: hex arithmetic and everything the manifest
   says before the first tick (rules 5, 16, 26.2). Nothing here changes during
   the match, so it is built once in init() and read every tick.

   Hex distance, neighbours and the pixel mapping are copied from rules 5.1 so
   that this file agrees with the engine by construction, not by coincidence. */

import type { ClsName, FindKind, Hex, Manifest, NeedleSpec, SlotName } from '@zoria/protocol';
import type { RulesOracle } from '@zoria/sdk';

export const DIRS: readonly [number, number][] = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
];

export function key(q: number, r: number): string {
  return q + ',' + r;
}

export function dist(aq: number, ar: number, bq: number, br: number): number {
  const dq = aq - bq;
  const dr = ar - br;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

export function hexDist(a: Hex, b: Hex): number {
  return dist(a.q, a.r, b.q, b.r);
}

export function same(a: Hex, b: Hex): boolean {
  return a.q === b.q && a.r === b.r;
}

/** Cells at exactly `rad` from the centre, in no particular order. */
export function ring(centre: Hex, rad: number): Hex[] {
  if (rad === 0) return [{ q: centre.q, r: centre.r }];
  const out: Hex[] = [];
  let q = centre.q + DIRS[4]![0] * rad;
  let r = centre.r + DIRS[4]![1] * rad;
  for (let side = 0; side < 6; side++) {
    const [dq, dr] = DIRS[side]!;
    for (let step = 0; step < rad; step++) {
      out.push({ q, r });
      q += dq;
      r += dr;
    }
  }
  return out;
}

/* The manifest names the two numbers of a land type apart (appendix A.2):
   `cost` is the step multiplier of rule 10.5, `min` is the cell price of rule
   8.3. They differ - a meadow steps like plain but pays half again as much -
   so they are kept apart here too. */
export interface Land {
  readonly pass: boolean;
  readonly build: boolean;
  readonly step: number;
  readonly price: number;
}

/** Everything the manifest fixes for the whole match. */
export class Valley {
  readonly radius: number;
  readonly citadel: Hex;
  readonly cherta: number;
  readonly ticks: number;
  readonly dawnAt: number;
  readonly cfg: Record<string, number>;
  readonly needles: Map<string, NeedleSpec>;
  /** Free ruins of the valley (rule 5.6): neither start needles nor the ring. */
  readonly ruins: string[];
  /** The Keeper's ring and spokes, takeable cheaply after dawn (rule 22.3). */
  readonly ringKeys: string[];
  readonly finds: Map<string, FindKind>;
  private readonly land: Map<string, Land>;
  private readonly plain: Land;
  private readonly seats: readonly Hex[];

  constructor(private readonly m: Manifest) {
    this.radius = m.terrain.radius;
    this.citadel = m.citadel;
    this.cherta = m.cherta;
    this.ticks = m.ticks;
    this.dawnAt = m.dawn.at;
    this.cfg = m.cfg;
    this.seats = m.seats;

    const types = m.terrain.types;
    const plain = types[0];
    if (!plain) throw new Error('manifest without terrain types');
    this.plain = { pass: plain.pass, build: plain.build, step: plain.cost, price: plain.min };
    this.land = new Map();
    for (const [q, r, t] of m.terrain.cells) {
      const type = types[t];
      if (!type) continue;
      this.land.set(key(q, r), { pass: type.pass, build: type.build, step: type.cost, price: type.min });
    }

    this.needles = new Map();
    this.ruins = [];
    this.ringKeys = [];
    for (const n of m.needles) {
      const k = key(n.q, n.r);
      this.needles.set(k, n);
      if (n.ring || n.spoke) this.ringKeys.push(k);
      else if (n.start === null) this.ruins.push(k);
    }

    this.finds = new Map();
    for (const f of m.finds) this.finds.set(key(f.q, f.r), f.kind);
  }

  at(k: string): Land {
    return this.land.get(k) ?? this.plain;
  }

  cellOf(k: string): Hex {
    const i = k.indexOf(',');
    return { q: Number(k.slice(0, i)), r: Number(k.slice(i + 1)) };
  }

  inValley(q: number, r: number): boolean {
    return dist(q, r, this.citadel.q, this.citadel.r) <= this.radius - 1;
  }

  /** Inside the Keeper's border: heating and building here provoke him (rule 21.6). */
  inCherta(a: Hex): boolean {
    return hexDist(a, this.citadel) <= this.cherta;
  }

  /** Income weight of a cell: its land price (rule 8.3, appendix A.2). */
  price(q: number, r: number): number {
    return this.inValley(q, r) ? this.at(key(q, r)).price : 0;
  }

  /** Our hearth. The slot letter names the vertex (rule 5.4), verified in harvest.ts. */
  seat(slot: SlotName): Hex {
    const i = slot === 'A' ? 0 : slot === 'B' ? 1 : 2;
    return this.seats[i] ?? this.seats[0]!;
  }

  seatList(): readonly Hex[] {
    return this.seats;
  }

  lots(): readonly { at: number; cells: Hex[] }[] {
    return this.m.lots;
  }

  /** Travel time in ticks along the node's own path, or null when there is no way.
      The node's path does not include the cell the machine starts on - pinned by a
      test, because `stepCost` of a cell to itself is not zero (it is the cost of one
      step on that land), so a path that repeated the start would overcount. */
  travel(o: RulesOracle, from: Hex, to: Hex, cls: ClsName): number | null {
    const path = o.path(from, to, cls);
    if (path === null) return null;
    let ticks = 0;
    let prev = from;
    for (const step of path) {
      ticks += o.stepCost(prev, step, cls);
      prev = step;
    }
    return ticks;
  }
}
