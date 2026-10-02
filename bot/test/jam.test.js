/* Завада Клинком: последовательность «подойти на одну соту — глушить с
   удержанием» и три случая, когда глушить нельзя (правила 11.1, 11.3, 7.6).
   Ошибка здесь тихая: команда `jam` по своей, ничьей или стартовой голке
   принимается, байты списываются, а завады нет. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { HarvestBot, DIALS } from '../dist/harvest.js';
import { manifestBytes, observe, unit } from './frames.js';
import { SEAT, valley } from './world.js';

/* руина в 3 сотах от стартовой голки вершины A — внутри длины нити (5) */
const FOE = { q: 2, r: -9 };
const dist = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q - b.q + a.r - b.r)) / 2;

const head = () => {
  const b = new HarvestBot({ ...DIALS, klinoks: 1, jamChan: 0 });
  b.init(manifestBytes, 'A');
  return b;
};

const withKlinok = (at, own) =>
  observe({
    t: 300,
    pulse: { chanAt: 400, energy: 300 },
    mine: { units: [unit('K-A1', { cls: 'клинок', q: at.q, r: at.r })] },
    own: own,
  });

test('Клинок идёт к чужой горящей голке, но не на неё', () => {
  const out = head().think(withKlinok({ q: 6, r: -12 }, [{ ...FOE, owner: 'B', dark: false }]));
  const move = out.find((o) => o.kind === 'move' && o.unit === 'K-A1');
  assert.ok(move, 'команды хода нет: ' + JSON.stringify(out));
  assert.notDeepEqual({ q: move.q, r: move.r }, FOE, 'цель хода — сама голка');
  assert.equal(dist({ q: move.q, r: move.r }, FOE), 1, 'ход не на соседнюю соту');
  assert.equal(move.home, true, 'без home повідець развернёт Клинка (10.9)');
});

test('с соседней соты — jam с удержанием', () => {
  const out = head().think(withKlinok({ q: 2, r: -8 }, [{ ...FOE, owner: 'B', dark: false }]));
  const jam = out.find((o) => o.kind === 'jam');
  assert.ok(jam, 'завады нет: ' + JSON.stringify(out));
  assert.deepEqual(jam.target, FOE);
  assert.equal(jam.hold, true);
  assert.equal(jam.unit, 'K-A1');
});

test('мовчазну чужую голку не глушат: здобичи с неё нет (8.7)', () => {
  const out = head().think(withKlinok({ q: 2, r: -8 }, [{ ...FOE, owner: 'B', dark: true }]));
  assert.equal(
    out.some((o) => o.kind === 'jam'),
    false,
  );
});

test('ничью руину и свою голку не глушат: правило 11.3', () => {
  const neutral = head().think(withKlinok({ q: 2, r: -8 }, []));
  assert.equal(
    neutral.some((o) => o.kind === 'jam'),
    false,
    'глушит ничью руину',
  );
  const mine = head().think(withKlinok({ q: 2, r: -8 }, [{ ...FOE, owner: 'A', dark: false }]));
  assert.equal(
    mine.some((o) => o.kind === 'jam'),
    false,
    'глушит свою голку',
  );
});

test('сота без голки целью завады не бывает', () => {
  /* Владение в памяти головы живёт по сотам голок, но запись может попасть
     туда и про соту без голки. Глушить там нечего: команда вернулась бы
     отказом, а Клинок простоял бы дорогу зря. */
  const b = head();
  b.anchors = [SEAT, { q: 5, r: -12 }];
  b.t = 300;
  const empty = { q: 3, r: -9 }; // свободная сота рядом с руиной
  b.owner.set(empty.q + ',' + empty.r, 'B');
  b.dark.set(empty.q + ',' + empty.r, false);
  const plan = b.jamPlan(observe({ t: 300 }), valley, SEAT, new Set());
  assert.equal(
    plan !== null && plan.at.q === empty.q && plan.at.r === empty.r,
    false,
    'цель завады — сота без голки: ' + JSON.stringify(plan),
  );
});

test('стартовую голку соперника не глушат: она под щитом (7.6)', () => {
  const start = { q: 7, r: 5 }; // стартовая голка вершины B
  const out = head().think(
    observe({
      t: 300,
      pulse: { chanAt: 400, energy: 300 },
      mine: { units: [unit('K-A1', { cls: 'клинок', q: 7, r: 4 })] },
      own: [{ ...start, owner: 'B', dark: false }],
    }),
  );
  assert.equal(
    out.some((o) => o.kind === 'jam'),
    false,
  );
});

test('верфь: желание, которое не влезает в рой, не блокирует другое', () => {
  /* рой полон четырьмя Ткачами (вес 8 из 8) — заказывать нечего */
  const full = new HarvestBot({ ...DIALS, klinoks: 1, jamChan: 0 });
  full.init(manifestBytes, 'A');
  const four = ['T-A1', 'T-A2', 'T-A3', 'T-A4'].map((id) => unit(id));
  assert.equal(
    full.think(observe({ t: 50, pulse: { chanAt: 400, energy: 300 }, mine: { units: four } })).some((o) => o.kind === 'yard'),
    false,
    'заказ при полном рое',
  );

  /* три Ткача: Клинок весит 1 и влезает — он и предпочтителен */
  const room = new HarvestBot({ ...DIALS, klinoks: 1, jamChan: 0 });
  room.init(manifestBytes, 'A');
  const three = ['T-A1', 'T-A2', 'T-A3'].map((id) => unit(id));
  const out = room.think(observe({ t: 50, pulse: { chanAt: 400, energy: 300 }, mine: { units: three } }));
  assert.deepEqual(
    out.filter((o) => o.kind === 'yard'),
    [{ kind: 'yard', cls: 'клинок' }],
  );

  /* канал не дорос до jamChan: Клинок не нужен, но Ткач — да */
  const thin = new HarvestBot({ ...DIALS, klinoks: 1, jamChan: 10000 });
  thin.init(manifestBytes, 'A');
  const two = ['T-A1', 'T-A2'].map((id) => unit(id));
  assert.deepEqual(
    thin.think(observe({ t: 50, pulse: { chanAt: 400, energy: 300 }, mine: { units: two } })).filter((o) => o.kind === 'yard'),
    [{ kind: 'yard', cls: 'ткач' }],
  );
});

test('без ручки klinoks верфь Клинка не заказывает', () => {
  const plain = new HarvestBot();
  plain.init(manifestBytes, 'A');
  const out = plain.think(observe({ pulse: { chanAt: 400, energy: 300 } }));
  assert.deepEqual(
    out.filter((o) => o.kind === 'yard'),
    [{ kind: 'yard', cls: 'ткач' }],
  );
});
