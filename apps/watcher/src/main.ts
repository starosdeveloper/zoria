#!/usr/bin/env node
// Zoria.net watcher: listens to the ether, registers in the window, then follows the account.
//   node apps/watcher/src/main.ts run        — long-running (systemd unit in scripts/)
//   node apps/watcher/src/main.ts check      — fetch key + one ether frame, print verdict
//   node apps/watcher/src/main.ts selftest   — control frames A–D offline, no network

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ApiClient,
  describeKeyError,
  EtherMonitor,
  EtherTracker,
  formatLocal,
  HttpTransport,
  KeyRing,
  localZoneName,
  MemoryStore,
  RequestGate,
  verifyEnvelopeText,
} from '@zoria/core';
import { ConfigError, loadConfig } from './config.ts';
import { ensurePrivateDir } from './files.ts';
import { Journal, makeNotifier } from './log.ts';
import { Watcher } from './watcher.ts';

async function run(): Promise<number> {
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
  const config = loadConfig(process.argv[3], { requireSecrets: false });
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

const commands: Record<string, () => Promise<number>> = { run, check, selftest };
const name = process.argv[2] ?? 'run';
const command = commands[name];
if (!command) {
  console.error(`usage: node apps/watcher/src/main.ts <run|check|selftest> [config.json]`);
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
