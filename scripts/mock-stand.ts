#!/usr/bin/env node
// Local imitation of the training stand (client spec §6) for offline development:
// same routes, sealed frames with the public training key, noise before the window,
// token bucket + jamming, a compressed phase cycle. Not the real server — its rules are
// taken from the spec, numbers are configurable.
//
//   node scripts/mock-stand.ts [--port 8787] [--cycle 600] [--noise 0.35]
//
// Cycle (fractions of --cycle seconds, like the stand's hour):
//   0.00–0.50 static, harbinger from 0.333; 0.50–0.833 window; 0.833–1.00 after.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, createPrivateKey, randomBytes, randomUUID, sign } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8787' },
    cycle: { type: 'string', default: '600' },
    noise: { type: 'string', default: '0.35' },
  },
});
const PORT = Number(values.port);
const CYCLE_MS = Number(values.cycle) * 1000;
const NOISE = Number(values.noise);

const PUBLIC = 'GQgsc8G1w5aXEnExpTBE597_7acc0vGKMAT5wUW4L5g';
const SEED = 'bJrTquHp22_7HTNSbyX62-wRZ6_-2fACAvvPx3FY-ew';
const privateKey = createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: SEED, x: PUBLIC }, format: 'jwk' });
const FINGERPRINT = createHash('sha256').update(Buffer.from(PUBLIC, 'base64url')).digest('hex');
const KEY_ID = FINGERPRINT.slice(0, 16);
/** Training application code, one for everyone (client spec §6, редакция 22.09). */
const STAND_INVITATION = 'STAND-2026';
const LETTER = ['Станція', 'чує', 'вас', 'крізь', 'шум,', 'тримайте', 'канал', 'відкритим', 'до', 'просвіту', 'і', 'далі.'];

// ---------- phases ----------
type Phase = 'static' | 'window' | 'after';
const epoch = Date.now() - (Date.now() % CYCLE_MS);
function phaseAt(now: number): { phase: Phase; opensAt: number; closesAt: number } {
  const start = now - ((now - epoch) % CYCLE_MS);
  const opensAt = start + CYCLE_MS * 0.5;
  const closesAt = start + CYCLE_MS * (5 / 6);
  const phase: Phase = now < opensAt ? 'static' : now < closesAt ? 'window' : 'after';
  return { phase, opensAt, closesAt };
}

// ---------- state ----------
interface Account {
  id: string;
  username: string;
  displayName: string;
  password: string;
  lang: string;
  createdAt: string;
  repo: string;
  repoUpdatedAt: string;
  readAt: string | null;
  ackAt: string | null;
}
const accounts = new Map<string, Account>();
const sessions = new Map<string, { username: string; expiresAt: string }>();
const roll: { n: number; at: string; sinceOpen: number; name: string }[] = [];
const echoes: string[] = [];

// ---------- limits (spec §5.6) ----------
const buckets = new Map<string, { tokens: number; at: number; jamUntil: number; strikes: number; lastStrike: number }>();
function limit(ip: string, now: number): { ok: true } | { ok: false; retry: number } {
  const b = buckets.get(ip) ?? { tokens: 20, at: now, jamUntil: 0, strikes: 0, lastStrike: 0 };
  buckets.set(ip, b);
  const refill = Math.floor((now - b.at) / 3000);
  if (refill > 0) {
    b.tokens = Math.min(20, b.tokens + refill);
    b.at += refill * 3000;
  }
  if (b.strikes > 0 && now > b.jamUntil + 600_000) b.strikes = 0;
  const strike = (): { ok: false; retry: number } => {
    const term = Math.min(1800, 30 * 2 ** b.strikes);
    b.strikes++;
    b.lastStrike = now;
    b.jamUntil = now + term * 1000;
    return { ok: false, retry: term };
  };
  if (now < b.jamUntil) {
    const left = Math.ceil((b.jamUntil - now) / 1000);
    return left <= 1 ? { ok: false, retry: 1 } : strike();
  }
  if (b.tokens < 1) return strike();
  b.tokens--;
  return { ok: true };
}

