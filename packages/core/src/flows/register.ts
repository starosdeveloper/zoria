import type { ApiClient } from '../api/client.ts';
import { isLostResponse, type Failure } from '../api/result.ts';
import type { RegisterRequest, Session } from '../api/types.ts';
import { Backoff } from '../net/backoff.ts';
import { sleep } from '../util/time.ts';

export type RegisterStep =
  | { step: 'register'; attempt: number }
  | { step: 'wait'; reason: 'authentication-busy' | 'rate-limited' | 'jammed' | 'backoff'; ms: number }
  | { step: 'login-probe'; why: 'lost-response' | 'username-unavailable' }
  | { step: 'probe-result'; exists: boolean };

export type RegisterOutcome =
  | { kind: 'registered'; session: Session; via: 'register' | 'login' }
  /** Server still in noise: the request never reached registration (503 envelope). */
  | { kind: 'not-open' }
  /** A definitive refusal a human must act on: field error, closed, capacity. */
  | { kind: 'rejected'; failure: Failure }
  | { kind: 'gave-up'; lastFailure: Failure };

export interface RegisterOptions {
  signal?: AbortSignal;
  onStep?: (step: RegisterStep) => void;
  /** Upper bound on register attempts, so a stuck server cannot keep us looping forever. */
  maxAttempts?: number;
  /** Injected for tests; defaults to a real abortable timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Registration that never creates a second account (CL-17, scoring 13.6).
 *
 * A lost answer (timeout, reset, 5xx) or 409 username-unavailable is resolved by logging in
 * with the same credentials first: 200 means the account exists and is ours; 401 means the
 * registration did not happen (lost) or the name belongs to someone else (409).
 * 429 authentication-busy is queue pressure, not a strike: wait Retry-After and repeat.
 */
export async function registerWithRecovery(
  api: ApiClient,
  request: RegisterRequest,
  options: RegisterOptions = {},
): Promise<RegisterOutcome> {
  const { signal, onStep } = options;
  const pause = options.sleep ?? sleep;
  const maxAttempts = options.maxAttempts ?? 60;
  const backoff = new Backoff();
  let lastFailure: Failure | null = null;
  let attempts = 0;

  const wait = async (reason: Extract<RegisterStep, { step: 'wait' }>['reason'], ms: number): Promise<void> => {
    onStep?.({ step: 'wait', reason, ms });
    await pause(Math.max(0, ms), signal);
  };

  /** Returns the session if the account exists, null if it does not, or a failure to retry on. */
  const probe = async (why: 'lost-response' | 'username-unavailable'): Promise<Session | null | Failure> => {
    let last: Failure = { kind: 'network', reason: 'failed', message: 'login probe did not run' };
    for (let i = 0; i < maxAttempts; i++) {
      onStep?.({ step: 'login-probe', why });
      const login = await api.login(request.username, request.password, signal);
      if (login.ok) {
        onStep?.({ step: 'probe-result', exists: true });
        return login.data;
      }
      const f = login.error;
      last = f;
      if (f.kind === 'network' && f.reason === 'aborted') return f;
      if (f.kind === 'api' && f.code === 'invalid-credentials') {
        onStep?.({ step: 'probe-result', exists: false });
        return null;
      }
      if (f.kind === 'throttled') {
        await wait(f.code === 'authentication-busy' ? 'authentication-busy' : 'rate-limited', f.retryAfterSec * 1000);
        continue;
      }
      if (f.kind === 'silenced') {
        await wait('jammed', f.until - Date.now());
        continue;
      }
      if (isLostResponse(f)) {
        await wait('backoff', backoff.next());
        continue;
      }
      return f;
    }
    return last;
  };

  while (attempts < maxAttempts) {
    attempts++;
    onStep?.({ step: 'register', attempt: attempts });
    const result = await api.register(request, signal);
    if (result.ok) return { kind: 'registered', session: result.data, via: 'register' };

    const f = result.error;
    lastFailure = f;

    if (f.kind === 'ether') return { kind: 'not-open' };
    if (f.kind === 'network' && f.reason === 'aborted') return { kind: 'gave-up', lastFailure: f };

    if (f.kind === 'throttled') {
      await wait(f.code === 'authentication-busy' ? 'authentication-busy' : f.code === 'jammed' ? 'jammed' : 'rate-limited', f.retryAfterSec * 1000);
      continue;
    }
    if (f.kind === 'silenced') {
      await wait('jammed', f.until - Date.now());
      continue;
    }

    if (isLostResponse(f) || (f.kind === 'api' && f.code === 'username-unavailable')) {
      const why = f.kind === 'api' ? 'username-unavailable' : 'lost-response';
      const found = await probe(why);
      if (found !== null && 'token' in found) return { kind: 'registered', session: found, via: 'login' };
      if (found !== null) return { kind: 'rejected', failure: found };
      // Name taken by someone else: retrying would only repeat the 409.
      if (why === 'username-unavailable') return { kind: 'rejected', failure: f };
      await wait('backoff', backoff.next());
      continue;
    }

    return { kind: 'rejected', failure: f };
  }
  return { kind: 'gave-up', lastFailure: lastFailure ?? { kind: 'network', reason: 'failed', message: 'no attempts' } };
}
