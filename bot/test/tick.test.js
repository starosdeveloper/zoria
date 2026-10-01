/* Такт целиком: сколько команд уходит при данном канале, в каком порядке, и
   что голова делает с вердиктами. Это арифметика правил 13.2-13.7, и ошибка в
   ней не печатает ничего: машины просто стоят без рук.

   Плюс оценка майданчика (стройка, мост, пере-зажигание) — там мутируют
   границы и веса, а видно это только по тому, что бот строит не там. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { key } from '../dist/valley.js';
import { observe, task, unit } from './frames.js';
import { cfg, head, NONE, oracle, SEAT, valley } from './world.js';

const busyUnits = (n) =>
  Array.from({ length: n }, (_, i) => unit('T-A' + (i + 1), { q: 4, r: -10, task: task({ goal: { q: 3, r: -9 }, path: 3 }) }));

test('команд в такт не больше ручки cmds, сколько бы канала ни было', () => {
  const b = head({ cmds: 2 });
  const out = b.think(observe({ t: 300, pulse: { chanAt: 4000, energy: 400 }, mine: { units: [unit('T-A1'), unit('T-A2'), unit('T-A3')] } }));
  assert.ok(out.length <= 2 + 1, 'команд ' + out.length + ': ' + JSON.stringify(out));
});

test('руки считаются раньше команд: 141 байт и четыре машины — команд нет (13.3, 13.7)', () => {
  const b = head();
  const out = b.think(observe({ t: 300, pulse: { chanAt: 141 }, mine: { units: busyUnits(4) } }));
  assert.ok(out.length <= 1, JSON.stringify(out));
  if (out.length) assert.ok(out[0].kind === 'halt' || out[0].kind === 'watch', 'платная команда при расписанном канале');
});

test('удержание завады тоже съедает канал (11.1)', () => {
  const wide = head().think(observe({ t: 300, pulse: { chanAt: 200 }, mine: { units: busyUnits(4) } }));
  const jammed = head().think(
    observe({
      t: 300,
      pulse: { chanAt: 200 },
      mine: { units: busyUnits(4), jams: Array.from({ length: 8 }, () => ({ q: 2, r: -9, until: 320 })) },
    }),
  );
  assert.ok(jammed.filter((o) => o.kind !== 'halt' && o.kind !== 'watch').length <= wide.filter((o) => o.kind !== 'halt' && o.kind !== 'watch').length);
});

test('верфь идёт первой: она однократна, а машины подождут такт', () => {
  const b = head();
  const out = b.think(observe({ t: 10, pulse: { chanAt: 141, energy: cfg['costTkach'] }, mine: { units: [] } }));
  assert.equal(out[0].kind, 'yard');
});

test('слот держится, пока вузол принимает хоть что-то (23.2)', () => {
  /* вузол отвечает вердиктом на каждый непустой кадр — без этого счётчик
     молчания головы мерит не молчание, а время с начала партии */
  const play = (verdict) => {
    const b = head({ quiet: 3 });
    let gap = 0;
    let worst = 0;
    for (let t = 300; t < 340; t++) {
      const out = b.think(observe({ t, pulse: { chanAt: 141 }, mine: { units: busyUnits(4) } }));
      gap = out.length ? 0 : gap + 1;
      worst = Math.max(worst, gap);
      if (out.length) b.seen(out.map((_, i) => [i, verdict, verdict ? 0 : 6]));
    }
    return { worst, silent: b.stat.silent };
  };

  const ok = play(true);
  assert.ok(ok.worst < 6, 'пустых кадров подряд ' + ok.worst);
  assert.ok(ok.silent < 6, 'счётчик молчания ' + ok.silent);

  /* если вузол отказывает всем командам, такт всё равно молчание: голова
     обязана продолжать подавать кадры, а не смириться */
  const denied = play(false);
  assert.ok(denied.worst < 6, 'при сплошных отказах голова замолчала на ' + denied.worst + ' тактов');
});

test('вердикты: принятая команда держит слот, отказ по земле снимает план (12.2)', () => {
  const b = head();
  const free = unit('T-A1');
  const out = b.think(observe({ t: 300, pulse: { chanAt: 400, energy: 300 }, mine: { units: [free] } }));
  const move = out.findIndex((o) => o.kind === 'move');
  assert.ok(move >= 0, 'ход не подан: ' + JSON.stringify(out));
  const plan = b.plans.get('T-A1');
  assert.ok(plan, 'плана нет');

  b.seen([[move, false, 11]]);
  assert.equal(b.plans.has('T-A1'), false, 'план по отказанной земле остался');
  assert.equal(b.badGoal.has(plan.key), true, 'цель не отложена');
  assert.equal(b.stat.nacks, 1);

  b.seen([[move, true, 0]]);
  assert.equal(b.lastOk, b.t, 'принятая команда не сбросила счётчик молчания');
});

test('отказ верфи возвращает счётчик корпусов (10.3)', () => {
  const b = head();
  const out = b.think(observe({ t: 10, pulse: { chanAt: 141, energy: 300 }, mine: { units: [] } }));
  const i = out.findIndex((o) => o.kind === 'yard');
  assert.equal(b.pending['ткач'], 1);
  b.seen([[i, false, 10]]); // вес рою
  assert.equal(b.pending['ткач'], 0, 'корпуса нет, а счётчик держит — верфь замолчит до конца партии');
});