// ---------- frames ----------
function sealFrame(frame: object): string {
  const text = JSON.stringify(frame);
  const seal = sign(null, Buffer.from(text, 'utf8'), privateKey).toString('base64url');
  return JSON.stringify({ frame: text, seal, key: KEY_ID });
}

function frameAt(now: number, kind: 'signal' | 'roll'): string {
  const { phase, opensAt, closesAt } = phaseAt(now);
  const harbingerFrom = opensAt - CYCLE_MS / 6;
  const opensIn = Math.round((opensAt - now) / 1000);
  const frag = phase === 'static' && Math.random() < 0.4 ? Math.floor(Math.random() * LETTER.length) : -1;
  const body = sealFrame({
    v: 1,
    kind,
    station: 'zoria',
    at: new Date(now).toISOString(),
    phase,
    window: phase === 'static' ? null : { opensAt: new Date(opensAt).toISOString(), closesAt: new Date(closesAt).toISOString() },
    harbinger:
      phase === 'static' && now >= harbingerFrom
        ? { opensIn, text: { uk: '...тріск... у шумі несуча...', ru: '...треск... в шуме несущая...' } }
        : null,
    fragment: frag >= 0 ? { n: frag + 1, of: LETTER.length, text: LETTER[frag] } : null,
    onAir: roll.length,
    ...(kind === 'roll' ? { roll: phase === 'static' ? [] : roll } : {}),
  });
  echoes.push(body);
  if (echoes.length > 20) echoes.shift();
  return body;
}

// ---------- http ----------
function send(res: ServerResponse, status: number, body: string | object | null, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Retry-After, X-Request-Id',
    'X-Request-Id': randomUUID(),
    ...(body !== null ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
    ...headers,
  });
  res.end(body === null ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
}
const err = (code: string, field?: string): object => ({ error: { code, ...(field ? { field } : {}) } });

/** One of the noise kinds from spec §5.2. Returns true if it answered. */
function noise(res: ServerResponse, now: number): boolean {
  if (Math.random() >= NOISE) return false;
  const kind = Math.floor(Math.random() * 6);
  switch (kind) {
    case 0: {
      const real = frameAt(now, 'signal');
      send(res, 200, real.slice(0, Math.floor(real.length / 2)));
      return true;
    }
    case 1: {
      const fake = { v: 1, kind: 'signal', station: 'zoria', at: new Date(now).toISOString(), phase: 'window', window: { opensAt: new Date(now - 60_000).toISOString(), closesAt: new Date(now + 3_600_000).toISOString() }, harbinger: null, fragment: null, onAir: 17 };
      send(res, 200, JSON.stringify({ frame: JSON.stringify(fake), seal: randomBytes(64).toString('base64url'), key: KEY_ID }));
      return true;
    }
    case 2: {
      const statuses = [200, 201, 204, 400, 401, 403, 404, 409, 410, 418, 422, 500, 502, 504];
      const status = statuses[Math.floor(Math.random() * statuses.length)] ?? 418;
      const bodies = ['', 'static', '<html><body>502</body></html>', JSON.stringify(err('repository-not-eligible', 'repositoryUrl')), JSON.stringify(err('username-unavailable'))];
      send(res, status, status === 204 ? null : (bodies[Math.floor(Math.random() * bodies.length)] ?? ''));
      return true;
    }
    case 3:
      res.socket?.destroy();
      return true;
    case 4: {
      const real = frameAt(now, 'signal');
      setTimeout(() => {
        send(res, 200, real);
      }, 2000 + Math.random() * 6000);
      return true;
    }
    default: {
      const echo = echoes[0];
      if (!echo) return false;
      send(res, 200, echo);
      return true;
    }
  }
}

