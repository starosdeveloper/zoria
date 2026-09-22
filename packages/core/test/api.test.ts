import { describe, expect, it } from 'vitest';
import { classify } from '../src/api/http.ts';
import { readSummary } from '../src/api/types.ts';
import { fetchAllPages } from '../src/flows/pages.ts';
import { diffSummary } from '../src/flows/summary.ts';
import { registerWithRecovery, type RegisterStep } from '../src/flows/register.ts';
import { RequestGate } from '../src/net/gate.ts';
import { fullJitterDelay } from '../src/net/backoff.ts';
import { MemoryStore } from '../src/util/kv.ts';
import { err, FakeServer, makeApi, SESSION } from './helpers/fake.ts';
import { fixture, frame, seal, TRAINING_FINGERPRINT, TRAINING_KEY_BODY } from './helpers/training.ts';
import { KeyRing } from '../src/ether/keyring.ts';
import { EtherMonitor } from '../src/ether/monitor.ts';

const REQUEST = {
  username: 'north',
  displayName: 'Північна вахта',
  password: 'correct-horse-battery',
  invitation: 'STAND-2026',
  repositoryUrl: 'north/zoria-client',
  lang: 'uk' as const,
};
const noSleep = (): Promise<void> => Promise.resolve();

describe('classify survives any response (CL-01)', () => {
  const expectSummary = { status: 200, read: readSummary };
  const statuses = [200, 201, 204, 400, 401, 403, 404, 409, 410, 418, 422, 500, 502, 504];
  const bodies = ['', 'plain text', '<html><body>oops</body></html>', '{"weird":true}', '[1,2]', 'null', '{"error":{"code":"repository-not-eligible","field":"repositoryUrl"}}', '{"frame":"{\\"v"'];

  it.each(statuses.flatMap((s) => bodies.map((b) => [s, b] as const)))('status %i with body %j', (status, text) => {
    const result = classify({ status, text, requestId: 'r', retryAfterSec: null }, expectSummary);
    expect(result.ok).toBe(false);
  });

  it('routes a 503 envelope to the ether, not to a failure', () => {
    const result = classify({ status: 503, text: fixture('frame-a.json'), requestId: 'r', retryAfterSec: null }, expectSummary);
    expect(!result.ok && result.error.kind).toBe('ether');
  });

  it('429 is always throttled with Retry-After', () => {
    const result = classify({ status: 429, text: JSON.stringify(err('jammed')), requestId: 'r', retryAfterSec: 60 }, expectSummary);
    expect(result).toEqual({ ok: false, error: { kind: 'throttled', code: 'jammed', retryAfterSec: 60, requestId: 'r' } });
  });

  it('5xx carries requestId from the body (CL-37)', () => {
    const result = classify(
      { status: 500, text: JSON.stringify({ error: { code: 'internal-error', requestId: 'abc' } }), requestId: 'hdr', retryAfterSec: null },
      expectSummary,
    );
    expect(result).toEqual({ ok: false, error: { kind: 'server', status: 500, code: 'internal-error', requestId: 'abc', retryAfterSec: null } });
  });
});

describe('transport', () => {
  it('sends bearer header, JSON, and no cookies', async () => {
    const server = new FakeServer().on('GET /me/summary', { status: 200, body: { unread: 0, releasedStages: 0, acknowledgedStages: 0, latestNews: null, repositoryAt: null, serverTime: '2026-09-24T19:31:12.402Z', futureField: 1 } });
    const { api } = makeApi(server, { token: 'tok' });
    const r = await api.summary();
    expect(r.ok).toBe(true);
    expect(server.seen[0]).toMatchObject({ auth: 'Bearer tok', credentials: 'omit' });
  });

  it('dropped connection becomes a network failure, not a throw', async () => {
    const server = new FakeServer().on('GET /public/config', { status: 0, drop: true });
    const { api } = makeApi(server);
    const r = await api.config();
    expect(!r.ok && r.error.kind).toBe('network');
  });
});

