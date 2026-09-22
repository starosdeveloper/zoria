#!/usr/bin/env node
// Self-check scenarios of client spec §6 against the real training stand, in one hourly cycle:
// listens to the noise, checks the harbinger countdown, and in the window runs field errors,
// registration, a lost-answer retry, session expiry, developer echo, logout and the roll.
//
//   node scripts/stand-check.ts --repo <owner/repo> [--fingerprint <hex>] [--api <url>] [--jam-test]
//
// Stand rules (§6): hour cycle UTC — :00–:30 noise, harbinger from :20, window :30–:50,
// code STAND-2026, any repository of yours, daily wipe 03:05 UTC. Each run registers one
// fresh throwaway account. --jam-test deliberately exceeds the ether limit on the stand
// (never point it at the prod address).

import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import {
  ApiClient,
  DEFAULT_SERVERS,
  describeFailure,
  EtherMonitor,
  ETHER_INTERVAL_MS,
  formatLocal,
  HttpTransport,
  KeyRing,
  localZoneName,
  MemoryStore,
  normalizeFingerprint,
  parseRepository,
  registerWithRecovery,
  RequestGate,
  runPoll,
  type Fetch,
  type Result,
} from '../packages/core/src/index.ts';

const { values } = parseArgs({
  options: {
    api: { type: 'string', default: DEFAULT_SERVERS.stand.apiBase },
    repo: { type: 'string' },
    fingerprint: { type: 'string' },
    'jam-test': { type: 'boolean', default: false },
    'max-wait-min': { type: 'string', default: '70' },
  },
});

const STAND_CODE = 'STAND-2026';
const apiBase = values.api.replace(/\/+$/, '');
const repo = parseRepository(values.repo ?? '');
if (!repo.ok) {
  console.error('нужен --repo owner/repo (любой ваш репозиторий; на стенде бота нет, заявка останется pending)');
  process.exit(2);
}
if (values['jam-test'] && apiBase === DEFAULT_SERVERS.prod.apiBase) {
  console.error('--jam-test против боевого сервера запрещён: он глушит ваш адрес');
  process.exit(2);
}

