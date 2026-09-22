import { HttpTransport, type HttpOptions } from './http.ts';
import type { Result } from './result.ts';
import {
  readConfig,
  readDeveloperCheck,
  readMessage,
  readNews,
  readPage,
  readRepository,
  readSession,
  readStage,
  readStageSummary,
  readSummary,
  readUser,
  type Lang,
  type RegisterRequest,
} from './types.ts';
import { arrayOf, nullable, object, type Reader } from '../util/guard.ts';

export const PAGE_LIMIT = 100;

const readUserBody = object({ user: readUser });
const readRepositoryBody = object({ repository: nullable(readRepository) });
const readRepositoryPut = object({ repository: readRepository });
const readMessageBody = object({ message: readMessage });
const readStageBody = object({ stage: readStage });
const readStagesBody = object({ items: arrayOf(readStageSummary) });
const readNothing: Reader<null> = () => null;
const readAny: Reader<unknown> = (v) => v;

export interface ApiClientOptions {
  transport: HttpTransport;
  /** Current session token, read at call time so a re-login is picked up immediately. */
  token: () => string | null;
  /**
   * Whether the server has left the noise phase. Before the window every request except
   * login/key/openapi counts toward the address bucket; after, only unauthenticated ones do.
   */
  etherOpen: () => boolean;
}

/** One method per route of the part 1 contract (spec §5.3). Methods never throw on server behaviour. */
export class ApiClient {
  private readonly options: ApiClientOptions;

  constructor(options: ApiClientOptions) {
    this.options = options;
  }

  get transport(): HttpTransport {
    return this.options.transport;
  }

  private call<T>(
    path: string,
    init: Omit<HttpOptions, 'counted' | 'token'> & { auth: boolean; uncounted?: boolean },
    status: number,
    read: Reader<T>,
  ): Promise<Result<T>> {
    const token = init.auth ? this.options.token() : null;
    const counted = !init.uncounted && (!token || !this.options.etherOpen());
    const { auth: _auth, uncounted: _uncounted, ...rest } = init;
    return this.options.transport.call(path, { ...rest, token, counted }, { status, read });
  }

  config(signal?: AbortSignal) {
    return this.call('/public/config', { auth: false, ...opt(signal) }, 200, readConfig);
  }

  register(body: RegisterRequest, signal?: AbortSignal) {
    return this.call('/auth/register', { auth: false, method: 'POST', body, ...opt(signal) }, 201, readSession);
  }

  /** Login is outside the ether bucket in every phase (spec §5.6). */
  login(username: string, password: string, signal?: AbortSignal) {
    return this.call(
      '/auth/login',
      { auth: false, uncounted: true, method: 'POST', body: { username, password }, ...opt(signal) },
      200,
      readSession,
    );
  }

  logout(signal?: AbortSignal) {
    return this.call('/auth/logout', { auth: true, method: 'POST', body: {}, ...opt(signal) }, 204, readNothing);
  }

  me(signal?: AbortSignal) {
    return this.call('/me', { auth: true, ...opt(signal) }, 200, readUserBody);
  }

  setLang(lang: Lang, signal?: AbortSignal) {
    return this.call('/me', { auth: true, method: 'PATCH', body: { lang }, ...opt(signal) }, 200, readUserBody);
  }

  repository(signal?: AbortSignal) {
    return this.call('/me/repository', { auth: true, ...opt(signal) }, 200, readRepositoryBody);
  }

  changeRepository(url: string, signal?: AbortSignal) {
    return this.call('/me/repository', { auth: true, method: 'PUT', body: { url }, ...opt(signal) }, 200, readRepositoryPut);
  }

  summary(signal?: AbortSignal) {
    return this.call('/me/summary', { auth: true, ...opt(signal) }, 200, readSummary);
  }

  news(offset: number, signal?: AbortSignal) {
    return this.call(`/news?limit=${PAGE_LIMIT}&offset=${offset}`, { auth: true, ...opt(signal) }, 200, readPage(readNews));
  }

  inbox(offset: number, signal?: AbortSignal) {
    return this.call(`/inbox?limit=${PAGE_LIMIT}&offset=${offset}`, { auth: true, ...opt(signal) }, 200, readPage(readMessage));
  }

  message(id: string, signal?: AbortSignal) {
    return this.call(`/inbox/${encodeURIComponent(id)}`, { auth: true, ...opt(signal) }, 200, readMessageBody);
  }

  markRead(id: string, signal?: AbortSignal) {
    return this.call(
      `/inbox/${encodeURIComponent(id)}/read`,
      { auth: true, method: 'POST', body: {}, ...opt(signal) },
      200,
      readMessageBody,
    );
  }

  stages(signal?: AbortSignal) {
    return this.call('/stages', { auth: true, ...opt(signal) }, 200, readStagesBody);
  }

  stage(id: string, signal?: AbortSignal) {
    return this.call(`/stages/${encodeURIComponent(id)}`, { auth: true, ...opt(signal) }, 200, readStageBody);
  }

  ackStage(id: string, signal?: AbortSignal) {
    return this.call(
      `/stages/${encodeURIComponent(id)}/ack`,
      { auth: true, method: 'POST', body: {}, ...opt(signal) },
      200,
      readStageBody,
    );
  }

  developerCheck(echo: string, signal?: AbortSignal) {
    return this.call('/developer/check', { auth: true, method: 'POST', body: { echo }, ...opt(signal) }, 200, readDeveloperCheck);
  }

  /** Raw ether routes: the body is an envelope or noise, classified by the ether monitor. */
  etherRaw(path: '/ether' | '/ether/roll', signal?: AbortSignal) {
    return this.options.transport.send(path, { counted: true, ...opt(signal) });
  }

  /** `/ether/key` is outside the bucket and never noise (spec §5.2). */
  async etherKey(signal?: AbortSignal): Promise<unknown> {
    const result = await this.call('/ether/key', { auth: false, uncounted: true, ...opt(signal) }, 200, readAny);
    return result.ok ? result.data : null;
  }
}

function opt(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal ? { signal } : {};
}