test('кривые байты вердикта голову не роняют', () => {
  const b = head();
  b.feedback(new Uint8Array([0xff, 0xff]));
  assert.ok(b.think(observe({ t: 301 })), 'после мусорного вердикта такт не отработал');
});

test('оценка майданчика: прирост покрытия считается по цене земли (8.3)', () => {
  const b = head();
  const far = { q: 12, r: -14 };
  const near = { q: 6, r: -11 };
  assert.ok(b.growth(far, valley) > 0, 'пустая окрестность ничего не стоит');
  assert.ok(b.growth(far, valley) > b.growth(near, valley), 'сота у своих же голок оценена не ниже далёкой');
});

test('мост считает только те руины, которые без него вне нити (7.2)', () => {
  const b = head();
  const site = { q: 10, r: -12 };
  const n = b.bridge(site, valley, oracle);
  assert.ok(n >= 0);
  /* если нить уже достаёт до руины, мост её не приносит */
  const covered = head();
  covered.anchors = [SEAT, ...valley.ruins.slice(0, 20).map((k) => valley.cellOf(k))];
  assert.equal(covered.bridge(site, valley, oracle), 0, 'мост посчитал руины, до которых нить и так дошла');
});

test('пере-зажигание считает свои погасшие голки в пределах нити (7.4)', () => {
  const b = head();
  const cut = [{ q: 10, r: -12 }];
  assert.equal(b.relight({ q: 10, r: -13 }, cut, oracle), 1);
  assert.equal(b.relight({ q: -12, r: 6 }, cut, oracle), 0, 'посчитал голку за пределами нити');
  assert.equal(b.relight({ q: 10, r: -13 }, [], oracle), 0);
});

test('стройка: порог buildGate и запас заряда под цену голки (12.3)', () => {
  const rich = head({ buildGate: 0 });
  assert.ok(rich.sitePlan(observe({ t: 300, pulse: { energy: 300 } }), valley, oracle, SEAT, NONE, false), 'при нулевом пороге площадки нет');

  const picky = head({ buildGate: 100000 });
  assert.equal(picky.sitePlan(observe({ t: 300, pulse: { energy: 300 } }), valley, oracle, SEAT, NONE, false), null, 'порог не держит');

  const poor = head({ buildGate: 0 });
  assert.equal(
    poor.sitePlan(observe({ t: 300, pulse: { energy: cfg['costNeedle'] - 1 } }), valley, oracle, SEAT, NONE, false),
    null,
    'строим без заряда на голку',
  );

  const late = head({ buildGate: 0 });
  assert.equal(
    late.sitePlan(observe({ t: valley.dawnAt, pulse: { energy: 300 } }), valley, oracle, SEAT, NONE, false),
    null,
    'стройка после зори: голка не успеет окупиться',
  );
});

test('пере-зажигание требует своих погасших голок, иначе плана нет', () => {
  const b = head({ buildGate: 0 });
  assert.equal(b.relightPlan(observe({ t: 300, pulse: { energy: 300 } }), valley, oracle, SEAT, NONE), null, 'гасших голок нет, а мост строим');
  const cut = observe({ t: 300, pulse: { energy: 300 }, mine: { needles: [{ q: 10, r: -12, dark: true, fed: false, weight: 1 }] } });
  assert.ok(b.relightPlan(cut, valley, oracle, SEAT, NONE), 'погасшая голка есть, а моста нет');
});

test('подход к цели: соседняя свободная сота, ближайшая к машине', () => {
  const b = head();
  const at = { q: 2, r: -9 };
  const from = unit('K-A1', { cls: 'клинок', q: 6, r: -12 });
  const step = b.approach(at, from);
  assert.ok(step, 'соседней соты не нашлось');
  const d = (a, c) => (Math.abs(a.q - c.q) + Math.abs(a.r - c.r) + Math.abs(a.q - c.q + a.r - c.r)) / 2;
  assert.equal(d(step, at), 1);
  assert.equal(valley.needles.has(key(step.q, step.r)), false, 'подход на соту с голкой');
  /* сота выбирается ближайшая к машине, а не первая по кругу: с другой стороны
     цели выбор обязан стать другим */
  const alt = b.approach(at, unit('K-A2', { cls: 'клинок', q: -2, r: -5 }));
  assert.equal(d(alt, at), 1);
  assert.ok(alt.q !== step.q || alt.r !== step.r, 'подход не зависит от того, откуда идёт машина');
  assert.equal(b.approach({ q: 30, r: 0 }, from), null, 'за краем долины подходить некуда');
});

test('счётчик молчания считается с такта присяги, а не с нуля (04-protocol, 8)', () => {
  /* голова, вернувшаяся после обрыва, входит в партию на 600-м такте и ещё
     ничего не подавала: 600 тактов молчания были бы неправдой про слот */
  const b = head({ quiet: 3 });
  b.think(observe({ t: 600, pulse: { chanAt: 141 }, mine: { units: busyUnits(4) } }));
  assert.ok(b.stat.silent <= 1, 'счётчик молчания сразу после присяги: ' + b.stat.silent);
});
