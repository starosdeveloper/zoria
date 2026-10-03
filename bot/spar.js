/* Спарринг вне провода: тот же движитель, те же соперники, что у локального
   пакета, но три партии играются в одном процессе без сокетов и дедлайнов
   (SDK 7). Это второй прибор: локальный пакет мерит бота вместе с проводом и
   тактом 500 мс, а здесь видно только решения головы.
   Базовая линия — зеркало архетипа «рівний» на нашем месте: столько берёт
   слот, если стратегии в нём нет вообще.
   Запуск: npm run spar [-- сеяние сеяние ...]  */

import { createEngine } from '@zoria/engine';
import { decodeObserve } from '@zoria/protocol';
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

/* SPAR_TIME=1: куда уходят машино-такты Ткачей на нашем месте — у любой головы,
   своей или зеркала, по её же кадрам наблюдения. Голова зеркала изнутри не
   видна, а кадр у всех один, поэтому сравнение «жатвы» с «рівним» честное.
   Ткач без задания на чужой или ничьей голке греет её (13.6) — это работа,
   а не простой. */
const TIME = Boolean(process.env.SPAR_TIME);
const MARKS = [300, 600, 900];
const clocks = [];
const tally = (c, o) => {
  const needleAt = new Map(o.own.map((n) => [n.q + ',' + n.r, n.owner]));
  for (const u of o.mine.units) {
    if (u.cls !== 'ткач') {
      c.klinok++;
      continue;
    }
    c.tkach++;
    const t = u.task;
    const here = needleAt.get(u.q + ',' + u.r);
    if (!t) {
      if (here !== undefined && here !== c.slot) c.heat++;
      else c.idle++;
    } else if (t.path > 0) c.walk++;
    else if (t.site) c.build++;
    else if (t.feed) c.feed++;
    else if (here !== undefined && here !== c.slot) c.heat++;
    else c.other++;
  }
  const lit = o.mine.needles.filter((n) => !n.dark).length;
  const at = o.t + ':' + o.mine.needles.length + '/' + lit + ' з' + Math.round(o.pulse.energy);
  if (MARKS.includes(o.t)) c.curve.push(at);
  c.last = at;
};
const clocked = (make) => () => {
  const inner = make();
  const c = { slot: '', tkach: 0, idle: 0, walk: 0, build: 0, heat: 0, feed: 0, other: 0, klinok: 0, curve: [], last: '' };
  clocks.push(c);
  return {
    init: (m, slot) => {
      c.slot = slot;
      inner.init(m, slot);
    },
    tick: (bytes) => {
      const o = decodeObserve(bytes);
      if (o) tally(c, o);
      return inner.tick(bytes);
    },
    feedback: (v) => inner.feedback?.(v),
  };
};
const timed = (make) => (TIME ? clocked(make) : make);
const pct = (n, of) => (of ? ((100 * n) / of).toFixed(0) + '%' : '-');
const showClocks = (list) => {
  if (!TIME) return;
  for (const [i, c] of list.entries()) {
    console.log(
      '      ткачі ' + (i + 1) + ': простій ' + pct(c.idle, c.tkach) + ', дорога ' + pct(c.walk, c.tkach) + ', будова ' + pct(c.build, c.tkach) +
        ', гріє ' + pct(c.heat, c.tkach) + ', живить ' + pct(c.feed, c.tkach) + ', інше ' + pct(c.other, c.tkach) +
        ' (ткач-тактів ' + c.tkach + ', клинок-тактів ' + c.klinok + ')   голок/горить/заряд: ' + [...c.curve, c.last].join('  '),
    );
  }
};

/* планы наших четырёх Ткачей за пакет: куда ушло рабочее время головы */
const heads = [];
const ourSeat = () => ({
  bot: timed(() => {
    const b = new HarvestBot(dials);
    heads.push(b);
    return b;
  }),
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
  const clocksA = clocks.splice(0);
  const b = pack(seed, { bot: timed(() => sampleBot(createEngine, 'рівний')) });
  const clocksB = clocks.splice(0);
  ours += a.shares[0];
  base += b.shares[0];
  console.log('жереб ' + seed + ':');
  row('жатва', seed, a);
  showClocks(clocksA);
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
  showClocks(clocksB);
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
