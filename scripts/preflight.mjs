#!/usr/bin/env node
/* Предстартовый прогон сдачи бота — всё, что известно о воротах допуска из
   документов, одной командой. Провал ворот в сезоне — несданный коммит, поэтому
   проверяется до коммита, а не после:

   1. `zaria.bot` в package.json бота запускает бота командой `node` (P2-08);
   2. в каталоге бота только TypeScript и JavaScript (P2-08, правила 3.1);
   3. `.npmrc` несёт только ссылку `${ZORIA_NPM_AUTH}`, а в истории нет
      значений, похожих на секреты (P2-07, оценивание 8.2);
   4. `package-lock.json` лежит в репозитории (P2-01: `npm ci`);
   5. `npm test` проходит **без сети** и укладывается в 10 минут (оценивание
      8.6): тест запускается в отдельном сетевом пространстве `unshare -rn`, где
      из интерфейсов только петля lo;
   6. DECISIONS.md сходится с кодом (scripts/decisions-check.mjs).

   Выход 0 — все пункты прошли; 1 — список провалов. Пункт, который проверить
   нечем (нет unshare), — провал с причиной, а не тихий пропуск. */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BOT = join(ROOT, 'bot');
const TEST_LIMIT_MS = 10 * 60 * 1000;

const results = [];
const check = (name, fn) => {
  try {
    const why = fn();
    results.push([name, why === true ? null : why]);
  } catch (e) {
    results.push([name, e instanceof Error ? e.message : String(e)]);
  }
};
const git = (...args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

check('zaria.bot запускается node', () => {
  const pkg = JSON.parse(readFileSync(join(BOT, 'package.json'), 'utf8'));
  const cmd = pkg.zaria?.bot;
  if (typeof cmd !== 'string') return 'в package.json бота нет поля zaria.bot';
  return /^node\s/.test(cmd) || 'zaria.bot = "' + cmd + '": бот запускается не командой node';
});

check('в каталоге бота только TS/JS', () => {
  const files = git('ls-files', 'bot').stdout.split('\n').filter(Boolean);
  const CODE = /\.(ts|js|mjs|cjs)$/;
  /* не код: конфиги, грамота, документация, служебные файлы npm и git */
  const DATA = /\.(json|yaml|yml|md)$|(^|\/)\.(npmrc|gitignore)$/;
  const other = files.filter((f) => !CODE.test(f) && !DATA.test(f));
  return other.length === 0 || 'не TS/JS и не данные: ' + other.join(', ');
});

check('.npmrc без секрета', () => {
  const text = readFileSync(join(BOT, '.npmrc'), 'utf8');
  if (/_auth(Token)?\s*=\s*(?!\$\{ZORIA_NPM_AUTH\})\S/.test(text)) return '.npmrc содержит значение _auth, а не ссылку ${ZORIA_NPM_AUTH}';
  return /\$\{ZORIA_NPM_AUTH\}/.test(text) || '.npmrc без ссылки ${ZORIA_NPM_AUTH}: npm ci не найдёт реестр';
});

check('история без секретов', () => {
  const log = git('log', '-p', '--all', '--no-color');
  if (log.status !== 0) return 'git log не прочитался: ' + log.stderr.trim();
  const PATTERNS = [
    ['токен npm', /npm_[A-Za-z0-9]{36}/],
    ['токен GitHub', /gh[pousr]_[A-Za-z0-9]{36,}/],
    ['закрытый ключ', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['значение _auth в .npmrc', /^\+.*_auth(Token)?\s*=\s*(?!\$\{)[A-Za-z0-9+/=]{16,}/m],
    ['поле auth из ответа hub', /^\+.*"auth"\s*:\s*"[A-Za-z0-9+/=]{16,}"/m],
  ];
  const hits = PATTERNS.filter(([, re]) => re.test(log.stdout)).map(([name]) => name);
  return hits.length === 0 || 'в истории похоже на секрет: ' + hits.join(', ');
});

check('package-lock.json в репозитории', () => {
  const tracked = git('ls-files', 'bot/package-lock.json').stdout.trim();
  return tracked !== '' || 'bot/package-lock.json не в репозитории: npm ci из свежего checkout не пройдёт';
});

check('npm test без сети и быстрее 10 минут', () => {
  if (!existsSync('/usr/bin/unshare')) return 'нет unshare — проверить тесты без сети нечем';
  const t0 = Date.now();
  /* свежее пространство сети приходит с выключенной петлёй; «без сети» у
     изоляции вроде `--network none` — это петля есть, внешних интерфейсов нет.
     Без lo падали бы проверки служебного порта на 127.0.0.1 — строже ворот */
  const run = spawnSync('unshare', ['-rn', 'sh', '-c', 'ip link set lo up && npm test'], {
    cwd: BOT,
    encoding: 'utf8',
    timeout: TEST_LIMIT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  const ms = Date.now() - t0;
  if (run.error) return 'npm test не запустился: ' + run.error.message;
  if (run.status !== 0) {
    const tail = (run.stdout + run.stderr).trim().split('\n').slice(-8).join('\n');
    return 'npm test без сети упал (код ' + run.status + '):\n' + tail;
  }
  const pass = /ℹ pass (\d+)/.exec(run.stdout)?.[1] ?? '?';
  results.push(['  (npm test: ' + pass + ' проверок за ' + (ms / 1000).toFixed(1) + ' с)', null]);
  return ms < TEST_LIMIT_MS || 'npm test идёт ' + Math.round(ms / 1000) + ' с — дольше 10 минут';
});

check('DECISIONS.md сходится с кодом', () => {
  const run = spawnSync(process.execPath, [join(ROOT, 'scripts/decisions-check.mjs')], { encoding: 'utf8' });
  return run.status === 0 || run.stdout.trim();
});

let failed = 0;
for (const [name, why] of results) {
  if (why) failed++;
  process.stdout.write((why ? 'ПРОВАЛ  ' : 'ок      ') + name + (why ? '\n        ' + why.replace(/\n/g, '\n        ') : '') + '\n');
}
process.stdout.write(failed ? 'предстартовый прогон: провалов ' + failed + '\n' : 'предстартовый прогон: всё прошло\n');
process.exit(failed ? 1 : 0);