async function readBody(req: IncomingMessage): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; code: string }> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return { ok: false, code: 'json-required' };
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? { ok: true, value: v as Record<string, unknown> } : { ok: false, code: 'invalid-json' };
  } catch {
    return { ok: false, code: 'invalid-json' };
  }
}

function session(username: string, now: number): object {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now + 86_400_000).toISOString();
  sessions.set(token, { username, expiresAt });
  return { token, sessionId: randomUUID(), expiresAt, user: userOf(accounts.get(username)) };
}
function userOf(a: Account | undefined): object {
  if (!a) return {};
  return { id: a.id, username: a.username, displayName: a.displayName, role: 'participant', disabled: false, createdAt: a.createdAt, lang: a.lang };
}
function repoOf(a: Account): object {
  return { url: `https://github.com/${a.repo}`, accessStatus: 'pending', checkedAt: null, reason: null, reasonCode: null, updatedAt: a.repoUpdatedAt, verifiedElsewhere: false };
}
const MESSAGE_ID = '5e6f7081-92a3-44b5-86c7-d8e9fa0b1c2d';
const STAGE_ID = 'c1d2e3f4-0516-4728-99aa-bbccddeeff00';
function message(a: Account): object {
  return { id: MESSAGE_ID, messageId: null, stageId: null, kind: 'message', title: 'Заявку отримано', body: 'Статус заявки: `pending`. Запросіть **zoria-net-bot**.', createdAt: a.createdAt, readAt: a.readAt, notice: { type: 'repository', url: `https://github.com/${a.repo}`, accessStatus: 'pending', reason: null, reasonCode: null } };
}
function stage(a: Account): { body: string; errata: string | null } & Record<string, unknown> {
  return { id: STAGE_ID, position: 1, title: 'Частина 1', body: '## Вихід на зв’язок\n\nТекст частини.\n\n1. крок\n2. крок', publishedAt: '2026-09-21T09:00:00.000Z', releasedAt: a.createdAt, acknowledgedAt: a.ackAt, errata: 'Уточнення: **лише приклад**.', errataAt: '2026-09-21T10:00:00.000Z' };
}
function normRepo(v: string): string | null {
  const m = /^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(v.trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

const server = createServer((req, res) => {
  void handle(req, res).catch((error: unknown) => {
    console.error(error);
    if (!res.headersSent) send(res, 500, { error: { code: 'internal-error', requestId: randomUUID() } });
  });
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const now = Date.now();
  const url = new URL(req.url ?? '/', 'http://x');
  const path = url.pathname.replace(/^\/api\/v1/, '');
  const method = req.method ?? 'GET';
  const ip = req.socket.remoteAddress ?? '?';
  const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? null;
  const { phase, opensAt } = phaseAt(now);

  if (method === 'OPTIONS') {
    send(res, 204, null, { 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600' });
    return;
  }
  if (path === '/ether/key') {
    send(res, 200, { algorithm: 'Ed25519', key: KEY_ID, publicKey: PUBLIC, fingerprint: FINGERPRINT });
    return;
  }

  const counted = path !== '/auth/login' && (phase === 'static' || auth === null);
  if (counted) {
    const l = limit(ip, now);
    if (!l.ok) {
      console.log(`${new Date(now).toISOString()} JAM ${ip} ${method} ${path} retry=${l.retry}`);
      send(res, 429, err('jammed'), { 'Retry-After': String(l.retry) });
      return;
    }
  }

  const etherRoute = path === '/ether' || path === '/ether/roll';
  if (phase === 'static' && path !== '/auth/login') {
    if (noise(res, now)) return;
    if (!etherRoute) {
      send(res, 503, frameAt(now, 'signal'));
      return;
    }
  }
  if (etherRoute) {
    send(res, 200, frameAt(now, path === '/ether' ? 'signal' : 'roll'));
    return;
  }

  const who = auth ? sessions.get(auth) : undefined;
  const me = who && Date.parse(who.expiresAt) > now ? accounts.get(who.username) : undefined;
  const needAuth = (): Account | null => {
    if (!me) send(res, 401, err('authentication-required'));
    return me ?? null;
  };

  const route = `${method} ${path}`;
  switch (true) {
    case route === 'GET /public/config':
      send(res, 200, { apiVersion: 1, title: 'Зоря.нет (mock)', season: 'Зоря 2026', registrationOpen: phase === 'window', inviteRequired: true, repositoryRequired: true, repositoryAccess: { githubUsername: 'zoria-net-bot', permission: 'Write в личном репозитории, Read в репозитории организации', instructions: 'Репозиторий должен быть частным. Пригласите аккаунт и положите в корень файл .zoria с логином в сети.' }, webClient: false });
      return;
    case route === 'POST /auth/register': {
      if (phase === 'after') return send(res, 403, err('registration-closed'));
      const body = await readBody(req);
      if (!body.ok) return send(res, body.code === 'json-required' ? 415 : 400, err(body.code));
      const b = body.value;
      const username = String(b.username ?? '').toLowerCase();
      if (!/^[a-z][a-z0-9_-]{2,31}$/.test(username)) return send(res, 422, err('invalid-field', 'username'));
      if (String(b.password ?? '').length < 12) return send(res, 422, err('invalid-field', 'password'));
      const repo = normRepo(String(b.repositoryUrl ?? ''));
      if (/\/(blob|tree|issues)\//.test(String(b.repositoryUrl)) || /[?#]/.test(String(b.repositoryUrl))) return send(res, 422, err('repository-not-root', 'repositoryUrl'));
      if (!repo) return send(res, 422, err('invalid-repository', 'repositoryUrl'));
      if (typeof b.invitation !== 'string' || b.invitation.trim() !== STAND_INVITATION) return send(res, 422, err('invalid-invitation', 'invitation'));
      if (accounts.has(username)) return send(res, 409, err('username-unavailable', 'username'));
      if (Math.random() < 0.15) return send(res, 429, err('authentication-busy'), { 'Retry-After': '5' });
      const createdAt = new Date(now).toISOString();
      accounts.set(username, { id: randomUUID(), username, displayName: String(b.displayName), password: String(b.password), lang: String(b.lang ?? 'uk'), createdAt, repo, repoUpdatedAt: createdAt, readAt: null, ackAt: null });
      roll.push({ n: roll.length + 1, at: createdAt, sinceOpen: Math.floor((now - opensAt) / 1000), name: String(b.displayName) });
      console.log(`${createdAt} REGISTER ${username} → #${roll.length}`);
      return send(res, 201, session(username, now));
    }
    case route === 'POST /auth/login': {
      const body = await readBody(req);
      if (!body.ok) return send(res, 400, err(body.code));
      const a = accounts.get(String(body.value.username ?? '').toLowerCase());
      if (!a || a.password !== body.value.password) return send(res, 401, err('invalid-credentials'));
      return send(res, 200, session(a.username, now));
    }
    case route === 'POST /auth/logout': {
      if (!needAuth()) return;
      if (auth) sessions.delete(auth);
      return send(res, 204, null);
    }
    case route === 'GET /me': {
      const a = needAuth();
      if (a) send(res, 200, { user: userOf(a) });
      return;
    }
    case route === 'PATCH /me': {
      const a = needAuth();
      if (!a) return;
      const body = await readBody(req);
      if (!body.ok) return send(res, 400, err(body.code));
      if (body.value.lang !== 'uk' && body.value.lang !== 'en') return send(res, 422, err('invalid-field', 'lang'));
      a.lang = body.value.lang;
      return send(res, 200, { user: userOf(a) });
    }
    case route === 'GET /me/repository': {
      const a = needAuth();
      if (a) send(res, 200, { repository: repoOf(a) });
      return;
    }
    case route === 'PUT /me/repository': {
      const a = needAuth();
      if (!a) return;
      const body = await readBody(req);
      if (!body.ok) return send(res, 400, err(body.code));
      const repo = normRepo(String(body.value.url ?? ''));
      if (!repo) return send(res, 422, err('invalid-repository', 'url'));
      a.repo = repo;
      a.repoUpdatedAt = new Date(now).toISOString();
      return send(res, 200, { repository: repoOf(a) });
    }
    case route === 'GET /me/summary': {
      const a = needAuth();
      if (a) send(res, 200, { unread: a.readAt ? 0 : 1, releasedStages: 1, acknowledgedStages: a.ackAt ? 1 : 0, latestNews: '2026-09-21T09:00:00.000Z', repositoryAt: a.repoUpdatedAt, serverTime: new Date(now).toISOString() });
      return;
    }
    case route === 'GET /news':
      if (needAuth()) send(res, 200, { items: [{ id: '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9', title: 'Стенд (mock)', body: '# Привет\n\nЭто **локальный мок** стенда. [Спецификация](https://zoria.net/part1/client/)\n\n- пункт\n- ещё\n\n<script>alert(1)</script>', createdAt: '2026-09-21T09:00:00.000Z', updatedAt: '2026-09-21T09:00:00.000Z', publishedAt: '2026-09-21T09:00:00.000Z', archivedAt: null }], nextOffset: null });
      return;
    case route === 'GET /inbox': {
      const a = needAuth();
      if (a) send(res, 200, { items: [message(a)], nextOffset: null });
      return;
    }
    case /^GET \/inbox\/[^/]+$/.test(route): {
      const a = needAuth();
      if (!a) return;
      if (!path.endsWith(MESSAGE_ID)) return send(res, 404, err('not-found'));
      return send(res, 200, { message: message(a) });
    }
    case /^POST \/inbox\/[^/]+\/read$/.test(route): {
      const a = needAuth();
      if (!a) return;
      if (!path.includes(MESSAGE_ID)) return send(res, 404, err('not-found'));
      a.readAt ??= new Date(now).toISOString();
      return send(res, 200, { message: message(a) });
    }
    case route === 'GET /stages': {
      const a = needAuth();
      if (!a) return;
      const { body: _body, errata: _errata, ...summary } = stage(a);
      return send(res, 200, { items: [{ ...summary, excerpt: 'Вихід на зв’язок' }] });
    }
    case /^GET \/stages\/[^/]+$/.test(route): {
      const a = needAuth();
      if (!a) return;
      if (!path.endsWith(STAGE_ID)) return send(res, 404, err('not-found'));
      return send(res, 200, { stage: stage(a) });
    }
    case /^POST \/stages\/[^/]+\/ack$/.test(route): {
      const a = needAuth();
      if (!a) return;
      if (!path.includes(STAGE_ID)) return send(res, 404, err('not-found'));
      a.ackAt ??= new Date(now).toISOString();
      return send(res, 200, { stage: stage(a) });
    }
    case route === 'POST /developer/check': {
      const a = needAuth();
      if (!a) return;
      const body = await readBody(req);
      if (!body.ok) return send(res, 400, err(body.code));
      return send(res, 200, { apiVersion: 1, accountId: a.id, serverTime: new Date(now).toISOString(), echo: String(body.value.echo ?? ''), checks: { authenticated: true, json: true, utf8: true } });
    }
    default:
      send(res, 404, err('not-found'));
  }
}

server.listen(PORT, () => {
  const { opensAt } = phaseAt(Date.now());
  console.log(`mock stand on http://localhost:${PORT}/api/v1  cycle=${CYCLE_MS / 1000}s noise=${NOISE}`);
  console.log(`training key fingerprint ${FINGERPRINT}`);
  console.log(`next window opens ${new Date(opensAt > Date.now() ? opensAt : opensAt + CYCLE_MS).toISOString()}`);
});
