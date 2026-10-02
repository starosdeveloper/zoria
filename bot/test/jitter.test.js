/* Повтор первого входа: закон отката и список того, что вообще стоит повторять.
   Проверки держат обе половины, потому что ошибка в любой тихая — бот либо
   ломится в ещё закрытое лобі всем стадом, либо повторяет вердикт вузла,
   который повтором не лечится.

   Случайность и сон подставляются снаружи (`rnd`, `sleep`), так что времени
   прогон не занимает вовсе. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { backoffMs, retryable, withJitter } from '../dist/jitter.js';

test('откат: равномерно от нуля до потолка, вдвое за попытку (04-protocol, 8)', () => {
  const ceil = 2000;
  const base = Math.round(ceil / 3); // 667
  /* рівномірно **від нуля**: нижняя граница это 0, а не база — иначе стадо не
     разводится, а сдвигается целиком */
  assert.equal(backoffMs(0, ceil, () => 0), 0);
  assert.equal(backoffMs(5, ceil, () => 0), 0);

  const almost = () => 0.999999;
  assert.equal(backoffMs(0, ceil, almost), base - 1, 'первая пауза шире базы');
  assert.equal(backoffMs(1, ceil, almost), base * 2 - 1, 'вторая пауза не вдвое');
  assert.equal(backoffMs(2, ceil, almost), ceil - 1, 'потолок не держит');
  assert.equal(backoffMs(9, ceil, almost), ceil - 1, 'потолок не держит на дальних попытках');

  /* потолок меньше трёх миллисекунд: база не должна стать нулём */
  assert.equal(backoffMs(0, 1, almost), 0);
  assert.ok(backoffMs(3, 1, almost) >= 0);
});

test('повторять стоит только сеть: вердикт вузла повтором не лечится', () => {
  assert.equal(retryable(new Error('wire did not come up in 5000 ms')), true);
  assert.equal(retryable(new Error('wire closed before the oath, code 1006')), true, 'код транспорта');
  assert.equal(retryable(new Error('wire closed before the oath, code 3999')), true, 'граница снизу');
  assert.equal(retryable(new Error('wire closed before the oath, code 4000')), false, 'сам порог — уже вердикт');
  assert.equal(retryable(new Error('wire closed before the oath, code 4001')), false, 'несовместимость');
  assert.equal(retryable(new Error('engine hash mismatch')), false, 'чужой рушій повтором не лечится');
  assert.equal(retryable('не ошибка вовсе'), false);
  assert.equal(retryable(new Error('closed before the oath, code 1006')), false, 'сообщение не с начала');
});

test('повтор: первая попытка сразу, пауза только между попытками', async () => {
  const slept = [];
  const seen = [];
  let calls = 0;
  const run = await withJitter(
    {
      tries: 5,
      ceilMs: 2000,
      rnd: () => 0.5,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
      onRetry: (n, ms, e) => seen.push([n, ms, e.message]),
    },
    () => {
      calls++;
      if (calls < 3) return Promise.reject(new Error('wire did not come up in 5000 ms'));
      return Promise.resolve('присягнул');
    },
  );
  assert.equal(run, 'присягнул');
  assert.equal(calls, 3, 'попыток не три');
  assert.equal(slept.length, 2, 'пауз не две: ' + JSON.stringify(slept));
  assert.deepEqual(
    seen.map(([n]) => n),
    [1, 2],
    'номера попыток в оповещении',
  );
  assert.ok(slept[1] > slept[0], 'вторая пауза не длиннее первой: ' + JSON.stringify(slept));
});

test('успех с первого раза: ни паузы, ни оповещения', async () => {
  let slept = 0;
  let told = 0;
  const run = await withJitter(
    { tries: 5, ceilMs: 10, sleep: () => ((slept += 1), Promise.resolve()), onRetry: () => (told += 1) },
    () => Promise.resolve(7),
  );
  assert.equal(run, 7);
  assert.equal(slept, 0);
  assert.equal(told, 0);
});

test('попытки кончились — отдаётся последняя ошибка, а не предыдущая', async () => {
  let calls = 0;
  await assert.rejects(
    withJitter({ tries: 3, ceilMs: 10, sleep: () => Promise.resolve() }, () => {
      calls++;
      return Promise.reject(new Error('wire did not come up in ' + calls));
    }),
    /wire did not come up in 3/,
  );
  assert.equal(calls, 3, 'попыток не три: ' + calls);
});

test('ошибка не для повтора отдаётся сразу', async () => {
  let calls = 0;
  let slept = 0;
  await assert.rejects(
    withJitter({ tries: 9, ceilMs: 10, sleep: () => ((slept += 1), Promise.resolve()) }, () => {
      calls++;
      return Promise.reject(new Error('wire closed before the oath, code 4001'));
    }),
    /code 4001/,
  );
  assert.equal(calls, 1, 'вердикт вузла повторён');
  assert.equal(slept, 0);
});

test('одна попытка значит ни одного повтора', async () => {
  let calls = 0;
  await assert.rejects(
    withJitter({ tries: 1, ceilMs: 10, sleep: () => Promise.resolve() }, () => {
      calls++;
      return Promise.reject(new Error('wire did not come up now'));
    }),
    /did not come up/,
  );
  assert.equal(calls, 1);
});
