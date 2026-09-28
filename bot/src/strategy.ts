/* bot :: strategy
   ТУТ ВАША СТРАТЕГІЯ - єдиний файл шаблону, який мусить стати вашим.

   Заглушка - дзеркальна голова архетипу SDK: вона грає, але своїх правил у
   неї немає; списуйте з неї контракт, а не тактику. Контракт - WireBot
   (маніфест, кадр спостереження -> кадр команд, вердикти) плюс кадр
   щоденника віри. Архетип заглушки - ZARIA_PRESET (рівний, шир, обхідник,
   проривник, облягач).

   Свою голову починають із BlankBot з @zoria/sdk:

     class MyBot extends BlankBot {
       protected override think(obs: Observe): Order[] { ... }
     }

   і повертають її з createStrategy(); belief() без дзеркала збирає
   BeliefFrame сам або віддає null. Мережі тут немає і бути не повинно:
   провід, повернення і піни живуть у main.ts і connectBot. */

import { createEngine } from '@zoria/engine';
import { ARCHETYPES, BeliefTrace, sampleBot } from '@zoria/sdk';
import type { BeliefFrame, MirrorBot, WireBot } from '@zoria/sdk';
import type { Observe, SlotName } from '@zoria/protocol';

export interface Strategy extends WireBot {
  /* кадр щоденника віри такту; null - кадру немає */
  belief(obs: Observe | null): BeliefFrame | null;
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
}

/* імена архетипів заглушки: за ними службова ручка зміни пресета вирішує,
   є такий пресет чи ні. Своя голова повертає тут свої імена */
export function presets(): string[] {
  return Object.keys(ARCHETYPES);
}

export function createStrategy(preset = process.env['ZARIA_PRESET'] || 'рівний'): Strategy {
  return new MirrorStrategy(preset);
}
