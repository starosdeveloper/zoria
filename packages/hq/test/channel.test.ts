/* Профайлер канала: длины массивов CBOR — литералы из RFC 8949 (3.1, примеры
   приложения A), а не та же арифметика, что в коде. */

import { describe, expect, it } from 'vitest';
import { cborArrayLength, channelProfile, DENY_WORD } from '../src/channel.js';

const bytes = (...b: number[]) => new Uint8Array(b);

describe('cborArrayLength', () => {
  it('короткая длина — в самом заголовке', () => {
    expect(cborArrayLength(bytes(0x80))).toBe(0); // []
    expect(cborArrayLength(bytes(0x83, 0x01, 0x02, 0x03))).toBe(3); // [1, 2, 3]
    expect(cborArrayLength(bytes(0x97))).toBe(23);
  });

  it('длина в следующих байтах: 1, 2 и 4 байта', () => {
    expect(cborArrayLength(bytes(0x98, 0x19))).toBe(25); // RFC 8949 A: [1, ..., 25]
    expect(cborArrayLength(bytes(0x99, 0x01, 0x00))).toBe(256);
    expect(cborArrayLength(bytes(0x9a, 0x00, 0x01, 0x00, 0x00))).toBe(65536);
  });

  it('не массив, неопределённая длина, обрезанный заголовок — null', () => {
    expect(cborArrayLength(bytes(0xa0))).toBeNull(); // {}
    expect(cborArrayLength(bytes(0x01))).toBeNull(); // 1
    expect(cborArrayLength(bytes(0x9f, 0xff))).toBeNull(); // [_ ] — неопределённая длина
    expect(cborArrayLength(bytes(0x99, 0x01))).toBeNull();
    expect(cborArrayLength(bytes())).toBeNull();
  });
});

describe('channelProfile', () => {
  const submits: [number, string, Uint8Array][] = [
    [1, 'A', bytes(0x82, 0x00, 0x00)],
    [1, 'B', bytes(0x81, 0x00)],
    [3, 'A', bytes(0x81, 0x00, 0x00, 0x00)],
    [4, 'A', bytes(0xa0)],
  ];
  const denies: [string, number, number, number][] = [
    ['A', 1, 1, 11],
    ['A', 3, 0, 4],
    ['A', 3, 0, 11],
    ['B', 1, 0, 9],
  ];
  const p = channelProfile(submits, denies, 'A', 4);

  it('по тактам: байты, команды, отказы своего слота', () => {
    expect(p.ticks).toEqual([
      { t: 1, bytes: 3, commands: 2, denies: [{ index: 1, code: 11, word: 'земля' }] },
      { t: 2, bytes: 0, commands: 0, denies: [] },
      {
        t: 3,
        bytes: 4,
        commands: 1,
        denies: [
          { index: 0, code: 4, word: 'поворот' },
          { index: 0, code: 11, word: 'земля' },
        ],
      },
      { t: 4, bytes: 1, commands: null, denies: [] },
    ]);
  });

  it('итоги: молчание, кривой кадр, отказы по словам', () => {
    expect(p.totals).toEqual({ bytes: 8, commands: 3, denies: 3, silent: 1, malformed: 1 });
    expect(p.byCode).toEqual([
      { code: 11, word: 'земля', count: 2 },
      { code: 4, word: 'поворот', count: 1 },
    ]);
  });

  it('словарь отказов — таблица 6.6 целиком, неизвестный код назван числом', () => {
    expect(Object.keys(DENY_WORD).length).toBe(22);
    expect(channelProfile([], [['A', 1, 0, 99]], 'A', 1).byCode).toEqual([{ code: 99, word: 'код 99', count: 1 }]);
  });
});
