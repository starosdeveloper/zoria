#!/usr/bin/env node
/* Сверка DECISIONS.md с кодом бота.

   Разбор оценивается по тому, что ни одно утверждение не опровергается кодом
   финальной сдачи, а номера строк разъезжаются с первой же правкой выше по
   файлу: за одну сессию `NEEDED` ушёл с 29 на 37, `pickPlan` — с 527 на 531,
   и документ этого не заметил. Поэтому проверяется:

   1. карта: каждый путь в ней существует; каждый файл `bot/src/*.ts` и каждый
      скрипт `bot/*.js` в ней есть; строка `bot/test/` называет каждый файл
      проверок;
   2. ссылки на код: только в форме `` `символ` (`bot/путь:N`) `` или
      `` `символ` (`bot/путь:N–M`) ``. Символ обязан стоять на строке N, а M —
      быть строкой, где закрывается блок, открытый на N. Ссылка без символа
      или старой формой «строка N» — ошибка: её нечем проверить.

   Выход 0 — всё сходится; 1 — список расхождений, у каждого правильное место. */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = join(ROOT, 'DECISIONS.md');

/* Конец блока, открытого на строке `from` (с 1): первая фигурная или
   квадратная скобка на этой строке или ниже и её парная. Строки, шаблоны и комментарии пропускаются,
   иначе скобка в тексте комментария сбила бы счёт. -1 — блока нет. */
export function blockEnd(text, from) {
  const lines = text.split('\n');
  let i = lines.slice(0, from - 1).reduce((n, l) => n + l.length + 1, 0);
  let line = from;
  let depth = 0;
  let opened = false;
  while (i < text.length) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '\n') line++;
    if (c === '/' && d === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      i++;
      while (i < text.length && text[i] !== c) {
        if (text[i] === '\\') i++;
        else if (text[i] === '\n') line++;
        i++;
      }
      i++;
      continue;
    }
    /* круглые не считаются: у функции первая скобка строки — список
       параметров, и он закрывается на той же строке, а блок — фигурная */
    if (c === '{' || c === '[') {
      depth++;
      opened = true;
    } else if (c === '}' || c === ']') {
      depth--;
      if (opened && depth === 0) return line;
    }
    i++;
  }
  return -1;
}

/* Ссылки на код: символ в обратных кавычках, за ним в пределах фразы место. */
const REF = /`([A-Za-z_$][\w$]*)`[^`\n]{0,60}?`(bot\/[\w./-]+):(\d+)(?:[–-](\d+))?`/g;
const ANY_PLACE = /`(bot\/[\w./-]+):(\d+)(?:[–-](\d+))?`/g;
const OLD_FORM = /\(?строк[аи]\s+\d+/g;

export function check(doc, read, exists, list) {
  const errs = [];

  /* 1. карта */
  const map = doc.split(/^## 1\. /m)[1]?.split(/^## /m)[0] ?? '';
  const rows = map.split('\n').filter((l) => l.startsWith('| `'));
  const named = new Set();
  for (const row of rows) {
    const head = row.split('|')[1] ?? '';
    for (const m of head.matchAll(/`([^`]+)`/g)) {
      const p = m[1];
      named.add(p);
      if (!exists(p)) errs.push('карта: пути нет: ' + p);
    }
  }
  /* модули бота и штаба (оценивание 10.1: «модули репозитория с кодом бота и штаба») */
  for (const dir of ['bot/src', 'packages/hq/src']) {
    for (const f of list(dir).filter((f) => f.endsWith('.ts') && f !== 'index.ts')) {
      if (!named.has(dir + '/' + f)) errs.push('карта: модуля нет в карте: ' + dir + '/' + f);
    }
  }
  for (const f of list('bot').filter((f) => f.endsWith('.js'))) {
    if (!named.has('bot/' + f)) errs.push('карта: скрипта нет в карте: bot/' + f);
  }
  const testRow = rows.find((r) => r.startsWith('| `bot/test/`')) ?? '';
  for (const f of list('bot/test').filter((f) => f.endsWith('.js'))) {
    const stem = f.replace(/\.test\.js$/, '').replace(/\.js$/, '');
    const said = testRow.includes('`' + stem + '`') || testRow.includes('`' + f + '`');
    if (!said) errs.push('карта: строка bot/test/ не называет ' + f);
  }

  /* 2. ссылки */
  const anchored = new Set();
  for (const m of doc.matchAll(REF)) {
    const [, sym, path, a, b] = m;
    anchored.add(m.index + m[0].lastIndexOf('`bot/'));
    if (!exists(path)) {
      errs.push('ссылка: файла нет: ' + path);
      continue;
    }
    const text = read(path);
    const lines = text.split('\n');
    const from = Number(a);
    const word = new RegExp('(^|[^\\w$])' + sym.replace(/\$/g, '\\$') + '($|[^\\w$])');
    if (!word.test(lines[from - 1] ?? '')) {
      /* подсказка — ближайшее к старому номеру объявление, а не первое упоминание:
         вызов `pickPlan` стоит раньше его объявления, а у ручки два объявления —
         поле в типе и значение в наборе */
      const s = sym.replace(/\$/g, '\\$');
      const decl = new RegExp(
        '^\\s*(export\\s+)?((async\\s+)?(function|const|let|class|interface|type)\\s+' + s + '\\b|((private|public|protected|readonly|static|async|override)\\s+)*' + s + '\\??\\s*[(:<=])',
      );
      let at = -1;
      lines.forEach((l, i) => {
        if (decl.test(l) && (at < 0 || Math.abs(i + 1 - from) < Math.abs(at - from))) at = i + 1;
      });
      errs.push('ссылка: `' + sym + '` не на ' + path + ':' + from + (at > 0 ? ' — ближайшее объявление на ' + at : ''));
      continue;
    }
    if (b !== undefined) {
      const end = blockEnd(text, from);
      if (end !== Number(b)) errs.push('ссылка: блок `' + sym + '` в ' + path + ' кончается на ' + end + ', а не на ' + b);
    }
  }
  for (const m of doc.matchAll(ANY_PLACE)) {
    if (!anchored.has(m.index)) errs.push('ссылка без символа перед местом: ' + m[0]);
  }
  for (const m of doc.matchAll(OLD_FORM)) errs.push('старая форма ссылки, её нечем проверить: «' + m[0] + '»');

  return errs;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const errs = check(
    readFileSync(DOC, 'utf8'),
    (p) => readFileSync(join(ROOT, p), 'utf8'),
    (p) => existsSync(join(ROOT, p.replace(/\/$/, ''))),
    (d) => readdirSync(join(ROOT, d), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name),
  );
  if (errs.length) {
    for (const e of errs) process.stdout.write(e + '\n');
    process.stdout.write('DECISIONS.md: расхождений ' + errs.length + '\n');
    process.exit(1);
  }
  process.stdout.write('DECISIONS.md: карта и ссылки сходятся с кодом\n');
}
