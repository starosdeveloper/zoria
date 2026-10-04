/* Разбор эпизода (оценивание 10.2, Р3): по журналу партии и диапазону тактов —
   что видел бот, что решил и какой путь в коде это решил.

   Голова детерминирована: те же кадры наблюдения дают те же команды. Поэтому
   эпизод не пересказывается, а воспроизводится: журнал прогоняется движком, на
   нашем месте свежая «жатва» получает тот же кадр, что получал бот, и те же
   вердикты (из записанных отказов воротаря), а мир ведёт записанная лента. Её
   команды сверяются с журналом байт в байт на всём пути до конца диапазона —
   расхождение значит, что объяснение не о той голове, и инструмент так и скажет.

   Запуск: node episode.js <match-N.runlog> <A|B|C> <от> <до> [ручки JSON]
   Ручки — только если партию играл другой набор (SPAR_DIALS той сдачи). */

import { readFileSync } from 'node:fs';
import { createEngine } from '@zoria/engine';
import { decodeObserve, decodeOrders, encodeObserve, encodeVerdicts, observeWire, readRunLog } from '@zoria/protocol';
import { openJournal } from '@zoria/sdk';
import { DIALS, HarvestBot } from './dist/harvest.js';
import { blockEnd } from '../scripts/decisions-check.mjs';

/* --md — черновик EPISODE.md вместо разбора в терминал */
const MD = process.argv.includes('--md');
const [file, slot, fromArg, toArg, dialsArg] = process.argv.slice(2).filter((a) => a !== '--md');
if (!file || !['A', 'B', 'C'].includes(slot) || !Number.isFinite(Number(fromArg)) || !Number.isFinite(Number(toArg))) {
  console.error('node episode.js <match-N.runlog> <A|B|C> <от> <до> [ручки JSON]');
  process.exit(2);
}
const from = Number(fromArg);
const to = Number(toArg);
const bytes = readFileSync(file);
const log = readRunLog(bytes);

/* ветка pickPlan -> функция harvest.ts; номера строк — по коду, который лежит
   рядом, а не по памяти: ответ эпизода ссылается на код финальной сдачи */
const BRANCH = {
  guard: ['guardPlan', 'Клинок-сторож: чужой Ткач на нашей голке', 'прогрев чужой горящей голки 24 такта, греющий стоит на ней (9.2); таран Ткача за работой чистый (11.7)'],
  jam: ['jamPlan', 'Клинок-завада', 'покрытие заглушённой голки тянет глушащий (8.7, 11.4)'],
  order: ['orderPlan', 'замовлення', '30 минут за три удержанные голки (18)'],
  relight: ['relightPlan', 'мост к своей погасшей голке', 'голка горит, только пока к ней тянется нить (7.2); её покрытие уже оплачено'],
  flood: ['buildPlan', 'стройка при заряде выше flood', 'заряд выше 360 сгорает (8.9), а рой упёрт в вес 8 (10.2)'],
  take: ['takePlan', 'ничья или чужая руина в досягаемости нити', 'Ткач на голке греет её и забирает (9.1–9.3)'],
  stage: ['stagePlan', 'стоянка у кольца перед зорёй', 'после зори голка кольца тянет вдвое (22.4); стоянка у межи не провоцирует Ключника (21.7)'],
  build: ['buildPlan', 'стройка', 'своя голка за 60 заряда и 8 тактов (12.1–12.3)'],
  feed: ['feedPlan', 'живлення', 'живлення сдвигает покрытие на кольцо наружу, пока Ткач стоит на голке (8.5)'],
};
const src = readFileSync(new URL('./src/harvest.ts', import.meta.url), 'utf8');
const lines = src.split('\n');
const where = (fn) => {
  const at = lines.findIndex((l) => new RegExp('^\\s+private ' + fn + '\\(').test(l)) + 1;
  return at > 0 ? 'bot/src/harvest.ts:' + at + '–' + blockEnd(src, at) : '?';
};
const pickAt = where('pickPlan');

/* записанное: команды слота по тактам, отказы воротаря, такты под наказом */
const submitted = new Map();
for (const [t, s, b] of log.submits) if (s === slot) submitted.set(t, b);
const denied = new Map();
for (const [s, t, i, code] of log.denies ?? []) {
  if (s !== slot) continue;
  if (!denied.has(t)) denied.set(t, new Map());
  denied.get(t).set(i, code);
}
const charter = (t) => log.episodes.some(([s, a, b]) => s === slot && t >= a && t <= b);

