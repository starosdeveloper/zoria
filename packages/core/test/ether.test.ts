import { describe, expect, it } from 'vitest';
import { parseEnvelope, verifyEnvelopeText } from '../src/ether/envelope.ts';
import { KeyRing } from '../src/ether/keyring.ts';
import { EtherTracker } from '../src/ether/state.ts';
import { fixture, frame, seal, TRAINING_KEY_BODY, trainingRing } from './helpers/training.ts';

describe('control frames A–D (client spec §5.2, self-check §6)', () => {
  it('A is a signal: static, harbinger 6 h, opening at 2026-09-24T09:00:00Z', async () => {
    const { ring } = trainingRing();
    const verdict = await verifyEnvelopeText(fixture('frame-a.json'), ring);
    expect(verdict.kind).toBe('signal');
    if (verdict.kind !== 'signal') return;
    expect(verdict.frame.phase).toBe('static');
    expect(verdict.frame.fragment).toEqual({ n: 3, of: 12, text: 'навчальний уривок' });

    const tracker = new EtherTracker();
    tracker.apply({ type: 'signal', frame: verdict.frame, receivedAtLocalMs: Date.parse('2026-09-24T03:00:01.000Z') });
    expect(new Date(tracker.state.opensAtMs ?? 0).toISOString()).toBe('2026-09-24T09:00:00.000Z');
  });

  it('B is a forgery: bad seal, phase does not move to window', async () => {
    const { ring } = trainingRing();
    const tracker = new EtherTracker();
    const a = await verifyEnvelopeText(fixture('frame-a.json'), ring);
    if (a.kind === 'signal') tracker.apply({ type: 'signal', frame: a.frame, receivedAtLocalMs: 0 });

    const b = await verifyEnvelopeText(fixture('frame-b.json'), ring);
    expect(b).toEqual({ kind: 'noise', reason: 'bad-seal' });
    if (b.kind === 'noise') tracker.apply({ type: 'noise', reason: b.reason });
    expect(tracker.state.phase).toBe('static');
    expect(tracker.state.counters['bad-seal']).toBe(1);
  });

  it('C is broken: rejected as malformed without throwing', async () => {
    const { ring } = trainingRing();
    await expect(verifyEnvelopeText(fixture('frame-c.txt'), ring)).resolves.toEqual({ kind: 'noise', reason: 'malformed' });
  });

  it('D is a genuine roll in the window with two entries', async () => {
    const { ring } = trainingRing();
    const d = await verifyEnvelopeText(fixture('frame-d.json'), ring);
    expect(d.kind).toBe('signal');
    if (d.kind !== 'signal') return;
    expect(d.frame.kind).toBe('roll');
    expect(d.frame.phase).toBe('window');
    expect(d.frame.roll?.map((r) => r.name)).toEqual(['Північна вахта', 'Stitch']);
  });
});

describe('seal checks', () => {
  it('verifies over the frame bytes as received, not a re-serialization', async () => {
    const { ring } = trainingRing();
    const env = JSON.parse(fixture('frame-a.json')) as { frame: string; seal: string; key: string };
    // Same JSON value, different bytes: whitespace after the first comma.
    const respaced = JSON.stringify({ ...env, frame: env.frame.replace(',"kind"', ', "kind"') });
    expect((await verifyEnvelopeText(respaced, ring)).kind).toBe('noise');
  });

  it('rejects envelopes of the wrong form', async () => {
    const { ring } = trainingRing();
    for (const body of ['', '<html>', '[]', '{"error":{"code":"jammed"}}', '{"frame":1,"seal":"x","key":"y"}', 'null']) {
      expect((await verifyEnvelopeText(body, ring)).kind).toBe('noise');
    }
    expect(parseEnvelope('{"frame":"{}","seal":"short","key":"f3a436df65614f08"}')).toBeNull();
  });

  it('unknown key id reloads the key once, then gives up as noise', async () => {
    const { ring, fetches } = trainingRing();
    await ring.reload();
    const body = await seal(frame(), '0000000000000000');
    expect(await verifyEnvelopeText(body, ring)).toEqual({ kind: 'noise', reason: 'unknown-key' });
    expect(await verifyEnvelopeText(body, ring)).toEqual({ kind: 'noise', reason: 'unknown-key' });
    // first explicit reload + at most one for the unknown id within the cooldown
    expect(fetches()).toBeLessThanOrEqual(2);
  });

  it('rejects a key whose fingerprint differs from the pinned one', async () => {
    const ring = new KeyRing(() => Promise.resolve(TRAINING_KEY_BODY), 'a'.repeat(64));
    await ring.reload();
    expect(ring.error).toBe('pin-mismatch');
    expect(ring.known).toHaveLength(0);
  });

  it('rejects a key whose advertised fingerprint is not its SHA-256', async () => {
    const ring = new KeyRing(() => Promise.resolve({ ...TRAINING_KEY_BODY, fingerprint: 'b'.repeat(64) }), null);
    await ring.reload();
    expect(ring.error).toBe('fingerprint-mismatch');
  });

  it('unpinned ring accepts a self-consistent key and marks it', async () => {
    const { ring } = trainingRing(null);
    await ring.reload();
    expect(ring.known[0]?.trust).toBe('unpinned');
  });

  it('signed frame with v≠1 or foreign station is noise', async () => {
    const { ring } = trainingRing();
    expect(await verifyEnvelopeText(await seal(frame({ v: 2 })), ring)).toEqual({ kind: 'noise', reason: 'bad-frame' });
    expect(await verifyEnvelopeText(await seal(frame({ station: 'x' })), ring)).toEqual({ kind: 'noise', reason: 'bad-frame' });
  });

  it('ignores unknown fields in frame and envelope (CL-06)', async () => {
    const { ring } = trainingRing();
    const body = JSON.parse(await seal(frame({ extra: { deep: true } }))) as Record<string, unknown>;
    body.more = 1;
    expect((await verifyEnvelopeText(JSON.stringify(body), ring)).kind).toBe('signal');
  });
});

