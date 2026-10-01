/* bot :: strategy
   Which head plays the slot. `жатва` is ours (harvest.ts); the five archetype
   mirrors stay selectable so that a change can be measured against the same
   opponents the local pack fields (ZARIA_PRESET, `npm run spar`).

   The contract is WireBot - manifest, observation -> orders, verdicts - plus the
   belief frame of the tick. No network here: the wire, the resume and the pins
   live in main.ts and connectBot. */

import { createEngine } from '@zoria/engine';
import { ARCHETYPES, BeliefTrace, sampleBot } from '@zoria/sdk';
import type { BeliefFrame, MirrorBot, WireBot } from '@zoria/sdk';
import type { Observe, SlotName } from '@zoria/protocol';
import { BeliefBook } from './belief.js';
import { HarvestBot } from './harvest.js';

export const HARVEST = 'жатва';

export interface Strategy extends WireBot {
  /* кадр щоденника віри такту; null - кадру немає */
  belief(obs: Observe | null): BeliefFrame | null;
  /* короткий рядок про свої команди і відмови в кінці партії; '' - немовчати нічого */
  report(): string;
}

class HarvestStrategy implements Strategy {
  private readonly head = new HarvestBot();
  private book: BeliefBook | null = null;

  init(manifest: Uint8Array, slot: SlotName): void {
    this.head.init(manifest, slot);
    this.book = new BeliefBook(slot);
  }

  tick(observe: Uint8Array): Uint8Array {
    return this.head.tick(observe);
  }

  feedback(verdicts: Uint8Array): void {
    this.head.feedback(verdicts);
  }

  /* no mirror world here: the journal is assembled from the observation */
  belief(obs: Observe | null): BeliefFrame | null {
    return this.book && obs ? this.book.frame(obs) : null;
  }

  report(): string {
    return this.head.report();
  }
}

class MirrorStrategy implements Strategy {
  private head: MirrorBot;
  private trace: BeliefTrace | null = null;

  constructor(preset: string) {
    this.head = sampleBot(createEngine, preset);
  }

  init(manifest: Uint8Array, slot: SlotName): void {
    this.head.init(manifest, slot);
    this.trace = new BeliefTrace(slot);
  }

  tick(observe: Uint8Array): Uint8Array {
    return this.head.tick(observe);
  }

  feedback(verdicts: Uint8Array): void {
    this.head.feedback(verdicts);
  }

  /* віра дзеркала: світ дзеркальної голови і є те, у що вона вірить */
  belief(obs: Observe | null): BeliefFrame | null {
    const E = this.head.mirror();
    return this.trace && E ? this.trace.frame(E, obs) : null;
  }

  /* дзеркало своїх команд не рахує: їх рахує рушій усередині нього */
  report(): string {
    return '';
  }
}

/* имена пресетов: по ним служебная ручка смены пресета решает, есть такой или
   нет. Наш — первый, зеркала архетипов оставлены для спарринга */
export function presets(): string[] {
  return [HARVEST, ...Object.keys(ARCHETYPES)];
}

export function createStrategy(preset = process.env['ZARIA_PRESET'] || HARVEST): Strategy {
  return preset === HARVEST ? new HarvestStrategy() : new MirrorStrategy(preset);
}
