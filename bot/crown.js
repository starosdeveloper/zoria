/* Вінець вторым прибором.
   Сравнение долей на вінець не отвечает: +1 доля из 324 при разбросе в
   несколько долей на пакет — это шум, а не эффект. Но вінець — механизм с
   проверяемым условием: простой цикл не короче 6 горящих голок, где соседние
   дотягиваются друг до друга (8.6). Значит можно спросить не «стало ли
   лучше», а «был ли цикл вообще».

   Считается по миру движителя в конце партии: горящие голки нашего слота —
   вершины, связь по linkOk — рёбра. Цикломатическое число E - V + C > 0
   говорит, что цикл есть; обхват (girth) — какой он длины. Цикл короче 6
   вінця не даёт.

   Запуск: node crown.js [жереб ...]   Ручки: SPAR_DIALS  */

import { createEngine } from '@zoria/engine';
import { runMatch } from '@zoria/sdk';
import { DIALS, HarvestBot } from './dist/harvest.js';

const dials = { ...DIALS, ...JSON.parse(process.env.SPAR_DIALS || '{}') };
const TICKS = Number(process.env.CROWN_TICKS || 1200);
const seedArg = process.argv.slice(2).map(Number).filter(Number.isFinite);
const SEEDS = seedArg.length ? seedArg : [7, 2026, 31337];

/** Горящие голки слота и связи между ними по правилу нити. */
function net(E, slot) {
  const lit = Object.keys(E.litNeedles(slot, E.SIM.world));
  const cell = (k) => {
    const n = E.NEEDLE_BY_KEY[k];
    return n ? { q: n.q, r: n.r } : null;
  };
  const nodes = lit.filter((k) => cell(k));
  const edges = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = cell(nodes[i]);
      const b = cell(nodes[j]);
      if (E.linkOk(a.q, a.r, b.q, b.r)) edges.push([i, j]);
    }
  }
  return { nodes, edges };
}

/** Связные компоненты и цикломатическое число E - V + C. */
function rank({ nodes, edges }) {
  const parent = nodes.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const [a, b] of edges) parent[find(a)] = find(b);
  const comps = new Set(nodes.map((_, i) => find(i))).size;
  return { v: nodes.length, e: edges.length, c: comps, rank: edges.length - nodes.length + comps };
}

/** Обхват: длина самого короткого цикла, BFS из каждой вершины. */
function girth({ nodes, edges }) {
  const adj = nodes.map(() => []);
  for (const [a, b] of edges) {
    adj[a].push(b);
    adj[b].push(a);
  }
  let best = Infinity;
  for (let s = 0; s < nodes.length; s++) {
    const dist = new Array(nodes.length).fill(-1);
    const from = new Array(nodes.length).fill(-1);
    dist[s] = 0;
    const q = [s];
    for (let head = 0; head < q.length; head++) {
      const u = q[head];
      for (const w of adj[u]) {
        if (dist[w] === -1) {
          dist[w] = dist[u] + 1;
          from[w] = u;
          q.push(w);
        } else if (w !== from[u]) {
          best = Math.min(best, dist[u] + dist[w] + 1);
        }
      }
    }
  }
  return best === Infinity ? 0 : best;
}

/** Есть ли простой цикл длины не меньше `min` — то самое условие вінця (8.6).
    Поиск в глубину с ограничением: вершин здесь десятки, не тысячи. */
function cycleAtLeast({ nodes, edges }, min) {
  const adj = nodes.map(() => []);
  for (const [a, b] of edges) {
    adj[a].push(b);
    adj[b].push(a);
  }
  const seen = new Array(nodes.length).fill(false);
  let found = 0;
  for (let s = 0; s < nodes.length && !found; s++) {
    const path = [s];
    const onPath = new Array(nodes.length).fill(false);
    onPath[s] = true;
    const walk = (u, depth) => {
      if (found) return;
      for (const w of adj[u]) {
        if (found) return;
        if (w === s && depth >= min) {
          found = depth;
          return;
        }
        if (onPath[w] || depth >= min + 4) continue;
        onPath[w] = true;
        path.push(w);
        walk(w, depth + 1);
        path.pop();
        onPath[w] = false;
      }
    };
    walk(s, 1);
    seen[s] = true;
  }
  return found;
}

console.log('жереб   голок  рёбер  компонент  циклов  обхват  цикл>=6  рахунок');
for (const seed of SEEDS) {
  const m = runMatch(createEngine, { seed, ticks: TICKS, bots: { A: new HarvestBot(dials) } });
  const g = net(m.engine, 'A');
  const r = rank(g);
  console.log(
    String(seed).padEnd(8) +
      String(r.v).padEnd(7) +
      String(r.e).padEnd(7) +
      String(r.c).padEnd(11) +
      String(r.rank).padEnd(8) +
      String(girth(g)).padEnd(8) +
      String(cycleAtLeast(g, 6) || 'нет').padEnd(9) +
      m.score['A'].toFixed(1),
  );
}
console.log('\nвінець требует цикла не короче ' + 6 + ' голок (8.6): обхват 0 — циклов нет вовсе, обхват 3-5 — есть, но вінця не дают');
