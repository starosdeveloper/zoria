/* hq :: runlog
   Журнал партии (`.runlog`, 04-protocol 10.1, `run-log` в protocol.cddl) без
   SDK: штаб открывает запись в браузере, а SDK лежит в частном реестре.

   Читается только то, что нужно штабу без движка: длина партии и пин из
   манифеста, состав, кадры команд, зал, эпизоды наказа и отказы воротаря. Мир
   из этого не восстановить — для правды нужен движок (`truth.ts`, `tape.ts`).
   Слоты в журнале — числа 0..2; здесь они буквы, как в дневнике веры и в
   событиях движка, чтобы профайлер и вера говорили об одном слоте одним словом.

   Файл не по схеме — ошибка с названным полем, а не пустой профиль: пустой
   график выглядел бы как молчавший бот. */

import { CborError, decodeCbor, type Cbor } from './cbor.js';

export type SlotLetter = 'A' | 'B' | 'C';
const LETTERS: readonly SlotLetter[] = ['A', 'B', 'C'];

/** Индексы полей манифеста по `manifest` в protocol.cddl. */
const MANIFEST_TICKS = 8;
const MANIFEST_ENGINE = 15;

export interface Runlog {
  v: number;
  ticks: number;
  /** пин движка из манифеста, hex */
  engine: string;
  /** чьи решения записаны */
  bots: SlotLetter[];
  submits: [t: number, slot: SlotLetter, frame: Uint8Array][];
  /** ники по слотам A, B, C; пусто — зал неизвестен */
  hall: string[];
  /** такты from..to включительно, где слотом правил наказ */
  episodes: [slot: SlotLetter, from: number, to: number][];
  denies: [slot: SlotLetter, t: number, index: number, code: number][];
}

export class RunlogError extends Error {}

function fail(what: string): never {
  throw new RunlogError(`журнал не по схеме run-log: ${what}`);
}

const uint = (x: Cbor, what: string): number =>
  typeof x === 'number' && Number.isInteger(x) && x >= 0 ? x : fail(`${what} — не целое ≥ 0`);

const list = (x: Cbor, what: string): Cbor[] => (Array.isArray(x) ? x : fail(`${what} — не массив`));

function slot(x: Cbor, what: string): SlotLetter {
  const n = uint(x, what);
  return LETTERS[n] ?? fail(`${what} = ${String(n)}, слот бывает 0..2`);
}

function tuple(x: Cbor, n: number, what: string): Cbor[] {
  const a = list(x, what);
  return a.length === n ? a : fail(`${what} — ${String(a.length)} полей вместо ${String(n)}`);
}

function decode(bytes: Uint8Array, what: string): Cbor {
  try {
    return decodeCbor(bytes);
  } catch (e) {
    if (e instanceof CborError || e instanceof TypeError) fail(`${what} не разбирается как CBOR (${e.message})`);
    throw e;
  }
}

export function readRunlog(bytes: Uint8Array): Runlog {
  const top = list(decode(bytes, 'файл'), 'запись');
  /* 10.5: законны шесть полей (без отказов) и семь */
  if (top.length !== 6 && top.length !== 7) fail(`${String(top.length)} полей, ожидалось 6 или 7`);
  const [v, manifestBytes, bots, submits, hall, episodes, denies = []] = top;

  if (!(manifestBytes instanceof Uint8Array)) fail('манифест — не байтовая строка');
  const manifest = list(decode(manifestBytes, 'манифест'), 'манифест');
  const engine = manifest[MANIFEST_ENGINE];
  if (typeof engine !== 'string') fail('пин движка в манифесте — не строка');

  return {
    v: uint(v, 'версия'),
    ticks: uint(manifest[MANIFEST_TICKS], 'длина партии в манифесте'),
    engine,
    bots: list(bots, 'состав').map((s, i) => slot(s, `состав[${String(i)}]`)),
    submits: list(submits, 'кадры').map((rec, i) => {
      const [t, s, frame] = tuple(rec, 3, `кадр ${String(i)}`);
      if (!(frame instanceof Uint8Array)) fail(`кадр ${String(i)}: команды — не байтовая строка`);
      return [uint(t, `кадр ${String(i)}: такт`), slot(s, `кадр ${String(i)}: слот`), frame];
    }),
    hall: list(hall, 'зал').map((n, i) => (typeof n === 'string' ? n : fail(`зал[${String(i)}] — не строка`))),
    episodes: list(episodes, 'эпизоды').map((rec, i) => {
      const [s, from, to] = tuple(rec, 3, `эпизод ${String(i)}`);
      return [slot(s, `эпизод ${String(i)}: слот`), uint(from, `эпизод ${String(i)}: от`), uint(to, `эпизод ${String(i)}: до`)];
    }),
    denies: list(denies, 'отказы').map((rec, i) => {
      const [s, t, index, code] = tuple(rec, 4, `отказ ${String(i)}`);
      return [
        slot(s, `отказ ${String(i)}: слот`),
        uint(t, `отказ ${String(i)}: такт`),
        uint(index, `отказ ${String(i)}: номер`),
        uint(code, `отказ ${String(i)}: код`),
      ];
    }),
  };
}
