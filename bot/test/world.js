/* Общая обстановка проверок: один маніфест, одна долина, один оракул на весь
   прогон. Оракул держит свой экземпляр движителя, и поднимать его в каждом
   файле — секунды на пустом месте; `Valley` и маніфест неизменяемы, поэтому
   делиться ими безопасно.

   Соты названы здесь же: проверки ссылаются на них по имени, а не повторяют
   координаты, иначе смена жереба правит десяток мест. */

import { decodeManifest } from '@zoria/protocol';
import { RulesOracle } from '@zoria/sdk';
import { createEngine } from '@zoria/engine';
import { DIALS, HarvestBot } from '../dist/harvest.js';
import { Valley } from '../dist/valley.js';
import { manifestBytes } from './frames.js';

export { manifestBytes };
export const manifest = decodeManifest(manifestBytes);
export const valley = new Valley(manifest);
export const oracle = new RulesOracle(createEngine, manifestBytes);
export const cfg = manifest.cfg;
export const num = valley.num;

/** Вогнище вершины A и две её стартовые голки (правило 5.4). */
export const SEAT = { q: 6, r: -12 };
export const START = [
  { q: 5, r: -12 },
  { q: 7, r: -13 },
];
/** Ничья руина в трёх сотах от стартовой голки: внутри длины нити. */
export const RUIN = { q: 2, r: -9 };
/** Свободная сота рядом с нею — годный майданчик. */
export const SITE = { q: 3, r: -9 };
/** Стартовая голка вершины B: её не гріють и не глушат (7.6). */
export const START_B = { q: 7, r: 5 };
/** Первая голка кольца Ключника. */
export const RING = valley.cellOf(valley.ringKeys[0]);
export const NONE = new Set();

export const hexDist = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q - b.q + a.r - b.r)) / 2;

/* Образец головы: `init` строит свой `RulesOracle`, а это целый экземпляр
   движителя — 49 мс на голову, то есть почти весь прогон проверок уходил на
   сотню одинаковых движителей. Долина и оракул неизменяемы (оракул по своему
   контракту не проходит ни одного такта, SDK 4), поэтому их можно раздать
   всем головам из одного образца. Для мутационного прогона это решающее:
   Stryker гоняет весь набор на каждого мутанта. */
const PROTO = new HarvestBot(DIALS);
PROTO.init(manifestBytes, 'A');

function fresh(dials) {
  const b = new HarvestBot(dials ? { ...DIALS, ...dials } : DIALS);
  b.manifest = PROTO.manifest;
  b.slot = PROTO.slot;
  b.valley = PROTO.valley;
  b.oracle = PROTO.oracle;
  b.hearth = PROTO.hearth;
  b.seatFixed = PROTO.seatFixed;
  /* память о голках своя у каждой головы: её правят проверки */
  for (const [k, v] of PROTO.owner) b.owner.set(k, v);
  return b;
}

/** Голова на вершине A. `anchors` — её горящая сеть помимо вогнища. */
export function head(dials, anchors = START) {
  const b = fresh(dials);
  if (anchors !== null) b.anchors = [SEAT, ...anchors];
  b.t = 300;
  return b;
}

/** Голова без заданной сети: нить считает сама, как в партии. */
export function bareHead(dials) {
  return fresh(dials);
}
