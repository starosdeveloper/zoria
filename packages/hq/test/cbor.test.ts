/* Чтение CBOR: пары «байты → значение» из RFC 8949, приложение A, целиком, а
   не пересчитанные той же арифметикой, что в коде. */

import { describe, expect, it } from 'vitest';
import { CborError, decodeCbor } from '../src/cbor.js';

const hex = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((b) => parseInt(b, 16)));
const dec = (h: string) => decodeCbor(hex(h));

describe('decodeCbor — RFC 8949, приложение A', () => {
  it('целые', () => {
    expect(dec('00')).toBe(0);
    expect(dec('17')).toBe(23);
    expect(dec('1818')).toBe(24);
    expect(dec('1903e8')).toBe(1000);
    expect(dec('1a000f4240')).toBe(1000000);
    expect(dec('1b000000e8d4a51000')).toBe(1000000000000);
    expect(dec('1bffffffffffffffff')).toBe(18446744073709551615n);
    expect(dec('20')).toBe(-1);
    expect(dec('29')).toBe(-10);
    expect(dec('3863')).toBe(-100);
    expect(dec('3903e7')).toBe(-1000);
    expect(dec('3bffffffffffffffff')).toBe(-18446744073709551616n);
  });

  it('числа с плавающей точкой: half, single, double', () => {
    expect(dec('f90000')).toBe(0);
    expect(dec('f93c00')).toBe(1);
    expect(dec('fb3ff199999999999a')).toBe(1.1);
    expect(dec('f93e00')).toBe(1.5);
    expect(dec('f97bff')).toBe(65504);
    expect(dec('fa47c35000')).toBe(100000);
    expect(dec('f90001')).toBe(5.960464477539063e-8);
    expect(dec('f90400')).toBe(0.00006103515625);
    expect(dec('f9c400')).toBe(-4);
    expect(dec('fbc010666666666666')).toBe(-4.1);
    expect(dec('f97c00')).toBe(Infinity);
    expect(dec('f9fc00')).toBe(-Infinity);
    expect(dec('f97e00')).toBeNaN();
  });

  it('простые значения', () => {
    expect(dec('f4')).toBe(false);
    expect(dec('f5')).toBe(true);
    expect(dec('f6')).toBeNull();
    expect(dec('f7')).toBeUndefined();
  });

  it('строки', () => {
    expect(dec('40')).toEqual(new Uint8Array());
    expect(dec('4401020304')).toEqual(hex('01020304'));
    expect(dec('60')).toBe('');
    expect(dec('6161')).toBe('a');
    expect(dec('6449455446')).toBe('IETF');
    expect(dec('62225c')).toBe('"\\');
    expect(dec('62c3bc')).toBe('ü');
    expect(dec('63e6b0b4')).toBe('水');
  });

  it('массивы, словари, теги', () => {
    expect(dec('80')).toEqual([]);
    expect(dec('83010203')).toEqual([1, 2, 3]);
    expect(dec('8301820203820405')).toEqual([1, [2, 3], [4, 5]]);
    expect(dec('98190102030405060708090a0b0c0d0e0f101112131415161718181819')).toEqual(
      Array.from({ length: 25 }, (_, i) => i + 1),
    );
    expect(dec('a0')).toEqual(new Map());
    expect(dec('a201020304')).toEqual(
      new Map([
        [1, 2],
        [3, 4],
      ]),
    );
    expect(dec('a26161016162820203')).toEqual(
      new Map<unknown, unknown>([
        ['a', 1],
        ['b', [2, 3]],
      ]),
    );
    expect(dec('c11a514b67b0')).toEqual({ tag: 1, value: 1363896240 });
  });

  it('байтовая строка — срез входа, без копии', () => {
    const input = hex('824201020a');
    const [b] = decodeCbor(input) as [Uint8Array];
    expect(b.buffer).toBe(input.buffer);
    expect(b.byteOffset).toBe(2);
  });
});

describe('decodeCbor — отказы с позицией', () => {
  const at = (h: string) => {
    try {
      dec(h);
    } catch (e) {
      if (e instanceof CborError) return [e.at, e.message];
      throw e;
    }
    return null;
  };

  it('неопределённая длина запрещена (04-protocol 2.3)', () => {
    expect(at('9fff')).toEqual([0, 'CBOR, байт 0: неопределённая длина']);
    expect(at('5f42010243030405ff')?.[0]).toBe(0);
  });

  it('обрезанный вход', () => {
    expect(at('830102')).toEqual([3, 'CBOR, байт 3: нужно ещё 1, вход кончился']);
    expect(at('44010203')).toEqual([1, 'CBOR, байт 1: нужно ещё 4, вход кончился']);
    expect(at('4401')).toEqual([1, 'CBOR, байт 1: длина 4 больше входа']);
    expect(at('19')).toEqual([1, 'CBOR, байт 1: нужно ещё 2, вход кончился']);
  });

  it('хвост после элемента', () => {
    expect(at('0000')).toEqual([1, 'CBOR, байт 1: после элемента ещё 1 байт']);
  });

  it('длина больше входа не выделяет память под массив', () => {
    expect(at('9affffffff')?.[1]).toMatch(/длина 4294967295 больше входа/);
  });

  it('битый UTF-8 в текстовой строке', () => {
    expect(() => dec('61ff')).toThrow(TypeError);
  });
});