describe('ether state', () => {
  async function signal(overrides: Record<string, unknown>) {
    const { ring } = trainingRing();
    const v = await verifyEnvelopeText(await seal(frame(overrides)), ring);
    if (v.kind !== 'signal') throw new Error('expected signal');
    return v.frame;
  }

  it('echo with older `at` does not roll the phase back (CL-05)', async () => {
    const tracker = new EtherTracker();
    const window = { opensAt: '2026-09-24T09:00:00.000Z', closesAt: '2026-09-24T19:00:00.000Z' };
    tracker.apply({ type: 'signal', frame: await signal({ at: '2026-09-24T09:00:10.000Z', phase: 'window', window }), receivedAtLocalMs: 0 });
    const echo = tracker.apply({ type: 'signal', frame: await signal({ at: '2026-09-24T08:59:00.000Z' }), receivedAtLocalMs: 0 });
    expect(echo.fresh).toBe(false);
    expect(tracker.state.phase).toBe('window');
    expect(tracker.state.counters.stale).toBe(1);
  });

  it('extension brings `after` back to `window` with the new closesAt (CL-12)', async () => {
    const tracker = new EtherTracker();
    const first = { opensAt: '2026-09-24T09:00:00.000Z', closesAt: '2026-09-24T19:00:00.000Z' };
    const extended = { opensAt: '2026-09-24T09:00:00.000Z', closesAt: '2026-09-24T20:00:00.000Z' };
    tracker.apply({ type: 'signal', frame: await signal({ at: '2026-09-24T19:00:05.000Z', phase: 'after', window: first }), receivedAtLocalMs: 0 });
    const r = tracker.apply({ type: 'signal', frame: await signal({ at: '2026-09-24T19:10:00.000Z', phase: 'window', window: extended }), receivedAtLocalMs: 0 });
    expect(r.phaseChanged).toBe(true);
    expect(tracker.state.window?.closesAt).toBe('2026-09-24T20:00:00.000Z');
  });

  it('collects letter fragments by n, drops repeats (CL-35)', async () => {
    const tracker = new EtherTracker();
    tracker.apply({ type: 'signal', frame: await signal({ at: '2026-09-24T01:00:00.000Z', fragment: { n: 2, of: 3, text: 'два' } }), receivedAtLocalMs: 0 });
    tracker.apply({ type: 'signal', frame: await signal({ at: '2026-09-24T01:00:15.000Z', fragment: { n: 2, of: 3, text: 'подмена' } }), receivedAtLocalMs: 0 });
    tracker.apply({ type: 'signal', frame: await signal({ at: '2026-09-24T00:59:00.000Z', fragment: { n: 1, of: 3, text: 'один' } }), receivedAtLocalMs: 0 });
    expect([...tracker.state.fragments.entries()].sort()).toEqual([
      [1, 'один'],
      [2, 'два'],
    ]);
    expect(tracker.state.fragmentsOf).toBe(3);
  });

  it('clock offset keeps the tightest lower bound; delayed frames do not skew it', async () => {
    const tracker = new EtherTracker();
    const at = Date.parse('2026-09-24T03:00:00.000Z');
    // device is 60 s behind the server; the second frame arrived 8 s late (delay noise)
    tracker.apply({ type: 'signal', frame: await signal({ at: '2026-09-24T03:00:00.000Z' }), receivedAtLocalMs: at - 60_000 + 200 });
    tracker.apply({ type: 'signal', frame: await signal({ at: '2026-09-24T03:00:15.000Z' }), receivedAtLocalMs: at + 15_000 - 60_000 + 8_000 });
    expect(tracker.state.clockOffsetMs).toBe(60_000 - 200);
  });

  it('harbinger opening is null outside static', async () => {
    const tracker = new EtherTracker();
    const window = { opensAt: '2026-09-24T09:00:00.000Z', closesAt: '2026-09-24T19:00:00.000Z' };
    tracker.apply({ type: 'signal', frame: await signal({ at: '2026-09-24T09:00:01.000Z', phase: 'window', window }), receivedAtLocalMs: 0 });
    expect(tracker.state.opensAtMs).toBeNull();
  });
});
