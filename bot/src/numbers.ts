/* bot :: numbers
   Числа мира из маніфеста, по одному чтению на партию.

   The manifest types `cfg` as `Record<string, number>`, so every lookup is
   `number | undefined` and the obvious shape is `cfg['heatEnemy'] ?? 24`. That
   default is a trap: the literal equals the current world, so a key that
   disappears or is renamed by a world shift (rules 1.4) leaves the head playing
   by yesterday's numbers, silently and with no line in the log. A missing number
   is not a zero to be papered over - it is a world we do not know, and refusing
   the match is the honest answer, the same one the head gives to a foreign
   engine hash.

   Here the numbers are read once, by name, and a missing one throws. The throw
   reaches connectBot as an incompatible init and closes the wire (SDK 3). */

export interface WorldNumbers {
  readonly linkRange: number;
  readonly costTkach: number;
  readonly costKlinok: number;
  readonly weightTkach: number;
  readonly weightKlinok: number;
  readonly squadWeight: number;
  readonly costNeedle: number;
  readonly heatNeedle: number;
  readonly heatEnemy: number;
  readonly heatDark: number;
  readonly capGrace: number;
  readonly jamKeep: number;
  readonly jamHold: number;
  readonly chanOrder: number;
  readonly chanTick: number;
  readonly dawnRing: number;
  readonly crownCycle: number;
}

/** Ключи, без которых пресет играть не может. */
export const NEEDED = [
  'linkRange',
  'costTkach',
  'costKlinok',
  'weightTkach',
  'weightKlinok',
  'squadWeight',
  'costNeedle',
  'heatNeedle',
  'heatEnemy',
  'heatDark',
  'capGrace',
  'jamKeep',
  'jamHold',
  'chanOrder',
  'chanTick',
  'dawnRing',
  'crownCycle',
] as const satisfies readonly (keyof WorldNumbers)[];

export function readNumbers(cfg: Record<string, number>): WorldNumbers {
  const out: Record<string, number> = {};
  for (const k of NEEDED) {
    const v = cfg[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error('манифест без числа мира: ' + k);
    }
    out[k] = v;
  }
  return out as unknown as WorldNumbers;
}