describe('jam guard (CL-07)', () => {
  it('after 429 jammed, sends nothing until Retry-After expires', async () => {
    let now = 1_000_000;
    const server = new FakeServer().on('GET /ether', { status: 429, body: err('jammed'), headers: { 'Retry-After': '60' } }, { status: 200, body: 'noise' });
    const { api } = makeApi(server, { now: () => now });
    await api.etherRaw('/ether');
    const second = await api.etherRaw('/ether');
    expect(!second.ok && second.error.kind).toBe('silenced');
    expect(server.count('GET /ether')).toBe(1);
    // key and login are uncounted, but still silent while jammed
    expect(await api.etherKey()).toBeNull();
    expect(server.seen).toHaveLength(1);
    now += 65_000; // past Retry-After + margin + one refill step
    await api.etherRaw('/ether');
    expect(server.count('GET /ether')).toBe(2);
  });

  it('silence survives a reload (persisted)', () => {
    const store = new MemoryStore();
    const now = 5_000_000;
    const gate = new RequestGate({ store, storeKey: 'g', now: () => now });
    gate.observe({ status: 429, text: JSON.stringify(err('jammed')), retryAfterSec: 120 });
    const reloaded = new RequestGate({ store, storeKey: 'g', now: () => now + 1000 });
    expect(reloaded.silentUntil).toBeGreaterThan(now + 120_000);
  });

  it('rate-limited and authentication-busy do not silence the address', () => {
    const gate = new RequestGate({ store: new MemoryStore(), storeKey: 'g' });
    gate.observe({ status: 429, text: JSON.stringify(err('authentication-busy')), retryAfterSec: 5 });
    gate.observe({ status: 429, text: JSON.stringify(err('rate-limited')), retryAfterSec: 60 });
    expect(gate.silentUntil).toBe(0);
  });

  it('local bucket blocks bursts beyond capacity', async () => {
    let now = 0;
    const gate = new RequestGate({ store: new MemoryStore(), storeKey: 'g', now: () => now, capacity: 2, refillMs: 3000 });
    expect((await gate.acquire(true)).ok).toBe(true);
    expect((await gate.acquire(true)).ok).toBe(true);
    const pending = gate.acquire(true);
    now = 3000;
    expect((await pending).ok).toBe(true);
  });
});

describe('backoff (CL-09)', () => {
  it('full jitter stays within [0, min(60 s, 2^n s)]', () => {
    expect(fullJitterDelay(0, () => 0.999)).toBeLessThan(1000);
    expect(fullJitterDelay(3, () => 0.999)).toBeLessThan(8000);
    expect(fullJitterDelay(20, () => 0.999)).toBeLessThan(60_000);
    expect(fullJitterDelay(5, () => 0)).toBe(0);
  });
});

describe('registration never creates a second account (CL-17)', () => {
  it('201 → registered', async () => {
    const server = new FakeServer().on('POST /auth/register', { status: 201, body: SESSION });
    const { api } = makeApi(server);
    const out = await registerWithRecovery(api, REQUEST, { sleep: noSleep });
    expect(out).toMatchObject({ kind: 'registered', via: 'register' });
  });

  it('lost response → login 200 → registered, no second register', async () => {
    const server = new FakeServer()
      .on('POST /auth/register', { status: 0, drop: true })
      .on('POST /auth/login', { status: 200, body: SESSION });
    const { api } = makeApi(server);
    const out = await registerWithRecovery(api, REQUEST, { sleep: noSleep });
    expect(out).toMatchObject({ kind: 'registered', via: 'login' });
    expect(server.count('POST /auth/register')).toBe(1);
  });

  it('lost response → login 401 → register again', async () => {
    const server = new FakeServer()
      .on('POST /auth/register', { status: 502, body: '<html>bad gateway</html>' }, { status: 201, body: SESSION })
      .on('POST /auth/login', { status: 401, body: err('invalid-credentials') });
    const { api } = makeApi(server);
    const steps: RegisterStep[] = [];
    const out = await registerWithRecovery(api, REQUEST, { sleep: noSleep, onStep: (s) => steps.push(s) });
    expect(out).toMatchObject({ kind: 'registered', via: 'register' });
    expect(steps.map((s) => s.step)).toEqual(['register', 'login-probe', 'probe-result', 'wait', 'register']);
  });

  it('409 username-unavailable → login first; 401 means the name is taken', async () => {
    const server = new FakeServer()
      .on('POST /auth/register', { status: 409, body: err('username-unavailable', 'username') })
      .on('POST /auth/login', { status: 401, body: err('invalid-credentials') });
    const { api } = makeApi(server);
    const out = await registerWithRecovery(api, REQUEST, { sleep: noSleep });
    expect(out).toMatchObject({ kind: 'rejected', failure: { code: 'username-unavailable' } });
    expect(server.count('POST /auth/register')).toBe(1);
  });

  it('409 after a lost answer → login 200 → it was ours', async () => {
    const server = new FakeServer()
      .on('POST /auth/register', { status: 0, drop: true }, { status: 409, body: err('username-unavailable') })
      .on('POST /auth/login', { status: 401, body: err('invalid-credentials') }, { status: 200, body: SESSION });
    const { api } = makeApi(server);
    const out = await registerWithRecovery(api, REQUEST, { sleep: noSleep });
    expect(out).toMatchObject({ kind: 'registered', via: 'login' });
  });

  it('429 authentication-busy waits Retry-After and repeats', async () => {
    const server = new FakeServer().on(
      'POST /auth/register',
      { status: 429, body: err('authentication-busy'), headers: { 'Retry-After': '5' } },
      { status: 201, body: SESSION },
    );
    const { api } = makeApi(server);
    const waits: number[] = [];
    const out = await registerWithRecovery(api, REQUEST, { sleep: (ms) => (waits.push(ms), Promise.resolve()) });
    expect(out.kind).toBe('registered');
    expect(waits).toEqual([5000]);
  });

  it('422 invalid-invitation is a field error on the code, not retried', async () => {
    const server = new FakeServer().on('POST /auth/register', { status: 422, body: err('invalid-invitation', 'invitation') });
    const { api } = makeApi(server);
    const out = await registerWithRecovery(api, REQUEST, { sleep: noSleep });
    expect(out).toMatchObject({ kind: 'rejected', failure: { kind: 'api', code: 'invalid-invitation', field: 'invitation' } });
    expect(server.count('POST /auth/register')).toBe(1);
    expect(server.seen[0]?.body).toMatchObject({ invitation: 'STAND-2026' });
  });

  it('422 is a field error for a human', async () => {
    const server = new FakeServer().on('POST /auth/register', { status: 422, body: err('repository-not-eligible', 'repositoryUrl') });
    const { api } = makeApi(server);
    const out = await registerWithRecovery(api, REQUEST, { sleep: noSleep });
    expect(out).toMatchObject({ kind: 'rejected', failure: { kind: 'api', field: 'repositoryUrl' } });
  });

  it('503 envelope means the window is not open yet', async () => {
    const server = new FakeServer().on('POST /auth/register', { status: 503, body: fixture('frame-a.json') });
    const { api } = makeApi(server);
    expect(await registerWithRecovery(api, REQUEST, { sleep: noSleep })).toEqual({ kind: 'not-open' });
  });
});

