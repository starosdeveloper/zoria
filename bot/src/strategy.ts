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

/* голова, яку стратегія веде: провід дає їй байти як є */
type Head = WireBot & { feedback(verdicts: Uint8Array): void };

/* Спільне в обох стратегій - передати голові маніфест, кадр і вердикти як є.
   Різне - що завести на старті партії, звідки кадр щоденника і чий звіт. */
abstract class HeadStrategy<H extends Head> implements Strategy {
  protected head: H;

  constructor(head: H) {
    this.head = head;
  }

  init(manifest: Uint8Array, slot: SlotName): void {
    this.head.init(manifest, slot);
    this.started(slot);
  }

  tick(observe: Uint8Array): Uint8Array {
    return this.head.tick(observe);
  }

  feedback(verdicts: Uint8Array): void {
    this.head.feedback(verdicts);
  }

  protected abstract started(slot: SlotName): void;
  abstract belief(obs: Observe | null): BeliefFrame | null;
  abstract report(): string;
}

class HarvestStrategy extends HeadStrategy<HarvestBot> {
  private book: BeliefBook | null = null;

  constructor() {
    super(new HarvestBot());
  }

  protected started(slot: SlotName): void {
    this.book = new BeliefBook(slot);
  }

  /* no mirror world here: the journal is assembled from the observation */
  belief(obs: Observe | null): BeliefFrame | null {
    return this.book && obs ? this.book.frame(obs) : null;
  }

  report(): string {
    return this.head.report();
  }
}

class MirrorStrategy extends HeadStrategy<MirrorBot> {
  private trace: BeliefTrace | null = null;

  constructor(preset: string) {
    super(sampleBot(createEngine, preset));
  }

  protected started(slot: SlotName): void {
    this.trace = new BeliefTrace(slot);
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
