/* Связка провода: настоящий процесс `dist/main.js`, как его запускают вузол
   и стек. Проверяются только ветки без вузла — простой без адреса. Вход в
   партию держит `spar.js` против настоящего вузла: подделка вузла здесь
   проверяла бы подделку.

   Ветки две, и обе — обещания стеку части 4: без служебного порта процесс
   обязан выйти с ошибкой запуска (локальный пакет ждёт выхода), а со
   служебным портом — остаться жив и ответить, почему простаивает. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const MAIN = fileURLToPath(new URL('../dist/main.js', import.meta.url));

/** Окружение без следов вузла: переменные родителя здесь не нужны.
    Кроме одной: мутационный прогон включает мутанта переменной окружения, и
    без неё дочерний процесс исполнял исходный код — 106 мутантов провода
    «выжили», хотя проверки их запускали. */
function bare(extra) {
  const env = { PATH: process.env.PATH ?? '' };
  const mutant = process.env.__STRYKER_ACTIVE_MUTANT__;
  if (mutant !== undefined) env.__STRYKER_ACTIVE_MUTANT__ = mutant;
  return { ...env, ...extra };
}

/** Свободный порт: занять нулевой и сразу отдать. */
function freePort() {
  return new Promise((ok, bad) => {
    const s = createServer();
    s.once('error', bad);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

/** Запускает main и копит его вывод; `exit` — обещание кода выхода. */
function launch(env) {
  const child = spawn(process.execPath, [MAIN], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const waiters = [];
  child.stdout.on('data', (b) => {
    out += b.toString('utf8');
    for (const w of waiters.splice(0)) w();
  });
  child.stderr.on('data', (b) => (out += b.toString('utf8')));
  const exit = new Promise((ok) => child.once('exit', (code) => ok(code)));
  /* ждать строку вывода, без таймера: если процесс умер раньше — это и ответ */
  const line = async (re) => {
    let alive = true;
    void exit.then(() => {
      alive = false;
      for (const w of waiters.splice(0)) w();
    });
    while (!re.test(out)) {
      if (!alive) assert.fail('процесс вышел, не напечатав ' + re + ':\n' + out);
      await new Promise((w) => waiters.push(w));
    }
  };
  return { child, exit, line, out: () => out };
}

test('без адреса вузла и без служебного порта — выход с кодом 2 и причиной', async () => {
  const p = launch(bare({}));
  assert.equal(await p.exit, 2, 'код выхода:\n' + p.out());
  assert.match(p.out(), /потрібні ZARIA_URL і ZARIA_TOKEN/);
});

test('печать без адреса — всё равно простой, а не попытка входа', async () => {
  const p = launch(bare({ ZARIA_TOKEN: 'печатка' }));
  assert.equal(await p.exit, 2, p.out());
  const q = launch(bare({ ZARIA_URL: 'ws://127.0.0.1:9' }));
  assert.equal(await q.exit, 2, q.out());
  assert.doesNotMatch(q.out(), /вхід 1/, 'без печати бот пошёл входить');
});

test('со служебным портом голова жива, отвечает о простое и гаснет по SIGTERM', async () => {
  const port = await freePort();
  const p = launch(bare({ STATUS_PORT: String(port), STATUS_HOST: '127.0.0.1', ZARIA_PRESET: 'шир', ZARIA_FREEZE: '1', ZARIA_ENGINE: 'ab'.repeat(32) }));
  try {
    await p.line(/службовий порт \d+/);
    assert.match(p.out(), new RegExp('службовий порт ' + port));
    const st = await (await fetch('http://127.0.0.1:' + port + '/state')).json();
    assert.equal(st.state, 'lobby');
    assert.equal(st.slot, null);
    assert.match(st.why, /потрібні ZARIA_URL і ZARIA_TOKEN/, 'простой без причины: /health не с чем сопоставить');
    assert.equal(st.preset, 'шир', 'ZARIA_PRESET не дошёл до головы');
    assert.equal(st.freeze, true, 'ZARIA_FREEZE не дошёл до головы');
    assert.equal(st.engine, 'ab'.repeat(32), 'ZARIA_ENGINE не дошёл до головы');

    const res = await fetch('http://127.0.0.1:' + port + '/preset', { method: 'POST', body: JSON.stringify({ preset: 'жатва' }) });
    assert.equal(res.status, 409, 'заморозка не держит смену пресета');
    assert.deepEqual(await res.json(), { error: 'freeze' });
  } finally {
    p.child.kill('SIGTERM');
  }
  assert.equal(await p.exit, 0, 'SIGTERM должен гасить голову чисто:\n' + p.out());
});

test('без своих переменных голова садится «жатвой» с хешем установленного рушія', async () => {
  const port = await freePort();
  const p = launch(bare({ STATUS_PORT: String(port), STATUS_HOST: '127.0.0.1' }));
  try {
    await p.line(/службовий порт/);
    const st = await (await fetch('http://127.0.0.1:' + port + '/state')).json();
    assert.equal(st.preset, 'жатва', 'по умолчанию в зачёт уехала бы заглушка шаблона');
    assert.equal(st.freeze, false);
    assert.match(st.engine, /^264a77c2a540/, 'хеш рушія по умолчанию не тот');
  } finally {
    p.child.kill('SIGTERM');
  }
  assert.equal(await p.exit, 0);
});

test('занятый служебный порт без адреса вузла — ошибка запуска с причиной, а не тихий ноль', async () => {
  /* без своего обработчика error процесс гас с кодом 0: служебный порт не
     поднялся, держать процесс нечем, и выход выглядел как успех */
  const busy = createServer();
  await new Promise((ok) => busy.listen(0, '127.0.0.1', ok));
  const { port } = busy.address();
  try {
    const p = launch(bare({ STATUS_PORT: String(port), STATUS_HOST: '127.0.0.1' }));
    assert.equal(await p.exit, 3, 'код выхода:\n' + p.out());
    assert.match(p.out(), new RegExp('службовий порт ' + port + ' не відкрився: .*EADDRINUSE'));
    assert.doesNotMatch(p.out(), /кидок процес/, 'отказ порта ушёл мимо своего обработчика');
  } finally {
    await new Promise((ok) => busy.close(ok));
  }
});
