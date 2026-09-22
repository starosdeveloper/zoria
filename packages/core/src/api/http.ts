import { readErrorBody } from './types.ts';
import type { Failure, Result } from './result.ts';
import type { Reader } from '../util/guard.ts';
import { tryParseJson } from '../util/json.ts';
import { looksLikeEnvelope } from '../ether/envelope.ts';
import type { RequestGate } from '../net/gate.ts';

/** Spec §5.2: noise delays answers by 2–8 s; beyond this we call it a timeout and let backoff take over. */
export const REQUEST_TIMEOUT_MS = 12_000;

export interface RawResponse {
  status: number;
  text: string;
  requestId: string | null;
  retryAfterSec: number | null;
}

export type Fetch = typeof globalThis.fetch;

export interface HttpOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH';
  body?: unknown;
  token?: string | null;
  signal?: AbortSignal;
  /** Whether this request draws from the per-address ether bucket (spec §5.6). */
  counted: boolean;
}

export class HttpTransport {
  readonly baseUrl: string;
  private readonly gate: RequestGate;
  private readonly fetchImpl: Fetch;

  constructor(baseUrl: string, gate: RequestGate, fetchImpl: Fetch = globalThis.fetch.bind(globalThis)) {
    this.baseUrl = baseUrl;
    this.gate = gate;
    this.fetchImpl = fetchImpl;
  }

  /** Sends one request through the gate. Never throws: caller abort is an `aborted` network failure. */
  async send(path: string, options: HttpOptions): Promise<{ ok: true; raw: RawResponse } | { ok: false; error: Failure }> {
    let permit: Awaited<ReturnType<RequestGate['acquire']>>;
    try {
      permit = await this.gate.acquire(options.counted, options.signal);
    } catch {
      return { ok: false, error: { kind: 'network', reason: 'aborted', message: 'aborted while waiting for the bucket' } };
    }
    if (!permit.ok) return { ok: false, error: { kind: 'silenced', until: permit.until } };

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      const response = await this.fetchImpl(this.baseUrl + path, {
        method: options.method ?? 'GET',
        headers,
        body: body ?? null,
        // Cookies from a foreign origin get 403 origin-not-allowed; auth goes only in the header (spec §2).
        credentials: 'omit',
        cache: 'no-store',
        signal,
      });
      const text = await response.text();
      const raw: RawResponse = {
        status: response.status,
        text,
        requestId: response.headers.get('X-Request-Id'),
        retryAfterSec: parseRetryAfter(response.headers.get('Retry-After')),
      };
      this.gate.observe(raw);
      return { ok: true, raw };
    } catch (error) {
      if (options.signal?.aborted) return { ok: false, error: { kind: 'network', reason: 'aborted', message: 'aborted' } };
      const timedOut = timeout.aborted;
      return {
        ok: false,
        error: {
          kind: 'network',
          reason: timedOut ? 'timeout' : 'failed',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  /** Sends and classifies against the expected success status and body reader. */
  async call<T>(path: string, options: HttpOptions, expect: { status: number; read: Reader<T> }): Promise<Result<T>> {
    const sent = await this.send(path, options);
    if (!sent.ok) return sent;
    return classify(sent.raw, expect);
  }
}

export function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

/** Turns a raw response into a typed result. Order matters: 429 is never noise; envelopes before errors. */
export function classify<T>(raw: RawResponse, expect: { status: number; read: Reader<T> }): Result<T> {
  const parsed = tryParseJson(raw.text);
  const value = parsed.ok ? parsed.value : undefined;
  const errorBody = readErrorBody(value);

  if (raw.status === 429) {
    return {
      ok: false,
      error: {
        kind: 'throttled',
        code: errorBody?.error.code ?? 'rate-limited',
        // Missing header: assume the documented floor for jamming rather than hammering again.
        retryAfterSec: raw.retryAfterSec ?? 30,
        requestId: raw.requestId,
      },
    };
  }

  if (looksLikeEnvelope(value)) {
    return { ok: false, error: { kind: 'ether', status: raw.status, body: raw.text, requestId: raw.requestId } };
  }

  if (raw.status === expect.status) {
    const data = expect.read(value);
    if (data !== undefined) return { ok: true, status: raw.status, data, requestId: raw.requestId };
    return { ok: false, error: { kind: 'foreign', status: raw.status, requestId: raw.requestId } };
  }

  if (raw.status >= 500) {
    return {
      ok: false,
      error: {
        kind: 'server',
        status: raw.status,
        code: errorBody?.error.code ?? null,
        requestId: errorBody?.error.requestId ?? raw.requestId,
        // 503 stopping: the node is silent and says how long (FAQ, spec §5.5).
        retryAfterSec: raw.retryAfterSec,
      },
    };
  }

  if (raw.status >= 400 && errorBody) {
    return {
      ok: false,
      error: {
        kind: 'api',
        status: raw.status,
        code: errorBody.error.code,
        field: errorBody.error.field,
        requestId: raw.requestId,
      },
    };
  }

  return { ok: false, error: { kind: 'foreign', status: raw.status, requestId: raw.requestId } };
}
