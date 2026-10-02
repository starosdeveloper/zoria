/* Такт целиком: сколько команд уходит при данном канале, в каком порядке, и
   что голова делает с вердиктами. Это арифметика правил 13.2-13.7, и ошибка в
   ней не печатает ничего: машины просто стоят без рук.

   Плюс оценка майданчика (стройка, мост, пере-зажигание) — там мутируют
   границы и веса, а видно это только по тому, что бот строит не там. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { HarvestBot } from '../dist/harvest.js';
import { key } from '../dist/valley.js';
import { observe, task, unit } from './frames.js';
import { cfg, head, hexDist, NONE, oracle, SEAT, valley } from './world.js';

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

test('отчёт головы: знаменатель — команды, а не кадры (оценивание 8.5)', () => {
  /* Эту строку читает человек, а по ней считается метрика К3. Первая её версия
     делила на `run.stats.orders`, а это кадры — ровно 1200 за партию, по одному
     на такт; доля отказов выходила втрое меньше настоящей. */
  const b = head();
  b.stat.orders = 400;
  b.stat.nacks = 4;
  b.stat.silent = 3;
  b.denyBy.set('11:needle', 3);
  b.denyBy.set('22:bid', 1);
  const s = b.report();
  assert.match(s, /команд 400/);
  assert.match(s, /відмов 4/);
  assert.match(s, /1\.00%/, 'доля считается от команд: 4 из 400 это 1.00%, строка: ' + s);
  assert.match(s, /11:needle×3/, 'причины не названы: ' + s);
  assert.match(s, /22:bid×1/);
  assert.match(s, /молчание 3/);

  const clean = head();
  assert.match(clean.report(), /відмов 0 \(0\.00%\), причини нет/, 'пустой отчёт: ' + clean.report());
});

test('голова без маніфеста команд не подаёт', () => {
  const bare = new HarvestBot();
  assert.deepEqual(bare.think(observe({ t: 1 })), [], 'без init голова что-то подала');
});

test('отказ по каналу ничему не учит: сота не виновата (13.4)', () => {
  const b = head();
  const out = b.think(observe({ t: 300, pulse: { chanAt: 400, energy: 300 }, mine: { units: [unit('T-A1')] } }));
  const i = out.findIndex((o) => o.kind === 'move');
  assert.ok(i >= 0, 'хода нет: ' + JSON.stringify(out));
  b.seen([[i, false, 6]]); // канал
  assert.equal(b.plans.has('T-A1'), true, 'план снят из-за нехватки байтов');
  assert.equal(b.badGoal.size, 0, 'сота записана негодной из-за нехватки байтов');
  assert.equal(b.stat.nacks, 1, 'отказ не посчитан');
  assert.equal(b.denyBy.get('6:move'), 1, 'причина не названа по роду команды');
});

/** Четыре свободных Ткача: рой полон, верфь молчит, и весь бюджет уходит ходам. */
const fourIdle = () => ['T-A1', 'T-A2', 'T-A3', 'T-A4'].map((id) => unit(id));

test('бюджет команд: сколько влезает в канал, столько и уходит (13.5, 13.7)', () => {
  const moves = (chanAt) =>
    head()
      .think(observe({ t: 300, pulse: { chanAt, energy: 300 }, mine: { units: fourIdle() } }))
      .filter((o) => o.kind === 'move').length;
  /* руки свободные машины не берут (13.6а), поэтому канал весь на команды:
     при 64 байтах это две по 32, при 63 — одна, при 31 — ни одной */
  assert.equal(moves(64), 2, 'при двух полных командах ушло не два хода');
  assert.equal(moves(63), 1, 'байта не хватило на вторую, а ушли обе');
  assert.equal(moves(31), 0, 'команда ушла при пустом канале');
  assert.equal(moves(4000), 2, 'ручка cmds перестала держать потолок');
});