const results: { name: string; ok: boolean | null; detail: string }[] = [];
function record(name: string, ok: boolean | null, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${new Date().toISOString()} ${ok === null ? 'SKIP' : ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const code = (r: Result<unknown>): string => (r.ok ? `${r.status}` : r.error.kind === 'api' ? `${r.error.status} ${r.error.code}${r.error.field ? `/${r.error.field}` : ''}` : describeFailure(r.error));

function makeApi(fetchImpl?: Fetch, token: () => string | null = () => null): { api: ApiClient; gate: RequestGate } {
  const gate = new RequestGate({ store: new MemoryStore(), storeKey: 'gate' });
  const transport = new HttpTransport(apiBase, gate, fetchImpl);
  return { api: new ApiClient({ transport, token, etherOpen: () => monitor.state.phase !== 'static' && monitor.state.phase !== 'unknown' }), gate };
}

const { api, gate } = makeApi();
const keys = new KeyRing(() => api.etherKey(), normalizeFingerprint(values.fingerprint));
const monitor = new EtherMonitor(api, keys);
// Written from the monitor callback; an object keeps TS from narrowing it to its initial null.
const harbinger: { opensAt: number | null } = { opensAt: null };
let jammed = false;
gate.subscribe(() => {
  jammed = true;
});

console.log(`stand-check → ${apiBase}, зона ${localZoneName()}, репозиторий ${repo.slug}`);
await keys.reload();
const key = keys.known[0];
record('ключ печати стенда', key ? true : null, key ? `${key.fingerprint} (${key.trust})` : `нет: ${keys.error ?? '?'} — узел ещё не в эфире?`);

// ---------- S1–S4: listen until the window ----------
const controller = new AbortController();
const deadline = Date.now() + Number(values['max-wait-min']) * 60_000;
monitor.subscribe((o) => {
  const s = o.state;
  if (s.opensAtMs !== null && harbinger.opensAt === null) {
    harbinger.opensAt = s.opensAtMs;
    console.log(`провозвестник: откроется ${formatLocal(s.opensAtMs)} ${localZoneName()} (${new Date(s.opensAtMs).toISOString()})`);
  }
  if (o.phaseChanged) console.log(`фаза: ${s.phase} ${s.window ? JSON.stringify(s.window) : ''}`);
  if (s.phase === 'window') controller.abort(new DOMException('window', 'AbortError'));
  if (Date.now() > deadline) controller.abort(new DOMException('deadline', 'AbortError'));
});
await runPoll({ intervalMs: ETHER_INTERVAL_MS, jitterMs: 1_000, signal: controller.signal, tick: (s) => monitor.poll('/ether', s) });

const s = monitor.state;
const c = s.counters;
record('S1 шум без 429', !jammed, `сигнал ${c.signal}, эхо ${c.stale}, битые ${c.malformed}, подделки ${c['bad-seal']}, чужой ключ ${c['unknown-key']}, сбои ${c.transport}`);
if (s.phase !== 'window') {
  record('S4 переход в просвет', false, 'окно не наступило за отведённое время');
  finish();
}
record('S4 переход в просвет', true, `кадр ${s.latestAt ?? '?'}`);
const opensAt = s.window ? Date.parse(s.window.opensAt) : null;
const predicted = harbinger.opensAt;
record(
  'S3 отсчёт провозвестника',
  predicted === null || opensAt === null ? null : Math.abs(predicted - opensAt) <= 2_000,
  predicted === null ? 'провозвестник не пойман (запуск после :20?)' : `предсказано ${new Date(predicted).toISOString()}, окно ${s.window?.opensAt ?? '?'}`,
);

// ---------- S7: field errors ----------
const username = `zc${randomBytes(4).toString('hex')}`;
const password = randomBytes(18).toString('base64url');
const base = { username, displayName: `stand-check ${username}`, password, invitation: STAND_CODE, repositoryUrl: repo.slug, lang: 'uk' as const };
const expect422 = async (label: string, body: typeof base, want: string): Promise<void> => {
  const r = await api.register(body);
  record(`S7 ${label}`, !r.ok && r.error.kind === 'api' && r.error.code === want, code(r));
};
await expect422('ссылка на файл → repository-not-root', { ...base, repositoryUrl: `https://github.com/${repo.slug}/blob/main/README.md` }, 'repository-not-root');
await expect422('выдуманный код → invalid-invitation', { ...base, invitation: 'NOT-A-CODE-0000' }, 'invalid-invitation');
await expect422('короткий пароль → invalid-field', { ...base, password: 'short' }, 'invalid-field');

// ---------- S6: registration whose answer is lost ----------
// The request reaches the server, the response is thrown away: the flow must log in, not register twice.
let dropped = false;
const lossy: Fetch = async (input, init) => {
  const response = await fetch(input, init);
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  // Only a 201 is thrown away: dropping a 429 busy answer would lose a request that created nothing.
  if (!dropped && url.endsWith('/auth/register') && response.status === 201) {
    dropped = true;
    await response.body?.cancel();
    throw new TypeError('simulated: connection lost after send');
  }
  return response;
};
const lossyApi = makeApi(lossy).api;
const steps: string[] = [];
const outcome = await registerWithRecovery(lossyApi, base, { onStep: (st) => steps.push(st.step) });
record('S5 регистрация (201 или вход после потери)', outcome.kind === 'registered', outcome.kind === 'registered' ? `via ${outcome.via}` : outcome.kind === 'rejected' || outcome.kind === 'gave-up' ? describeFailure(outcome.kind === 'rejected' ? outcome.failure : outcome.lastFailure) : outcome.kind);
record('S6 потерянный ответ → вход, а не второй аккаунт', outcome.kind === 'registered' && outcome.via === 'login', steps.join(' → '));
if (outcome.kind !== 'registered') finish();
const session = outcome.session;
const again = await api.register(base);
record('S6 второй регистрации нет (409 username-unavailable)', !again.ok && again.error.kind === 'api' && again.error.code === 'username-unavailable', code(again));

// ---------- after registration: what the client shows (CL-19, CL-23, CL-24) ----------
let token: string | null = session.token;
const authed = makeApi(undefined, () => token).api;
const config = await authed.config();
record('кого пригласить (/public/config)', config.ok && config.data.repositoryAccess !== null, config.ok ? `${config.data.repositoryAccess?.githubUsername ?? 'null'}, inviteRequired=${config.data.inviteRequired}` : code(config));
const repository = await authed.repository();
record('статус заявки pending', repository.ok && repository.data.repository?.accessStatus === 'pending', repository.ok ? JSON.stringify(repository.data.repository) : code(repository));
const summary = await authed.summary();
record('сводка /me/summary', summary.ok, summary.ok ? JSON.stringify(summary.data) : code(summary));
const echo = 'Зоря ✓ «ї» 🛰  пробелы ';
const dev = await authed.developerCheck(echo);
record('эхо /developer/check (Unicode цел)', dev.ok && dev.data.echo === echo && dev.data.checks.utf8, dev.ok ? JSON.stringify(dev.data.checks) : code(dev));
const stages = await authed.stages();
record('части задания /stages', stages.ok, stages.ok ? `${stages.data.items.length} шт.` : code(stages));

// ---------- S9: broken token → 401 ----------
token = 'A'.repeat(43);
const broken = await authed.summary();
record('S9 испорченный токен → 401', !broken.ok && broken.error.kind === 'api' && broken.error.status === 401, code(broken));
token = session.token;

// ---------- roll (CL-34) ----------
await monitor.poll('/ether/roll');
const mine = monitor.state.roll?.find((r) => r.at === session.user.createdAt);
record('журнал: своя запись', mine ? true : null, mine ? `№${mine.n}, ${mine.sinceOpen} с от открытия` : 'не найдена (журнал мог прийти раньше записи)');

// ---------- logout ----------
const out = await authed.logout();
const afterLogout = await authed.summary();
record('выход: токен недействителен', out.ok && !afterLogout.ok && afterLogout.error.kind === 'api' && afterLogout.error.status === 401, `${code(out)} → ${code(afterLogout)}`);

// ---------- S8: deliberate jam (opt-in) ----------
if (values['jam-test']) {
  const raw = new HttpTransport(apiBase, new RequestGate({ store: new MemoryStore(), storeKey: 'raw', capacity: 1000 }));
  let retryAfter: number | null = null;
  for (let i = 0; i < 40 && retryAfter === null; i++) {
    const r = await raw.send('/ether', { counted: true });
    if (r.ok && r.raw.status === 429) retryAfter = r.raw.retryAfterSec;
  }
  if (retryAfter === null) record('S8 429', false, 'лимит не сработал за 40 запросов');
  else {
    console.log(`заглушены на ${retryAfter} с; молчим…`);
    await new Promise((resolve) => setTimeout(resolve, (retryAfter + 2) * 1000));
    const after = await raw.send('/ether', { counted: true });
    record('S8 после тишины Retry-After глушение не растёт', after.ok && after.raw.status !== 429, after.ok ? `${after.raw.status}` : describeFailure(after.error));
  }
} else {
  record('S8 429', null, 'пропущено (--jam-test)');
}

finish();

function finish(): never {
  const failed = results.filter((r) => r.ok === false);
  console.log(`\nитог: ${results.filter((r) => r.ok).length} ok, ${failed.length} fail, ${results.filter((r) => r.ok === null).length} skip`);
  process.exit(failed.length === 0 ? 0 : 1);
}
