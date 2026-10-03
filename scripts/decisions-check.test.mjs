/* Сверщик DECISIONS.md обязан уметь упасть: каждый род расхождения ломается
   здесь нарочно, и проверка требует, чтобы он был назван. Иначе зелёный
   `pnpm check` значил бы только то, что сверщик ничего не сравнивает. */

import { describe, expect, it } from 'vitest';
import { blockEnd, check } from './decisions-check.mjs';

const CODE = [
  "export const LIST = [", //            1
  "  'a', // ] скобка в комментарии", // 2
  "  '}', /* { и тут */", //              3
  "];", //                                4
  "", //                                  5
  "function pick(u: number): number {", // 6
  "  if (u > 1) {", //                    7
  "    return `${u}}`;", //               8
  "  }", //                               9
  "  return 0;", //                      10
  "}", //                                11
].join('\n');

const FILES = {
  'bot/src/a.ts': CODE,
  'bot/src/b.ts': 'export const B = 1;\n',
  'bot/spar.js': '',
  'bot/test/a.test.js': '',
  'bot/test/world.js': '',
};

const MAP = [
  '## 1. Карта',
  '',
  '| Модуль | Ответственность |',
  '|---|---|',
  '| `bot/src/a.ts` | а |',
  '| `bot/src/b.ts` | б |',
  '| `bot/spar.js` | спарринг |',
  '| `bot/test/` | `a` и `world.js` |',
  '',
  '## 2. Решения',
  '',
].join('\n');

const fs = {
  read: (p) => FILES[p] ?? '',
  exists: (p) => p in FILES || Object.keys(FILES).some((f) => f.startsWith(p)),
  list: (d) =>
    Object.keys(FILES)
      .filter((f) => f.startsWith(d + '/') && !f.slice(d.length + 1).includes('/'))
      .map((f) => f.slice(d.length + 1)),
};

const run = (doc) => check(doc, fs.read, fs.exists, fs.list);

describe('blockEnd', () => {
  it('скобки в строках, шаблонах и комментариях не считаются', () => {
    expect(blockEnd(CODE, 1)).toBe(4);
    expect(blockEnd(CODE, 6)).toBe(11);
    expect(blockEnd(CODE, 7)).toBe(9);
  });

  it('круглые скобки параметров блоком не считаются', () => {
    expect(blockEnd('f(a, b) {\n}\n', 1)).toBe(2);
  });

  it('незакрытый блок — -1', () => {
    expect(blockEnd('function x() {\n', 1)).toBe(-1);
  });
});

describe('check', () => {
  it('сходящийся документ — без расхождений', () => {
    expect(run(MAP + '`pick` (`bot/src/a.ts:6–11`), `LIST` (`bot/src/a.ts:1–4`), `B` в `bot/src/b.ts:1`.\n')).toEqual([]);
  });

  it('символ уехал со строки — называется ближайшее объявление, а не первое упоминание', () => {
    expect(run(MAP + '`pick` (`bot/src/a.ts:5`)\n')).toEqual(['ссылка: `pick` не на bot/src/a.ts:5 — ближайшее объявление на 6']);
    /* вызов раньше объявления и два объявления одного имени: берётся ближайшее к старому номеру */
    /* строка 1 — вызов, 2 — объявление, 8 — поле в наборе, как ручки в DIALS */
    const two = 'pick(1);\nconst pick = 1;\n\n\n\n\nconst o = {\n  pick: 2,\n};\n';
    const doc = MAP.replace('| `bot/src/b.ts` | б |', '| `bot/src/b.ts` | б |\n| `bot/src/c.ts` | в |');
    const files = { ...FILES, 'bot/src/c.ts': two };
    const runC = (d) =>
      check(d, (p) => files[p] ?? '', (p) => p in files || Object.keys(files).some((f) => f.startsWith(p)), (d2) =>
        Object.keys(files)
          .filter((f) => f.startsWith(d2 + '/') && !f.slice(d2.length + 1).includes('/'))
          .map((f) => f.slice(d2.length + 1)),
      );
    expect(runC(doc + '`pick` (`bot/src/c.ts:7`)\n')).toEqual(['ссылка: `pick` не на bot/src/c.ts:7 — ближайшее объявление на 8']);
    expect(runC(doc + '`pick` (`bot/src/c.ts:3`)\n')).toEqual(['ссылка: `pick` не на bot/src/c.ts:3 — ближайшее объявление на 2']);
  });

  it('конец диапазона не там, где закрывается блок', () => {
    expect(run(MAP + '`pick` (`bot/src/a.ts:6–10`)\n')).toEqual(['ссылка: блок `pick` в bot/src/a.ts кончается на 11, а не на 10']);
  });

  it('символ, который лишь начинается так же, не засчитывается', () => {
    expect(run(MAP + '`pic` (`bot/src/a.ts:6`)\n')).toHaveLength(1);
  });

  it('место без символа и старая форма — ошибки', () => {
    expect(run(MAP + 'см. `bot/src/a.ts:6`\n')).toEqual(['ссылка без символа перед местом: `bot/src/a.ts:6`']);
    expect(run(MAP + '`pick` (строка 6)\n')).toEqual(['старая форма ссылки, её нечем проверить: «(строка 6»']);
  });

  it('модуль, скрипт и файл проверок, которых нет в карте', () => {
    const doc = MAP.replace('| `bot/src/b.ts` | б |\n', '').replace('| `bot/spar.js` | спарринг |\n', '').replace('`a` и ', '');
    expect(run(doc)).toEqual([
      'карта: модуля нет в карте: bot/src/b.ts',
      'карта: скрипта нет в карте: bot/spar.js',
      'карта: строка bot/test/ не называет a.test.js',
    ]);
  });

  it('путь в карте, которого нет в дереве', () => {
    expect(run(MAP.replace('`bot/src/b.ts` | б', '`bot/src/b.ts`, `bot/src/c.ts` | б'))).toEqual(['карта: пути нет: bot/src/c.ts']);
  });
});