const head = new HarvestBot({ ...DIALS, ...JSON.parse(dialsArg || '{}') });
head.init(log.manifest, slot);

const c = openJournal(createEngine, bytes);
const E = c.engine;
const tape = E.SIM.pilot[slot];
if (typeof tape !== 'function') {
  console.error('в журнале место ' + slot + ' не вёл бот: ' + log.bots.join(','));
  process.exit(2);
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
let checked = 0;
let mismatch = 0;
let firstMismatch = null;
const rows = [];

E.SIM.pilot[slot] = () => {
  const t = E.SIM.t;
  const frame = encodeObserve(observeWire(E, slot));
  const out = head.tick(frame);
  const orders = decodeOrders(out) ?? [];
  if (!charter(t)) {
    const rec = submitted.get(t) ?? new Uint8Array(0);
    checked++;
    if (!same(orders.length ? out : new Uint8Array(0), rec)) {
      mismatch++;
      firstMismatch ??= t;
    }
  }
  /* вердикты, какие получил бот: записанный отказ или «принято» */
  const deny = denied.get(t);
  head.feedback(encodeVerdicts(orders.map((_, i) => (deny?.has(i) ? [i, false, deny.get(i)] : [i, true, 0]))));
  if (t >= from && t <= to) {
    const obs = decodeObserve(frame);
    rows.push({ t, obs, orders, plans: new Map([...head.plans].map(([id, p]) => [id, { ...p }])), charter: charter(t) });
  }
  tape();
};

c.seek(to);

const hex = (h) => '(' + h.q + ', ' + h.r + ')';
const say = (o) => {
  const u = o.unit ? o.unit + ' ' : '';
  if (o.kind === 'move') return u + 'move → ' + hex(o);
  if (o.kind === 'needle') return u + 'needle ' + hex(o);
  if (o.kind === 'feed') return u + 'feed ' + hex(o);
  if (o.kind === 'ram') return u + 'ram ' + o.target;
  if (o.kind === 'jam') return u + 'jam ' + (o.target ? hex(o.target) : '—');
  if (o.kind === 'yard') return 'yard ' + o.cls;
  if (o.kind === 'bid') return 'bid лот ' + o.lot + ' на ' + o.amount;
  if (o.kind === 'watch') return 'watch ' + hex(o);
  return o.kind + (o.unit ? ' ' + o.unit : '');
};

const usedBranches = () => {
  const s = new Set();
  for (const r of rows) for (const p of r.plans.values()) if (p.by) s.add(p.by);
  return [...s];
};

if (MD) {
  /* Черновик, а не ответ: «почему» здесь — пункты правил при ветке, а связать их
     с тем, что происходило на поле, должен человек, который будет защищать
     ответ на аудите (11.5). */
  const out = [];
  out.push('# Эпизод', '');
  out.push('> Черновик из `bot/episode.js`: проверить по журналу, дописать раздел «Почему» своими словами, удалить эту строку.', '');
  out.push('Партия: `' + file + '`, место ' + slot + ', такты ' + from + '–' + to + '.', '');
  out.push('## Сверка с журналом', '');
  out.push(
    mismatch
      ? 'Голова **расходится** с журналом с такта ' + firstMismatch + ' — ниже объяснение не той головы; ответ по этим строкам давать нельзя.'
      : 'Свежая голова на тех же кадрах и вердиктах дала те же команды, что записаны в журнале: ' + checked + ' тактов из ' + checked + ' совпали байт в байт (такты под наказом не сверяются).',
    '',
  );
  out.push('## Путь в коде', '');
  out.push('План каждой машине выбирает `pickPlan` (`' + pickAt + '`) — первая подходящая ветка сверху вниз:', '');
  out.push('| Ветка | Функция | Что выбрано | Почему (правила) |', '|---|---|---|---|');
  for (const b of usedBranches()) {
    const [fn, what, rule] = BRANCH[b] ?? ['?', b, ''];
    const site = fn === 'buildPlan' || fn === 'relightPlan' ? '; майданчик — `sitePlan` (`' + where('sitePlan') + '`)' : '';
    out.push('| `' + b + '` | `' + fn + '` (`' + where(fn) + '`)' + site + ' | ' + what + ' | ' + rule + ' |');
  }
  out.push('', '## По тактам', '');
  out.push('| Такт | Заряд | Голок (горит) | Машина | Где | План | Ветка | Команда |', '|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const p = r.obs?.pulse;
    const lit = r.obs ? r.obs.mine.needles.filter((n) => !n.dark).length : 0;
    const cmd = new Map();
    for (const o of r.orders) if (o.unit) cmd.set(o.unit, say(o));
    for (const u of r.obs?.mine.units ?? []) {
      const plan = r.plans.get(u.id);
      out.push(
        '| ' + r.t + (r.charter ? ' (наказ)' : '') + ' | ' + (p ? Math.round(p.energy) : '') + ' | ' + (r.obs ? r.obs.mine.needles.length + ' (' + lit + ')' : '') +
          ' | ' + u.id + ' | ' + hex(u) + ' | ' + (plan ? plan.kind + ' ' + hex(plan.at) + ', с ' + plan.since : '—') + ' | ' + (plan?.by ?? '—') +
          ' | ' + (cmd.get(u.id) ?? '') + ' |',
      );
    }
    const free = r.orders.filter((o) => !o.unit).map(say);
    if (free.length) out.push('| ' + r.t + ' | | | — | | | | ' + free.join('; ') + ' |');
  }
  out.push('', '## Почему', '', '_Дописать: что на поле сделало эту ветку первой подходящей (заряд, чужие машины, расстояния), со ссылкой на такты таблицы выше._', '');
  process.stdout.write(out.join('\n'));
  process.exit(mismatch ? 1 : 0);
}

console.log('журнал ' + file + ', место ' + slot + ', такты ' + from + '–' + to);
console.log(
  'сверка с журналом: ' + (checked - mismatch) + ' тактов из ' + checked + ' совпали байт в байт' +
    (mismatch ? ' — РАСХОЖДЕНИЕ с такта ' + firstMismatch + ': объяснение ниже не о той голове или не о тех ручках' : ''),
);
console.log('выбор плана — pickPlan ' + pickAt + '; ветки:');
const used = new Set();
for (const r of rows) for (const p of r.plans.values()) if (p.by) used.add(p.by);
for (const b of used) {
  const [fn, what] = BRANCH[b] ?? ['?', b];
  /* стройка и мост — тонкие обёртки: майданчик выбирает sitePlan */
  const site = fn === 'buildPlan' || fn === 'relightPlan' ? ', майданчик — sitePlan ' + where('sitePlan') : '';
  console.log('  ' + b.padEnd(8) + fn + ' ' + where(fn) + site + ' — ' + what);
}
console.log('');

for (const r of rows) {
  const p = r.obs?.pulse;
  const lit = r.obs ? r.obs.mine.needles.filter((n) => !n.dark).length : 0;
  console.log(
    'такт ' + r.t + (r.charter ? ' [слот вёл наказ]' : '') +
      (p ? ': заряд ' + Math.round(p.energy) + ', канал ' + p.chanAt + ', голок ' + r.obs.mine.needles.length + ' (горит ' + lit + ')' : ''),
  );
  for (const u of r.obs?.mine.units ?? []) {
    const plan = r.plans.get(u.id);
    const task = u.task ? (u.task.path > 0 ? 'в пути ' + u.task.path : u.task.feed ? 'живит' : u.task.site ? 'строит' : u.task.ram ? 'гонит ' + u.task.ram : 'задание') : 'без задания';
    console.log(
      '    ' + u.id.padEnd(8) + u.cls.padEnd(7) + hex(u).padEnd(11) + task.padEnd(14) +
        (plan ? 'план ' + plan.kind + ' ' + hex(plan.at) + ' с такта ' + plan.since + ' ← ' + (plan.by ?? '?') : 'плана нет'),
    );
  }
  for (const e of r.obs?.events ?? []) {
    if (['cap', 'lost', 'ram', 'jam', 'build', 'raise', 'lot', 'order', 'orderDone', 'dawn'].includes(e.type)) console.log('    событие ' + JSON.stringify(e));
  }
  if (r.orders.length) console.log('    команды: ' + r.orders.map(say).join('; '));
}
process.exit(mismatch ? 1 : 0);
