/* Спарринг вне провода: тот же движитель, те же соперники, что у локального
   пакета, но три партии играются в одном процессе без сокетов и дедлайнов
   (SDK 7). Это второй прибор: локальный пакет мерит бота вместе с проводом и
   тактом 500 мс, а здесь видно только решения головы.
   Базовая линия — зеркало архетипа «рівний» на нашем месте: столько берёт
   слот, если стратегии в нём нет вообще.
   Запуск: npm run spar [-- сеяние сеяние ...]  */

import { createEngine } from '@zoria/engine';
import { ARCHETYPES, runPack, sampleBot } from '@zoria/sdk';
import { DIALS, HarvestBot } from './dist/harvest.js';

/* ручки пресета можно переопределить на один прогон: SPAR_DIALS='{"reach":26}' */
const dials = { ...DIALS, ...JSON.parse(process.env.SPAR_DIALS || '{}') };

const seeds = process.argv.slice(2).map(Number).filter(Number.isFinite);
const SEEDS = seeds.length ? seeds : [2026, 7, 31337];
const TICKS = Number(process.env.SPAR_TICKS || 1200);

/* соперники по умолчанию — как у локального пакета; SPAR_RIVALS='проривник,рівний'
   ставит зеркала архетипов, чтобы разобрать один состав турнира с SPAR_WHY */
const RIVALS = (process.env.SPAR_RIVALS || '').split(',').filter(Boolean);
const rivals = () =>
  RIVALS.length
    ? RIVALS.map((name) => ({ bot: () => sampleBot(createEngine, name) }))
    : [{ bot: () => sampleBot(createEngine, 'обхідник') }, { style: { ...ARCHETYPES['рівний'] } }];

const pack = (seed, seat) => runPack(createEngine, { seed, ticks: TICKS, cast: [seat, ...rivals()] });

/* планы наших четырёх Ткачей за пакет: куда ушло рабочее время головы */
const heads = [];
const ourSeat = () => ({
  bot: () => {
    const b = new HarvestBot(dials);
    heads.push(b);
    return b;
  },
});

const SEATS = ['A', 'B', 'C'];

const row = (label, seed, p) => {
  const mine = p.matches.map((m, i) => m.score[SEATS[i]].toFixed(1));
  console.log(
    '  ' + label.padEnd(8) + 'жереб ' + String(seed).padEnd(6) + 'частки ' + p.shares.join('/') + '   рахунок ' + mine.join(', '),
  );
  if (!process.env.SPAR_WHY) return;
  /* откуда рахунок: сеть, замовлення, здобич, и что осталось неистраченным */
  p.matches.forEach((m, i) => {
    const s = SEATS[i];
    const b = m.breakdown[s];
    console.log(
      '      партія ' +
        (i + 1) +
        ' (' +
        s +
        '): мережа ' +
        b.network.toFixed(1) +
        ', замовлення ' +
        b.orders +
        ', здобич ' +
        (b.stolen ?? 0).toFixed(1) +
        ', голок ' +
        m.needles[s] +
        ' (горить ' +
        m.lit[s] +
        '), заряд ' +
        m.energy[s].toFixed(0) +
        ', сміття ' +
        m.garbage[s] +
        '/' +
        m.oversize[s],
    );
  });
};

let ours = 0;
let base = 0;
for (const seed of SEEDS) {
  heads.length = 0;
  const a = pack(seed, ourSeat());
  const b = pack(seed, { bot: () => sampleBot(createEngine, 'рівний') });
  ours += a.shares[0];
  base += b.shares[0];
  console.log('жереб ' + seed + ':');
  row('жатва', seed, a);
  if (process.env.SPAR_WHY) {
    const WORD = ['', 'сміття', 'стеля', 'машина', 'поворот', 'тариф', 'канал', 'вуха', 'верф', 'заряд', 'вага рою', 'земля', 'немає шляху', 'не своя голка', 'спалах', 'погляд', 'таран', 'ціль', 'глушіння', 'угода', 'клич', 'відмова', 'торги'];
    heads.forEach((h, i) => {
      console.log('      плани ' + (i + 1) + ': ' + Object.entries(h.stat).map(([k, n]) => k + ' ' + n).join(', '));
      /* доля отказов — метрика K3 (оценивание 8.5): 0 отказов 2 балла, до 0.5 % — 1 */
      const share = h.stat.orders ? ((h.stat.nacks / h.stat.orders) * 100).toFixed(2) : '0.00';
      const why = [...h.denyBy].map(([c, n]) => (WORD[c] || c) + ' ' + n).join(', ') || 'нет';
      console.log('      отказов ' + h.stat.nacks + ' из ' + h.stat.orders + ' = ' + share + '%   причины: ' + why);
    });
  }
  row('рівний', seed, b);
}
const changed = Object.entries(dials).filter(([k, v]) => DIALS[k] !== v);
console.log(
  '\nсумма долей за ' +
    SEEDS.length +
    ' пакетов: жатва ' +
    ours +
    ', базовая линия (рівний) ' +
    base +
    ' из ' +
    SEEDS.length * 9 +
    (changed.length ? '   ручки: ' + changed.map(([k, v]) => k + '=' + v).join(' ') : ''),
);
