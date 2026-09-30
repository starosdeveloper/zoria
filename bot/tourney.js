/* Локальный турнир (ROADMAP 6.3): пресет против роты соперников, а не против
   одной пары. Пакет уже есть латинский квадрат — три партии с пересадкой
   A/B/C, — поэтому вариация здесь по составам соперников и по жеребам.
   Метрика — средняя доля за партию: 2.0 значит «ровно посередине втроём».

   Базовая линия на каждом составе — зеркало архетипа «рівний» на нашем месте:
   без неё непонятно, силён пресет или состав слабый.

   Запуск:  npm run tourney [-- жереб жереб ...]
   Ручки:   TOURNEY_TICKS=1200  TOURNEY_BASE=0 (без базовой линии)
            TOURNEY_PAIRS=1,3,5 (только эти составы)
            SPAR_DIALS='{"reach":26}' (ручки пресета)  */

import { readFileSync } from 'node:fs';
import { createEngine } from '@zoria/engine';
import { runPack, sampleBot } from '@zoria/sdk';
import { createNakazSparring, NAKAZ_SAMPLES } from '@zoria/sdk/nakaz';
import { DIALS, HarvestBot } from './dist/harvest.js';

const dials = { ...DIALS, ...JSON.parse(process.env.SPAR_DIALS || '{}') };
const TICKS = Number(process.env.TOURNEY_TICKS || 1200);
const WITH_BASE = process.env.TOURNEY_BASE !== '0';
const seedArg = process.argv.slice(2).map(Number).filter(Number.isFinite);
const SEEDS = seedArg.length ? seedArg : [7, 2026, 31337];

/* Соперник — зеркало архетипа, образец грамоты или наша собственная грамота.
   Грамота соперника присягает как бот, и доли считаются как обычно (06-local-pack, 3). */
const mirror = (name) => ({ label: name, make: () => sampleBot(createEngine, name) });
const charter = (name) => ({ label: 'грамота ' + name, make: () => createNakazSparring(NAKAZ_SAMPLES[name]) });
const ourCharter = () => {
  const bytes = readFileSync(new URL('./nakaz.yaml', import.meta.url));
  return { label: 'наш наказ', make: () => createNakazSparring(bytes) };
};

const PAIRS = [
  [mirror('обхідник'), mirror('рівний')], // состав локального пакета
  [mirror('шир'), mirror('облягач')],
  [mirror('проривник'), mirror('рівний')],
  [charter('черепаха'), charter('тиск')],
  [charter('замовлення'), mirror('обхідник')],
  [ourCharter(), mirror('шир')], // наша грамота как соперник: чего она стоит сама
];

const pick = process.env.TOURNEY_PAIRS
  ? process.env.TOURNEY_PAIRS.split(',')
      .map((n) => PAIRS[Number(n) - 1])
      .filter(Boolean)
  : PAIRS;

const heads = [];
const ourSeat = () => ({
  bot: () => {
    const b = new HarvestBot(dials);
    heads.push(b);
    return b;
  },
});

const play = (seed, seat, pair) =>
  runPack(createEngine, { seed, ticks: TICKS, cast: [seat, { bot: pair[0].make }, { bot: pair[1].make }] });

const pad = (s, n) => String(s).padEnd(n);
let ourTotal = 0;
let baseTotal = 0;
let packs = 0;
let worstSilence = 0;
const rows = [];

for (const pair of pick) {
  const name = pair[0].label + ' + ' + pair[1].label;
  let ours = 0;
  let base = 0;
  for (const seed of SEEDS) {
    heads.length = 0;
    const a = play(seed, ourSeat(), pair);
    ours += a.shares[0];
    for (const h of heads) worstSilence = Math.max(worstSilence, h.stat.silent);
    if (WITH_BASE) base += play(seed, { bot: () => sampleBot(createEngine, 'рівний') }, pair).shares[0];
    packs++;
    process.stderr.write('.');
  }
  ourTotal += ours;
  baseTotal += base;
  rows.push([name, ours, base]);
}
process.stderr.write('\n');

const maxShare = SEEDS.length * 9;
console.log('состав'.padEnd(34) + 'жатва'.padEnd(14) + (WITH_BASE ? 'базовая линия' : ''));
for (const [name, ours, base] of rows) {
  const mid = (ours / (SEEDS.length * 3)).toFixed(2);
  console.log(pad(name, 34) + pad(ours + '/' + maxShare + ' (' + mid + ')', 14) + (WITH_BASE ? base + '/' + maxShare : ''));
}
const matches = packs * 3;
console.log(
  '\nсредняя доля за партию: жатва ' +
    (ourTotal / matches).toFixed(2) +
    (WITH_BASE ? ', базовая линия ' + (baseTotal / matches).toFixed(2) : '') +
    '   (пакетов ' +
    packs +
    ', жеребов ' +
    SEEDS.length +
    ', составов ' +
    pick.length +
    ')',
);
console.log('самая длинная череда молчания: ' + worstSilence + ' тактов (наказ забирает слот на шестом, 23.2)');
