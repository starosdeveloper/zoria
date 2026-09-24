#!/usr/bin/env node
// Zoria.net watcher: listens to the ether, registers in the window, then follows the account.
//   node apps/watcher/src/main.ts run        — long-running (systemd unit in scripts/)
//   node apps/watcher/src/main.ts check      — fetch key + one ether frame, print verdict
//   node apps/watcher/src/main.ts ready      — one readiness report before the window
//   node apps/watcher/src/main.ts selftest   — control frames A–D offline, no network

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  ApiClient,
  describeKeyError,
  EtherMonitor,
  EtherTracker,
  ETHER_INTERVAL_MS,
  formatLocal,
  HttpTransport,
  KeyRing,
  localZoneName,
  MemoryStore,
  sleep,
  RequestGate,
  verifyEnvelopeText,
} from '@zoria/core';
import { ConfigError, loadConfig } from './config.ts';
import { resolveSecrets } from './secrets.ts';
import { ensurePrivateDir, readIfExists } from './files.ts';
import { Journal, makeNotifier } from './log.ts';
import { Watcher } from './watcher.ts';

const run = promisify(execFile);

async function runWatcher(): Promise<number> {
  const config = loadConfig(process.argv[3]);
  ensurePrivateDir(config.stateDir);
  const journal = new Journal(config.stateDir);
  const notifier = makeNotifier(config, journal);
  const controller = new AbortController();
  const stop = (sig: string): void => {
    journal.write('info', 'signal', { sig });
    controller.abort(new DOMException('stopped', 'AbortError'));
  };
  process.once('SIGINT', () => {
    stop('SIGINT');
  });
  process.once('SIGTERM', () => {
    stop('SIGTERM');
  });
  process.on('unhandledRejection', (reason) => {
    journal.write('alert', 'unhandled-rejection', { reason: String(reason) });
  });
  await new Watcher(config, journal, notifier).run(controller.signal);
  return 0;
}

async function check(): Promise<number> {
  const config = loadConfig(process.argv[3]);
  const gate = new RequestGate({ store: new MemoryStore(), storeKey: 'gate' });
  const api = new ApiClient({ transport: new HttpTransport(config.apiBase, gate), token: () => null, etherOpen: () => false });
  const keys = new KeyRing(() => api.etherKey(), config.fingerprint);
  await keys.reload();
  const key = keys.known[0];
  console.log(`server      ${config.apiBase}`);
  console.log(`key         ${key ? `${key.fingerprint} (${key.trust})` : `нет — ${keys.error ? describeKeyError(keys.error) : '?'}`}`);
  const monitor = new EtherMonitor(api, keys);
  let last = '';
  monitor.subscribe((o) => {
    last = o.verdict.kind === 'signal' ? 'сигнал' : o.verdict.kind === 'noise' ? `помеха (${o.verdict.reason})` : 'сбой связи';
  });
  await monitor.poll('/ether');
  const s = monitor.state;
  console.log(`ether       ${last}`);
  console.log(`phase       ${s.phase}`);
  if (s.opensAtMs !== null) console.log(`opens       ${formatLocal(s.opensAtMs)} ${localZoneName()} (${new Date(s.opensAtMs).toISOString()})`);
  if (s.window) console.log(`window      ${formatLocal(s.window.opensAt)} — ${formatLocal(s.window.closesAt)} ${localZoneName()}`);
  if (s.onAir !== null) console.log(`onAir       ${s.onAir}`);
  return key ? 0 : 1;
}

/**
 * One command that answers «готов ли я к просвету»: config, secrets, pinned key against the
 * live node, ether, the .zoria marker, the running service and its heartbeat.
 */