describe('paging (CL-28)', () => {
  it('reads until nextOffset null, de-duplicates, restarts when the list shifts', async () => {
    const pages = [
      { items: [{ id: 'a' }, { id: 'b' }], nextOffset: 2 },
      // a new item was inserted at the top: b slid onto page 2
      { items: [{ id: 'b' }, { id: 'c' }], nextOffset: 4 },
      { items: [{ id: 'n' }, { id: 'a' }], nextOffset: 2 },
      { items: [{ id: 'b' }, { id: 'c' }], nextOffset: null },
    ];
    let i = 0;
    const out = await fetchAllPages((offset) => {
      const page = pages[i++];
      if (!page) throw new Error(`unexpected offset ${offset}`);
      return Promise.resolve({ ok: true as const, status: 200, data: page, requestId: null });
    });
    expect(out).toEqual({ ok: true, items: [{ id: 'n' }, { id: 'a' }, { id: 'b' }, { id: 'c' }] });
  });
});

describe('summary diff (CL-27)', () => {
  const base = { unread: 0, releasedStages: 1, acknowledgedStages: 0, latestNews: null, repositoryAt: null, serverTime: 'x' };
  it('maps changed fields to refreshes in documented order', () => {
    expect(diffSummary(null, base)).toEqual(['inbox', 'stages', 'news', 'repository']);
    expect(diffSummary(base, { ...base, serverTime: 'y' })).toEqual([]);
    expect(diffSummary(base, { ...base, unread: 1 })).toEqual(['inbox', 'stages']);
    expect(diffSummary(base, { ...base, releasedStages: 2 })).toEqual(['stages']);
    expect(diffSummary(base, { ...base, latestNews: '2026-09-24T19:30:00.000Z' })).toEqual(['news']);
    expect(diffSummary(base, { ...base, repositoryAt: '2026-09-24T09:02:10.000Z' })).toEqual(['repository']);
  });
});

describe('silent node: 503 stopping (FAQ, spec §5.5)', () => {
  it('is not noise, waits Retry-After (never under 15 s), and fetches the key once the node is on air', async () => {
    const stopping = { status: 503, body: { error: { code: 'stopping', message: 'Вузол ще не в ефірі' } }, headers: { 'Retry-After': '30' } };
    const server = new FakeServer()
      .on('GET /ether', stopping, { status: 200, body: await seal(frame()) })
      .on('GET /ether/key', stopping, { status: 200, body: TRAINING_KEY_BODY });
    const { api } = makeApi(server);
    let now = 1_000_000;
    const keys = new KeyRing(() => api.etherKey(), TRAINING_FINGERPRINT, 60_000, () => now);
    const monitor = new EtherMonitor(api, keys);

    const first = await monitor.poll('/ether');
    expect(first.next).toBe('at');
    if (first.next === 'at') expect(first.at - Date.now()).toBeGreaterThanOrEqual(29_000);
    expect(monitor.state.counters.malformed).toBe(0);
    expect(monitor.state.counters.transport).toBe(1);
    expect(keys.known).toHaveLength(0);

    now += 61_000; // key retry cooldown passed; the node is on air now
    const second = await monitor.poll('/ether');
    expect(second).toEqual({ next: 'interval' });
    expect(keys.known[0]?.trust).toBe('pinned');
    expect(monitor.state.phase).toBe('static');
  });
});