test('в кадре принятое и отказанное вместе: учится и то и другое', () => {
  const b = head();
  const out = b.think(observe({ t: 300, pulse: { chanAt: 400, energy: 300 }, mine: { units: fourIdle() } }));
  const moves = out.map((o, i) => [i, o]).filter(([, o]) => o.kind === 'move');
  assert.equal(moves.length, 2, 'двух ходов нет: ' + JSON.stringify(out));
  b.seen([
    [moves[0][0], true, 0],
    [moves[1][0], false, 11],
  ]);
  assert.equal(b.lastOk, b.t, 'принятая команда не сбросила счётчик молчания');
  assert.equal(b.stat.nacks, 1);
  assert.equal(b.badGoal.size, 1, 'отказанная цель не отложена');
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

test('корпус в очереди верфи занимает вес рою, хоть его и не видно (10.3, 26.2)', () => {
  /* Именно на этом погорел образец грамоты SDK: `build_drone` считает машины
     на поле, корпус в очереди в кадр не приходит, и он двадцать один раз
     заказывал машину в полный рой, получая `вага рою`. */
  const b = head();
  const at = (energy) => observe({ t: 10, pulse: { chanAt: 400, energy }, mine: { units: [unit('T-A1'), unit('T-A2'), unit('T-A3')] } });
  assert.deepEqual(b.yardOrder(at(900), valley), { kind: 'yard', cls: 'ткач' }, 'три машины, место есть — заказа нет');
  assert.equal(b.pending['ткач'], 1);
  assert.equal(
    b.yardOrder(at(900), valley),
    null,
    'второй заказ при трёх машинах и одном корпусе в очереди: это вес 8 из 8',
  );
  b.sync(observe({ t: 12, events: [{ type: 'build', p: 'A', cls: 'ткач' }] }), valley);
  assert.equal(b.pending['ткач'], 0, 'корпус вышел, а счётчик держит');
});

test('машины такта: свои и видимые чужие (10.7)', () => {
  const b = head();
  b.sync(
    observe({
      t: 300,
      mine: { units: [unit('T-A1', { q: 6, r: -12 })] },
      foe: [{ id: 'K-B3', p: 'B', cls: 'клинок', q: 2, r: -9 }],
    }),
    valley,
  );
  assert.equal(b.held('6,-12', 'T-A1'), false, 'своё же тело принято за помеху');
  assert.equal(b.held('6,-12', 'T-A2'), true, 'соту под своей машиной считаем свободной');
  assert.equal(b.held('2,-9'), true, 'чужая машина в кадре не учтена');
  assert.equal(b.held('0,0'), false);
  /* карта тел живёт один такт: машины ходят */
  b.sync(observe({ t: 301, mine: { units: [] } }), valley);
  assert.equal(b.held('2,-9'), false, 'тела прошлого такта остались в карте');
});

test('отказ верфи возвращает счётчик корпусов (10.3)', () => {
  const b = head();
  const out = b.think(observe({ t: 10, pulse: { chanAt: 141, energy: 300 }, mine: { units: [] } }));
  const i = out.findIndex((o) => o.kind === 'yard');
  assert.equal(b.pending['ткач'], 1);
  b.seen([[i, false, 10]]); // вес рою
  assert.equal(b.pending['ткач'], 0, 'корпуса нет, а счётчик держит — верфь замолчит до конца партии');
});

test('мусорный кадр не учит нулевую команду: вердикт один на кадр (6.3)', () => {
  const b = head();
  const free = unit('T-A1');
  const out = b.think(observe({ t: 300, pulse: { chanAt: 400, energy: 300 }, mine: { units: [free] } }));
  assert.ok(out.length, 'команд нет вовсе');
  const plan = b.plans.get('T-A1');
  assert.ok(plan, 'плана нет');

  b.seen([[0, false, 1]]); // сміття: один вердикт на весь кадр
  assert.equal(b.plans.has('T-A1'), true, 'мусорный кадр снял план невиновной машины');
  assert.equal(b.badGoal.size, 0, 'мусорный кадр записал соту негодной');
  assert.equal(b.badSite.size, 0);
  assert.equal(b.stat.garbage, 1, 'мусорный кадр не посчитан');
  assert.equal(b.denyBy.get('1:кадр'), 1, 'мусор записан как отказ команде, а он на кадр');
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

test('майданчик ищется в кольцах 3-5 от своей голки, не вплотную', () => {
  /* Вплотную к своей голке новая не нужна: её покрытие уже накрыто (8.3), и
     первое-второе кольцо дало бы прирост почти нулевой. Дальше пятого нить
     не дотянется (linkRange 5). Проверка держит форму поиска: при сдвиге
     радиусов план уедет либо в упор, либо за нить. */
  const b = head({ buildGate: 0 });
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    const plan = b.sitePlan(observe({ t: 300, pulse: { energy: 300 } }), valley, oracle, SEAT, seen, false);
    if (!plan) break;
    seen.add(plan.key);
    const near = Math.min(...b.anchors.map((a) => hexDist(a, plan.at)));
    assert.ok(near >= 3, 'майданчик вплотную к своей голке: ' + plan.key + ', до сети ' + near);
    assert.ok(near <= valley.num.linkRange, 'майданчик за длиной нити: ' + plan.key + ', до сети ' + near);
  }
  assert.ok(seen.size > 0, 'ни одного майданчика не нашлось');
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