async function ready(): Promise<number> {
  const config = loadConfig(process.argv[3]);
  let bad = 0;
  const say = (ok: boolean | null, label: string, detail = ''): void => {
    if (ok === false) bad++;
    console.log(`${ok === null ? 'skip' : ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  };

  say(config.server === 'prod', 'сервер', `${config.apiBase} (${config.server})`);
  say(config.mode === 'register', 'режим', config.mode);
  const account = config.account;
  say(account !== null, 'аккаунт', account ? `${account.username} / ${account.displayName} / ${account.repositoryUrl}` : 'нет в конфиге');

  const secrets = account ? resolveSecrets(config.secretsFile, account.inline, 'register') : { ok: false as const, problems: ['нет аккаунта'] };
  say(secrets.ok, 'пароль и код заявки', secrets.ok ? config.secretsFile : secrets.problems.join('; '));

  const gate = new RequestGate({ store: new MemoryStore(), storeKey: 'gate' });
  const api = new ApiClient({ transport: new HttpTransport(config.apiBase, gate), token: () => null, etherOpen: () => false });
  const keys = new KeyRing(() => api.etherKey(), config.fingerprint);
  await keys.reload();
  const key = keys.known[0];
  say(config.fingerprint !== null, 'отпечаток из ТЗ закреплён', config.fingerprint ?? 'не задан');
  say(key ? key.trust === 'pinned' : null, 'ключ узла сверен с ТЗ', key ? key.fingerprint : `узел не отдал ключ: ${keys.error ?? '?'}`);

  // Before the window most answers are noise, so give the ether a few tries at the polling floor.
  const monitor = new EtherMonitor(api, keys);
  for (let attempt = 0; attempt < 3 && monitor.state.latestAt === null; attempt++) {
    if (attempt > 0) await sleep(ETHER_INTERVAL_MS + 1_000);
    await monitor.poll('/ether');
  }
  const s = monitor.state;
  const silent = s.silentNode;
  const answered = Object.values(s.counters).reduce((n, c) => n + c, 0) - s.counters.transport;
  // Before the window most answers are noise and a silent node is its normal state, so
  // neither is a failure here: only «сервер вообще не отвечает» is.
  say(
    s.latestAt !== null ? true : answered > 0 ? null : false,
    'эфир',
    s.latestAt
      ? `подписанный кадр, фаза ${s.phase}, at ${s.latestAt}`
      : silent
        ? `узел молчит (${silent.code}) — до просвета это норма, сервис ловит кадры между молчанием`
        : 'три попытки — только помехи; это норма до просвета, кадры видно в журнале сервиса',
  );
  if (s.opensAtMs !== null) say(true, 'провозвестник', `${formatLocal(s.opensAtMs)} ${localZoneName()}`);
  if (s.window) say(s.phase === 'window', 'просвет', `${formatLocal(s.window.opensAt)} — ${formatLocal(s.window.closesAt)} ${localZoneName()}`);

  // fileURLToPath, not .pathname: the project directory name contains a space.
  const marker = readIfExists(fileURLToPath(new URL('../../../.zoria', import.meta.url)));
  const markerLogin = marker?.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? null;
  say(markerLogin !== null && markerLogin.toLowerCase() === account?.username, '.zoria в корне репозитория', markerLogin ?? 'файла нет');

  const session = readIfExists(join(config.stateDir, 'session.json'));
  say(session !== null && session !== 'null' ? true : null, 'аккаунт в сети уже создан', session && session !== 'null' ? 'сессия есть' : 'ещё нет — так и должно быть до просвета');

  const beat = readIfExists(join(config.stateDir, 'heartbeat'));
  const beatAge = beat ? (Date.now() - Date.parse(beat.trim())) / 1000 : null;
  say(beatAge !== null && beatAge < 120, 'наблюдатель жив', beatAge === null ? 'нет heartbeat' : `последний тик ${Math.round(beatAge)} с назад`);

  try {
    const { stdout } = await run('systemctl', ['--user', 'is-active', 'zoria-watcher']);
    say(stdout.trim() === 'active', 'сервис zoria-watcher', stdout.trim());
  } catch (error) {
    say(false, 'сервис zoria-watcher', String(error).split('\n')[0] ?? '');
  }

  console.log(bad === 0 ? '\nготов к просвету' : `\nне готов: ${bad}`);
  return bad === 0 ? 0 : 1;
}

/** Offline check of the seal path on the spec's control frames (spec §6, «Контрольные кадры A–D»). */
async function selftest(): Promise<number> {
  const fixtures = new URL('../../../packages/core/test/fixtures/', import.meta.url);
  const read = (name: string): string => readFileSync(fileURLToPath(new URL(name, fixtures)), 'utf8');
  const keys = new KeyRing(
    () =>
      Promise.resolve({
        algorithm: 'Ed25519',
        key: 'f3a436df65614f08',
        publicKey: 'GQgsc8G1w5aXEnExpTBE597_7acc0vGKMAT5wUW4L5g',
        fingerprint: 'f3a436df65614f08635f18fe0f64f145285203f1faa2905ecb25ffb90969a7de',
      }),
    'f3a436df65614f08635f18fe0f64f145285203f1faa2905ecb25ffb90969a7de',
  );
  const tracker = new EtherTracker();
  const expect: [string, string][] = [
    ['frame-a.json', 'signal'],
    ['frame-b.json', 'bad-seal'],
    ['frame-c.txt', 'malformed'],
    ['frame-d.json', 'signal'],
  ];
  let failed = 0;
  for (const [file, want] of expect) {
    const verdict = await verifyEnvelopeText(read(file), keys);
    const got = verdict.kind === 'signal' ? 'signal' : verdict.reason;
    if (verdict.kind === 'signal') tracker.apply({ type: 'signal', frame: verdict.frame, receivedAtLocalMs: verdict.frame.atMs });
    if (file === 'frame-a.json' && tracker.state.opensAtMs !== Date.parse('2026-09-24T09:00:00.000Z')) failed++;
    const ok = got === want;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${file.padEnd(14)} ${got}`);
  }
  console.log(failed === 0 ? 'selftest: ok' : `selftest: ${failed} failed`);
  return failed === 0 ? 0 : 1;
}

const commands: Record<string, () => Promise<number>> = { run: runWatcher, check, selftest, ready };
const name = process.argv[2] ?? 'run';
const command = commands[name];
if (!command) {
  console.error(`usage: node apps/watcher/src/main.ts <run|check|ready|selftest> [config.json]`);
  process.exit(2);
}
command().then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof ConfigError) console.error(`config: ${error.message}`);
    else console.error(error);
    process.exit(1);
  },
);
