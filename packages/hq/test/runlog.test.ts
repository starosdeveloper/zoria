/* Журнал партии без SDK. Запись собрана байтами вручную по `run-log` и
   `manifest` из protocol.cddl; сверка с `readRunLog` SDK на настоящих записях —
   в ROADMAP (70 из 70). */

import { describe, expect, it } from 'vitest';
import { channelProfile } from '../src/channel.js';
import { readRunlog, RunlogError } from '../src/runlog.js';

const hex = (h: string) => new Uint8Array((h.replace(/\s+/g, '').match(/../g) ?? []).map((b) => parseInt(b, 16)));

/* манифест из 16 полей: v 8, семь нулей, ticks 1200, шесть нулей, engine "ab" */
const MANIFEST = '90 08 00000000000000 1904b0 000000000000 626162';
const BODY = [
  '08',
  '55' + MANIFEST, // bstr из 21 байта
  '82 00 02', // bots [0, 2]
  '82 83 01 00 42 8100   83 02 02 41 a0', // submits [[1, 0, h'8100'], [2, 2, h'a0']]
  '82 6178 6179', // hall ["x", "y"]
  '81 83 02 05 09', // episodes [[2, 5, 9]]
];
const DENIES = '81 84 00 01 00 0b'; // [[0, 1, 0, 11]]

describe('readRunlog', () => {
  it('семь полей: всё по буквам слотов', () => {
    const r = readRunlog(hex('87' + BODY.join('') + DENIES));
    expect(r).toEqual({
      v: 8,
      ticks: 1200,
      engine: 'ab',
      bots: ['A', 'C'],
      submits: [
        [1, 'A', hex('8100')],
        [2, 'C', hex('a0')],
      ],
      hall: ['x', 'y'],
      episodes: [['C', 5, 9]],
      denies: [['A', 1, 0, 11]],
    });
  });

  it('шесть полей (10.5) читаются с пустыми отказами', () => {
    expect(readRunlog(hex('86' + BODY.join(''))).denies).toEqual([]);
  });

  it('профиль канала прямо из журнала', () => {
    const r = readRunlog(hex('87' + BODY.join('') + DENIES));
    const p = channelProfile(r.submits, r.denies, 'A', 3);
    expect(p.totals).toEqual({ bytes: 2, commands: 1, denies: 1, silent: 2, malformed: 0 });
    expect(p.byCode).toEqual([{ code: 11, word: 'земля', count: 1 }]);
  });

  it('не по схеме — ошибка с названным полем', () => {
    const bad = (h: string) => () => readRunlog(hex(h));
    expect(bad('85' + BODY.slice(0, 5).join(''))).toThrow(new RunlogError('журнал не по схеме run-log: 5 полей, ожидалось 6 или 7'));
    expect(bad('86' + BODY.slice(0, 1).join('') + '00' + BODY.slice(2).join(''))).toThrow(/манифест — не байтовая строка/);
    expect(bad('86' + BODY.slice(0, 2).join('') + '81 03' + BODY.slice(3).join(''))).toThrow(
      /состав\[0\] = 3, слот бывает 0\.\.2/,
    );
    expect(bad('86' + BODY.slice(0, 3).join('') + '81 82 01 00' + BODY.slice(4).join(''))).toThrow(
      /кадр 0 — 2 полей вместо 3/,
    );
    expect(bad('87' + BODY.join('') + '81 84 00 01 00 20')).toThrow(/отказ 0: код — не целое ≥ 0/);
  });

  it('не CBOR вовсе (дневник веры вместо журнала) — названо, что это не журнал', () => {
    const ndjson = new TextEncoder().encode('{"t":1,"full":true}\n');
    expect(() => readRunlog(ndjson)).toThrow(/^журнал не по схеме run-log: файл не разбирается как CBOR \(CBOR, байт/);
  });
});
