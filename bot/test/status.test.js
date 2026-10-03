/* Служебный порт головы: единственный вход к боту извне его процесса. Из этого
   снимка стек части 4 собирает `/health` и `/metrics` служебного контракта, и
   других счётчиков провода взять негде — их видит только голова.

   Сервер поднимается на свободном порту (`0`) и опрашивается настоящим
   `fetch`: подделывать `IncomingMessage` значило бы проверять свою подделку,
   а не то, что ответит стеку реальный узел сети. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Refusal, statusServer } from '../dist/status.js';

const SNAPSHOT = {
  state: 'live',
  slot: 'A',
  preset: 'жатва',
  presets: ['жатва', 'рівний'],
  freeze: false,
  tick: 742,
  frames: 742,
  ticks: 1200,
  why: '',
  engine: '264a77c2a540',
  uptimeMs: 371000,
  stats: { ticks: 742, orders: 311, nacks: 0, bytesIn: 9, bytesOut: 8, resyncMs: 0, resumes: 1, faults: 0, deferred: 0, lastTickAt: 5 },
  belief: { frames: 742, ageMs: 12 },
};

/** Поднимает сервер на свободном порту и отдаёт адрес с закрывалкой. */
async function serve(head) {
  const server = statusServer(head);
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address();
  return {
    url: 'http://127.0.0.1:' + port,
    close: () => new Promise((ok) => server.close(ok)),
  };
}

const headOf = (over = {}) => ({
  state: () => ({ ...SNAPSHOT, ...over }),
  promote: over.promote ?? ((v) => String(v)),
});

test('GET /state отдаёт снимок головы целиком', async () => {
  const s = await serve(headOf());
  try {
    const res = await fetch(s.url + '/state');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    const body = await res.json();
    assert.equal(body.tick, 742, 'такт мира не дошёл');
    assert.equal(body.preset, 'жатва');
    assert.equal(body.stats.orders, 311, 'счётчики провода не дошли: их видит только голова');
    assert.deepEqual(body.presets, ['жатва', 'рівний']);
    assert.equal(body.belief.frames, 742);
  } finally {
    await s.close();
  }
});

test('POST /preset меняет пресет и возвращает принятое имя', async () => {
  let got = null;
  const s = await serve({
    state: () => SNAPSHOT,
    promote: (v) => {
      got = v;
      return 'обхідник';
    },
  });
  try {
    const res = await fetch(s.url + '/preset', {
      method: 'POST',
      body: JSON.stringify({ preset: 'обхідник' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { preset: 'обхідник' });
    assert.equal(got, 'обхідник', 'имя не дошло до головы');
  } finally {
    await s.close();
  }
});

test('отказ головы приходит своим кодом и машинным словом', async () => {
  const s = await serve({
    state: () => SNAPSHOT,
    promote: () => {
      throw new Refusal(409, 'live');
    },
  });
  try {
    const res = await fetch(s.url + '/preset', { method: 'POST', body: JSON.stringify({ preset: 'шир' }) });
    assert.equal(res.status, 409, 'смена пресета посреди боя должна отбиваться 409');
    assert.deepEqual(await res.json(), { error: 'live' });
  } finally {
    await s.close();
  }
});

test('неожиданная ошибка головы — 500, а не падение сервера', async () => {
  const s = await serve({
    state: () => SNAPSHOT,
    promote: () => {
      throw new Error('что-то своё');
    },
  });
  try {
    const res = await fetch(s.url + '/preset', { method: 'POST', body: JSON.stringify({ preset: 'шир' }) });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'что-то своё' });
    /* сервер жив: следующий запрос отвечает */
    assert.equal((await fetch(s.url + '/state')).status, 200, 'сервер умер после ошибки головы');
  } finally {
    await s.close();
  }
});

test('тело не JSON, не объект или слишком большое — 400 json', async () => {
  const s = await serve(headOf());
  try {
    const bad = async (body) => {
      const res = await fetch(s.url + '/preset', { method: 'POST', body });
      return [res.status, await res.json()];
    };
    assert.deepEqual(await bad('не json вовсе'), [400, { error: 'json' }]);
    assert.deepEqual(await bad('[1,2,3]'), [400, { error: 'json' }], 'список принят за объект');
    assert.deepEqual(await bad('null'), [400, { error: 'json' }], 'null принят за объект');
    /* сюда ходит только control-plane: килобайт с запасом, больше — отказ */
    assert.deepEqual(await bad(JSON.stringify({ preset: 'ж'.repeat(2000) })), [400, { error: 'json' }], 'тело больше килобайта принято');
    /* примитивы JSON разбираются, но объектом не являются */
    assert.deepEqual(await bad('5'), [400, { error: 'json' }], 'число принято за объект');
    assert.deepEqual(await bad('"шир"'), [400, { error: 'json' }], 'строка принята за объект');
    assert.deepEqual(await bad('true'), [400, { error: 'json' }], 'true принят за объект');
  } finally {
    await s.close();
  }
});

test('тело ровно в килобайт ещё принимается', async () => {
  const s = await serve(headOf());
  try {
    /* {"preset":""} — 13 байт обвязки, остальное латиницей по байту */
    const body = JSON.stringify({ preset: 'x'.repeat(1024 - 13) });
    assert.equal(Buffer.byteLength(body), 1024);
    const res = await fetch(s.url + '/preset', { method: 'POST', body });
    assert.equal(res.status, 200, 'граница килобайта сдвинута внутрь');
    const over = await fetch(s.url + '/preset', { method: 'POST', body: body.replace('"x', '"xx') });
    assert.equal(over.status, 400, '1025 байт приняты');
  } finally {
    await s.close();
  }
});

test('пустое тело читается как пустой объект: пресета нет, отказ от головы', async () => {
  let seen = 'не вызывали';
  const s = await serve({
    state: () => SNAPSHOT,
    promote: (v) => {
      seen = v;
      throw new Refusal(400, 'preset');
    },
  });
  try {
    const res = await fetch(s.url + '/preset', { method: 'POST' });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'preset' });
    assert.equal(seen, undefined, 'пустое тело должно дать пресет undefined, а дало ' + String(seen));
  } finally {
    await s.close();
  }
});

test('чужие пути и методы — 404 path', async () => {
  const s = await serve(headOf());
  try {
    const cases = [
      ['GET', '/health'],
      ['GET', '/'],
      ['POST', '/state'],
      ['GET', '/preset'],
      ['DELETE', '/state'],
    ];
    for (const [method, path] of cases) {
      const res = await fetch(s.url + path, { method });
      assert.equal(res.status, 404, method + ' ' + path + ' должен быть 404');
      assert.deepEqual(await res.json(), { error: 'path' });
    }
  } finally {
    await s.close();
  }
});

test('строка запроса не меняет путь', async () => {
  const s = await serve(headOf());
  try {
    const res = await fetch(s.url + '/state?from=stack&t=1');
    assert.equal(res.status, 200, 'путь со строкой запроса не разобран');
    assert.equal((await res.json()).tick, 742);
  } finally {
    await s.close();
  }
});

test('Refusal несёт код и слово', () => {
  const r = new Refusal(409, 'freeze');
  assert.equal(r.code, 409);
  assert.equal(r.message, 'freeze');
  assert.equal(r.name, 'Refusal');
  assert.ok(r instanceof Error, 'отказ должен оставаться ошибкой');
});
