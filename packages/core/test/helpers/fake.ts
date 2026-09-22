import { ApiClient } from '../../src/api/client.ts';
import { HttpTransport, type Fetch } from '../../src/api/http.ts';
import { RequestGate } from '../../src/net/gate.ts';
import { MemoryStore } from '../../src/util/kv.ts';

export interface Reply {
  status: number;
  body?: string | object;
  headers?: Record<string, string>;
  /** Simulates a connection dropped before any response. */
  drop?: boolean;
}

export interface Seen {
  method: string;
  path: string;
  body: unknown;
  auth: string | null;
  credentials: RequestCredentials | undefined;
}

/** Scripted server: each route has a queue of replies; the last one repeats. */
export class FakeServer {
  readonly seen: Seen[] = [];
  private readonly routes = new Map<string, Reply[]>();

  on(route: string, ...replies: Reply[]): this {
    this.routes.set(route, replies);
    return this;
  }

  readonly fetch: Fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname.replace(/^\/api\/v1/, '') + url.search;
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    this.seen.push({
      method,
      path,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      auth: headers.get('Authorization'),
      credentials: init?.credentials,
    });
    const key = `${method} ${path.split('?')[0] ?? ''}`;
    const queue = this.routes.get(key);
    const reply = queue && queue.length > 1 ? queue.shift() : queue?.[0];
    if (!reply) return Promise.reject(new TypeError(`no route ${key}`));
    if (reply.drop) return Promise.reject(new TypeError('socket hang up'));
    const body = reply.body === undefined ? '' : typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    return Promise.resolve(
      new Response(reply.status === 204 ? null : body, {
        status: reply.status,
        headers: { 'X-Request-Id': `req-${this.seen.length}`, ...reply.headers },
      }),
    );
  };

  count(key: string): number {
    return this.seen.filter((s) => `${s.method} ${s.path.split('?')[0] ?? ''}` === key).length;
  }
}

export function makeApi(server: FakeServer, opts: { token?: string | null; open?: boolean; now?: () => number } = {}) {
  const gate = new RequestGate({ store: new MemoryStore(), storeKey: 'gate', capacity: 1000, ...(opts.now ? { now: opts.now } : {}) });
  const transport = new HttpTransport('https://test.local/api/v1', gate, server.fetch);
  const api = new ApiClient({ transport, token: () => opts.token ?? null, etherOpen: () => opts.open ?? true });
  return { api, gate, transport };
}

export const USER = {
  id: '8d7e6f50-4a3b-4c2d-9e1f-001122334455',
  username: 'north',
  displayName: 'Північна вахта',
  role: 'participant',
  disabled: false,
  createdAt: '2026-09-24T09:00:04.311Z',
  lang: 'uk',
};

export const SESSION = {
  token: 'fJp9HfUeN_fA6pcc7H0hQoGerwUCs7lfTDkZDltKPeE',
  sessionId: '3f0c1d2e-5b6a-4c7d-8e9f-0a1b2c3d4e5f',
  expiresAt: '2026-09-25T09:00:04.311Z',
  user: USER,
};

export const err = (code: string, field?: string) => ({ error: { code, ...(field ? { field } : {}) } });
