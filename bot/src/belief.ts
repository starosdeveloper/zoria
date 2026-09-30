/* bot :: belief
   The belief journal (P2-05): one NDJSON line per tick with what the bot holds
   to be true about the valley. `BeliefTrace` of the SDK reads the mirror world
   of a built-in head; this head has no mirror, so the frame is assembled from
   the observation itself and from what we remember of cells we no longer see.

   Full frames every `fullEvery` ticks, diffs in between - the shape the SDK
   writes, so `zaria-kit replay` and the part 3 viewer read both the same way. */

import type { BeliefFrame } from '@zoria/sdk';
import type { ActorName, Observe, SlotName } from '@zoria/protocol';
import { key } from './valley.js';

export class BeliefBook {
  private own = new Map<string, ActorName | null>();
  private dark = new Map<string, boolean>();
  private n = 0;

  constructor(
    private readonly slot: SlotName,
    private readonly fullEvery = 200,
  ) {}

  /** Remembered owner of a needle cell, or undefined when never seen. */
  ownerOf(k: string): ActorName | null | undefined {
    return this.own.get(k);
  }

  private see(k: string, owner: ActorName | null, dark: boolean): void {
    this.own.set(k, owner);
    this.dark.set(k, dark);
  }

  /** Reads the tick into memory and returns the journal frame for it. */
  frame(obs: Observe): BeliefFrame {
    const ownDelta: Record<string, string | null> = {};
    const darkDelta: Record<string, boolean> = {};
    for (const e of obs.own) {
      const k = key(e.q, e.r);
      if (this.own.get(k) !== e.owner) ownDelta[k] = e.owner;
      if (this.dark.get(k) !== e.dark) darkDelta[k] = e.dark;
      this.see(k, e.owner, e.dark);
    }
    for (const n of obs.mine.needles) {
      const k = key(n.q, n.r);
      if (this.own.get(k) !== this.slot) ownDelta[k] = this.slot;
      if (this.dark.get(k) !== n.dark) darkDelta[k] = n.dark;
      this.see(k, this.slot, n.dark);
    }

    const full = this.n % this.fullEvery === 0;
    this.n++;

    const f: BeliefFrame = {
      t: obs.t,
      pulse: {
        energy: obs.pulse.energy,
        chan: obs.pulse.chan,
        ear: obs.pulse.ear,
        minutes: obs.pulse.minutes,
        needles: obs.pulse.needles,
      },
    };
    if (full) {
      f.full = true;
      f.own = Object.fromEntries(this.own);
      f.dark = Object.fromEntries([...this.dark].filter(([, v]) => v));
    } else {
      if (Object.keys(ownDelta).length) f.own = ownDelta;
      if (Object.keys(darkDelta).length) f.dark = darkDelta;
    }
    if (obs.foe.length) f.foe = obs.foe.map((u) => [u.id, u.p, u.q, u.r]);
    if (obs.noisy.length) f.noisy = obs.noisy.length;
    if (obs.mine.units.length) f.units = obs.mine.units.map((u) => [u.id, u.q, u.r, u.task ? u.task.path : 0]);
    const pact = obs.pub.pact.active.find((p) => p.a === this.slot || p.b === this.slot);
    f.pact = pact ? (pact.a === this.slot ? pact.b : pact.a) : null;
    if (obs.pub.cries.length) f.cries = obs.pub.cries.map(([s, n]) => [s, n]);
    return f;
  }
}
