import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  ApiClient,
  describeFailure,
  describeKeyError,
  diffSummary,
  EtherMonitor,
  ETHER_INTERVAL_MS,
  formatLocal,
  HttpTransport,
  KeyRing,
  localZoneName,
  readSession,
  registerWithRecovery,
  RequestGate,
  runPoll,
  tryParseJson,
  type EtherObservation,
  type Failure,
  type Repository,
  type Session,
  type Summary,
  type TickOutcome,
} from '@zoria/core';
import type { WatcherConfig } from './config.ts';
import { FileStore, readIfExists, writePrivateAtomic } from './files.ts';
import type { Journal, Notifier } from './log.ts';
import { resolveSecrets, type Secrets } from './secrets.ts';

const SUMMARY_INTERVAL_MS = 15_000;
const ROLL_LOOKUP_INTERVAL_MS = 5 * 60_000;
/** Re-login this long before the 24 h session ends (CL-22). */
const SESSION_REFRESH_MARGIN_MS = 60 * 60_000;

/**
 * Long-running listener. Owns three loops under one AbortSignal:
 * the ether (always), the account (once a session exists) and a roll lookup (after registering).
 */
export class Watcher {
  private readonly config: WatcherConfig;
  private readonly journal: Journal;
  private readonly notifier: Notifier;
  private readonly api: ApiClient;
  private readonly monitor: EtherMonitor;
  private readonly keys: KeyRing;
  private readonly keyStore: FileStore;
  private readonly sessionFile: string;
  private session: Session | null = null;
  private registering: Promise<void> | null = null;
  private registrationStopped = false;
  private stoppedStamp: string | null = null;
  private secretsComplainedAt = 0;
  private silenceLoggedAt = 0;
  private accountLoop: Promise<void> | null = null;
  private lastSummary: Summary | null = null;
  private lastRepository: Repository | null = null;
  private harbingerAnnounced = false;
  private rollLookupAt = 0;
  private configProbeAt = 0;
  private rollNumber: number | null = null;

  constructor(config: WatcherConfig, journal: Journal, notifier: Notifier) {
    this.config = config;
    this.journal = journal;
    this.notifier = notifier;
    const gate = new RequestGate({ store: new FileStore(config.stateDir, 'gate.json'), storeKey: 'gate' });
    const transport = new HttpTransport(config.apiBase, gate);
    this.api = new ApiClient({
      transport,
      token: () => this.session?.token ?? null,
      etherOpen: () => this.monitor.state.phase === 'window' || this.monitor.state.phase === 'after',
    });
    this.keys = new KeyRing(() => this.api.etherKey(), config.fingerprint);
    this.keyStore = new FileStore(config.stateDir, 'key.json');
    this.monitor = new EtherMonitor(this.api, this.keys);
    this.sessionFile = join(config.stateDir, 'session.json');
    gate.subscribe(() => {
      this.journal.write('alert', 'jammed', { silentUntil: new Date(gate.silentUntil).toISOString() });
    });
  }

  async run(signal: AbortSignal): Promise<void> {
    this.journal.write('info', 'start', {
      server: this.config.server,
      apiBase: this.config.apiBase,
      mode: this.config.mode,
      pinned: this.config.fingerprint !== null,
      zone: localZoneName(),
    });
    if (this.config.fingerprint === null) {
      this.journal.write('warn', 'fingerprint-not-pinned', { hint: 'впишите "fingerprint" из ТЗ §3, иначе ключ не сверяется с ТЗ' });
    }
    if (this.config.mode === 'register' && this.config.account) {
      const resolved = resolveSecrets(this.config.secretsFile, this.config.account.inline, 'register');
      this.journal.write(resolved.ok ? 'info' : 'warn', resolved.ok ? 'secrets-ready' : 'secrets-pending', resolved.ok ? { file: this.config.secretsFile } : { file: this.config.secretsFile, problems: resolved.problems });
    }
    await this.loadKey();
    this.loadSession();
    this.monitor.subscribe((o) => {
      this.onObservation(o);
    });
    if (this.session) this.startAccountLoop(signal);

    await runPoll({
      intervalMs: ETHER_INTERVAL_MS,
      jitterMs: 2_000,
      signal,
      tick: (s) => this.etherTick(s),
      onError: (error) => {
        this.journal.write('warn', 'ether-tick-error', { error: String(error) });
      },
    });
    await Promise.allSettled([this.registering, this.accountLoop]);
    this.journal.write('info', 'stop');
  }

  private async loadKey(): Promise<void> {
    const saved = this.keyStore.get('key');
    const parsed = saved === null ? null : tryParseJson(saved);
    if (parsed?.ok && typeof parsed.value === 'object' && parsed.value !== null) {
      const v = parsed.value as { publicKey?: unknown; fingerprint?: unknown };
      if (typeof v.publicKey === 'string' && typeof v.fingerprint === 'string') {
        if (await this.keys.restore({ publicKey: v.publicKey, fingerprint: v.fingerprint })) {
          this.journal.write('info', 'key-restored', { fingerprint: v.fingerprint });
          return;
        }
      }
    }
    await this.keys.reload();
    const key = this.keys.known[0];
    if (key) {
      this.keyStore.set('key', JSON.stringify({ publicKey: key.publicKey, fingerprint: key.fingerprint }));
      this.journal.write('info', 'key-loaded', { fingerprint: key.fingerprint, trust: key.trust });
    } else {
      this.journal.write('alert', 'key-unavailable', { error: this.keys.error ? describeKeyError(this.keys.error) : 'unknown' });
    }
  }

  private loadSession(): void {
    const raw = readIfExists(this.sessionFile);
    if (raw === null) return;
    const parsed = tryParseJson(raw);
    const session = parsed.ok ? readSession(parsed.value) : undefined;
    if (session) {
      this.session = session;
      this.journal.write('info', 'session-restored', { username: session.user.username, expiresAt: session.expiresAt });
    }
  }

  private saveSession(session: Session): void {
    this.session = session;
    writePrivateAtomic(this.sessionFile, JSON.stringify(session));
  }

  private async etherTick(signal: AbortSignal): Promise<TickOutcome> {
    this.journal.heartbeat();
    const outcome = await this.monitor.poll('/ether', signal);
    await this.maybeProbeConfig(signal);
    this.maybeRegister(signal);
    return outcome;
  }

  /**
   * Backup trigger (spec §3): a parsed 200 `/public/config` with `registrationOpen: true`
   * also means the window. Only asked once the harbinger's moment has passed, at the ether pace.
   */
  private async maybeProbeConfig(signal: AbortSignal): Promise<void> {
    const s = this.monitor.state;
    if (s.phase !== 'static' || s.opensAtMs === null) return;
    const serverNow = this.monitor.tracker.serverNow();
    if (serverNow < s.opensAtMs || Date.now() - this.configProbeAt < ETHER_INTERVAL_MS) return;
    this.configProbeAt = Date.now();
    const config = await this.api.config(signal);
    if (!config.ok) {
      if (config.error.kind === 'ether') await this.monitor.ingest(config.error.body, Date.now());
      return;
    }
    if (config.data.registrationOpen) {
      this.journal.write('alert', 'config-says-open');
      this.startRegistration(signal, 'config');
    }
  }

  private maybeRegister(signal: AbortSignal): void {
    if (this.monitor.state.phase === 'window') this.startRegistration(signal, 'frame');
  }

  private startRegistration(signal: AbortSignal, trigger: 'frame' | 'config'): void {
    if (this.config.mode !== 'register' || !this.config.account) return;
    if (this.session || this.registering) return;
    const profile = this.config.account;
    const resolved = resolveSecrets(this.config.secretsFile, profile.inline, 'register');
    if (!resolved.ok) {
      this.complainAboutSecrets(resolved.problems, 'просвет открыт, а регистрировать нечем');
      return;
    }
    // A refusal (e.g. invalid-invitation) stops retries until the secrets file changes.
    const stamp = secretsStamp(resolved.secrets);
    if (this.registrationStopped) {
      if (stamp === this.stoppedStamp) return;
      this.registrationStopped = false;
      this.journal.write('alert', 'secrets-changed-retry');
    }
    const account = { ...profile, ...resolved.secrets };
    this.journal.write('alert', 'registration-start', { trigger, username: account.username, repository: account.repositoryUrl });
    this.registering = (async () => {
      try {
        const outcome = await registerWithRecovery(this.api, account, {
          signal,
          onStep: (step) => {
            this.journal.write('info', 'registration-step', { ...step });
          },
        });
        if (outcome.kind === 'rejected') this.stoppedStamp = stamp;
        await this.onRegistration(outcome, signal);
      } catch (error) {
        if (!signal.aborted) this.journal.write('alert', 'registration-crashed', { error: String(error) });
      } finally {
        this.registering = null;
      }
    })();
  }

  private async onRegistration(outcome: Awaited<ReturnType<typeof registerWithRecovery>>, signal: AbortSignal): Promise<void> {
    switch (outcome.kind) {
      case 'registered': {
        this.saveSession(outcome.session);
        const invite = await this.inviteText(signal);
        const text = `Зарегистрирован как ${outcome.session.user.username} (${outcome.via}). ${invite}`;
        this.journal.write('alert', 'registered', { username: outcome.session.user.username, via: outcome.via });
        await this.notifier.send(text);
        this.startAccountLoop(signal);
        return;
      }
      case 'not-open':
        this.journal.write('warn', 'registration-not-open');
        return;
      case 'rejected':
        // A human must act (field error, closed, name taken). Retrying automatically would not help.
        this.registrationStopped = true;
        this.journal.write('alert', 'registration-rejected', { ...failureData(outcome.failure) });
        await this.notifier.send(`Регистрация отклонена: ${describeFailure(outcome.failure)} Нужен человек.`);
        return;
      case 'gave-up':
        this.journal.write('alert', 'registration-gave-up', { ...failureData(outcome.lastFailure) });
        await this.notifier.send(`Регистрация не прошла после многих попыток: ${describeFailure(outcome.lastFailure)}. Повтор на следующем кадре.`);
        return;
    }
  }

  /** Loud but rate-limited: once per 10 minutes while the problem lasts. */
  private complainAboutSecrets(problems: string[], context: string): void {
    if (Date.now() - this.secretsComplainedAt < 10 * 60_000) return;
    this.secretsComplainedAt = Date.now();
    const text = `${context}: ${problems.join('; ')}. Впишите в ${this.config.secretsFile} — наблюдатель подхватит без перезапуска.`;
    this.journal.write('alert', 'secrets-missing', { context, problems });
    void this.notifier.send(text);
  }

  private async inviteText(signal: AbortSignal): Promise<string> {
    const config = await this.api.config(signal);
    const who = config.ok ? config.data.repositoryAccess?.githubUsername : null;
    const login = this.session?.user.username ?? '';
    return `Пригласите ${who ?? 'zoria-net-bot'} в репозиторий и положите в корень .zoria со строкой: ${login}`;
  }

  private startAccountLoop(signal: AbortSignal): void {
    if (this.accountLoop) return;
    this.accountLoop = runPoll({
      intervalMs: SUMMARY_INTERVAL_MS,
      jitterMs: 1_000,
      signal,
      tick: (s) => this.accountTick(s),
      onError: (error) => {
        this.journal.write('warn', 'account-tick-error', { error: String(error) });
      },
    });
  }

  private async accountTick(signal: AbortSignal): Promise<TickOutcome> {
    if (!this.session) return { next: 'interval' };
    if (Date.parse(this.session.expiresAt) - this.monitor.tracker.serverNow() < SESSION_REFRESH_MARGIN_MS) {
      await this.relogin(signal, 'expiring');
    }
    const summary = await this.api.summary(signal);
    if (!summary.ok) return this.accountFailure(summary.error, signal);

    const targets = diffSummary(this.lastSummary, summary.data);
    this.lastSummary = summary.data;
    for (const target of targets) {
      if (target === 'repository') await this.refreshRepository(signal);
      if (target === 'stages') await this.refreshStages(signal);
      if (target === 'inbox') this.journal.write('info', 'inbox', { unread: summary.data.unread });
      if (target === 'news') this.journal.write('info', 'news', { latestNews: summary.data.latestNews });
    }
    await this.maybeFindRoll(signal);
    return { next: 'interval' };
  }

  private async accountFailure(failure: Failure, signal: AbortSignal): Promise<TickOutcome> {
    if (failure.kind === 'ether') {
      // Stand returns to noise after its window, even for registered accounts.
      await this.monitor.ingest(failure.body, Date.now());
      return { next: 'interval' };
    }
    if (failure.kind === 'api' && failure.status === 401) {
      await this.relogin(signal, 'unauthorized');
      return { next: 'interval' };
    }
    if (failure.kind === 'throttled') return { next: 'at', at: Date.now() + failure.retryAfterSec * 1000 };
    if (failure.kind === 'silenced') return { next: 'at', at: failure.until };
    this.journal.write('warn', 'summary-failed', failureData(failure));
    return { next: 'backoff' };
  }

  private async relogin(signal: AbortSignal, why: 'expiring' | 'unauthorized'): Promise<void> {
    const account = this.config.account;
    if (!account) {
      this.journal.write('alert', 'session-lost', { why, hint: 'нет пароля в конфиге для повторного входа' });
      this.session = null;
      return;
    }
    const resolved = resolveSecrets(this.config.secretsFile, account.inline, 'login');
    if (!resolved.ok) {
      this.complainAboutSecrets(resolved.problems, 'нужен повторный вход, а пароля нет');
      return;
    }
    const login = await this.api.login(account.username, resolved.secrets.password, signal);
    if (login.ok) {
      this.saveSession(login.data);
      this.journal.write('info', 'relogin', { why, expiresAt: login.data.expiresAt });
    } else if (login.error.kind === 'api' && login.error.code === 'invalid-credentials' && why === 'unauthorized') {
      // The account behind the saved session no longer exists (the stand wipes daily).
      // Dropping the session lets the next window register again; the flow still logs in first.
      this.session = null;
      this.lastSummary = null;
      this.lastRepository = null;
      this.rollNumber = null;
      writePrivateAtomic(this.sessionFile, 'null');
      this.journal.write('alert', 'account-gone', { username: account.username });
    } else {
      this.journal.write('warn', 'relogin-failed', { why, ...failureData(login.error) });
    }
  }

  private async refreshRepository(signal: AbortSignal): Promise<void> {
    const result = await this.api.repository(signal);
    if (!result.ok) {
      this.journal.write('warn', 'repository-failed', failureData(result.error));
      return;
    }
    const repo = result.data.repository;
    const prev = this.lastRepository;
    this.lastRepository = repo;
    if (!repo) {
      this.journal.write('warn', 'repository-missing');
      return;
    }
    const changed = !prev || prev.accessStatus !== repo.accessStatus || prev.reasonCode !== repo.reasonCode || prev.verifiedElsewhere !== repo.verifiedElsewhere;
    this.journal.write(changed ? 'alert' : 'info', 'repository', {
      url: repo.url,
      accessStatus: repo.accessStatus,
      reasonCode: repo.reasonCode,
      reason: repo.reason,
      checkedAt: repo.checkedAt,
      verifiedElsewhere: repo.verifiedElsewhere,
    });
    if (changed) {
      const warn = repo.verifiedElsewhere ? ' ВНИМАНИЕ: репозиторий подтверждён за другим аккаунтом — пишите организаторам.' : '';
      await this.notifier.send(`Доступ к репозиторию: ${repo.accessStatus}${repo.reason ? ` — ${repo.reason}` : ''}.${warn}`);
    }
  }

  private async refreshStages(signal: AbortSignal): Promise<void> {
    const result = await this.api.stages(signal);
    if (!result.ok) {
      this.journal.write('warn', 'stages-failed', failureData(result.error));
      return;
    }
    const titles = result.data.items.map((s) => `${s.position}. ${s.title}${s.errataAt ? ' (есть уточнение)' : ''}`);
    this.journal.write('alert', 'stages', { count: result.data.items.length, titles });
    if (result.data.items.length > 0) await this.notifier.send(`Части задания: ${titles.join('; ')}`);
  }

  /** Finds our number in the roll (CL-34), at most every 5 minutes, until found. */
  private async maybeFindRoll(signal: AbortSignal): Promise<void> {
    if (this.rollNumber !== null || !this.session) return;
    if (Date.now() - this.rollLookupAt < ROLL_LOOKUP_INTERVAL_MS) return;
    this.rollLookupAt = Date.now();
    await this.monitor.poll('/ether/roll', signal);
    const user = this.session.user;
    const roll = this.monitor.state.roll ?? [];
    // The roll has no login; registration time is exact, the display name is a fallback when unique.
    const byName = roll.filter((r) => r.name === user.displayName);
    const mine = roll.find((r) => r.at === user.createdAt) ?? (byName.length === 1 ? byName[0] : undefined);
    if (mine) {
      this.rollNumber = mine.n;
      this.journal.write('alert', 'roll-found', { n: mine.n, at: mine.at, local: formatLocal(mine.at), sinceOpen: mine.sinceOpen });
    }
  }

  private onObservation(o: EtherObservation): void {
    const s = o.state;
    if (o.phaseChanged) {
      this.journal.write('alert', 'phase', { phase: s.phase, at: s.latestAt, window: s.window });
      void this.notifier.send(
        s.phase === 'window'
          ? `ПРОСВЕТ ОТКРЫТ. Конец: ${formatLocal(s.window?.closesAt ?? null)} (${localZoneName()}).`
          : `Фаза эфира: ${s.phase}`,
      );
    }
    if (s.opensAtMs !== null && !this.harbingerAnnounced) {
      this.harbingerAnnounced = true;
      const opens = new Date(s.opensAtMs).toISOString();
      this.journal.write('alert', 'harbinger', { opensAt: opens, local: formatLocal(s.opensAtMs), zone: localZoneName(), text: s.harbinger?.text.ru });
      void this.notifier.send(`Провозвестник: просвет откроется ${formatLocal(s.opensAtMs)} (${localZoneName()}), ${opens}.`);
      if (this.config.mode === 'register' && this.config.account && !this.session) {
        const resolved = resolveSecrets(this.config.secretsFile, this.config.account.inline, 'register');
        if (!resolved.ok) {
          this.secretsComplainedAt = 0;
          this.complainAboutSecrets(resolved.problems, 'провозвестник пойман, до просвета меньше 6 часов');
        }
      }
    }
    if (o.verdict.kind === 'signal' && o.verdict.frame.fragment) {
      this.journal.write('info', 'fragment', { n: o.verdict.frame.fragment.n, of: o.verdict.frame.fragment.of, collected: s.fragments.size });
    }
    if (o.verdict.kind === 'transport') {
      const silent = s.silentNode;
      if (silent) {
        // 503 stopping repeats every Retry-After: log the start, then a reminder every 10 minutes.
        if (silent.sinceLocalMs === silent.lastLocalMs || Date.now() - this.silenceLoggedAt >= 10 * 60_000) {
          this.silenceLoggedAt = Date.now();
          this.journal.write('info', 'node-silent', { code: silent.code, retryAfterSec: silent.retryAfterSec, since: new Date(silent.sinceLocalMs).toISOString() });
        }
      } else {
        this.journal.write('warn', 'ether-transport', failureData(o.verdict.failure));
      }
    }
    const total = Object.values(s.counters).reduce((a, b) => a + b, 0);
    if (total > 0 && total % 40 === 0) this.journal.write('info', 'ether-counters', { ...s.counters, phase: s.phase });
  }
}

function failureData(f: Failure): Record<string, unknown> {
  const { kind } = f;
  switch (f.kind) {
    case 'api':
      return { kind, status: f.status, code: f.code, field: f.field, requestId: f.requestId };
    case 'throttled':
      return { kind, code: f.code, retryAfterSec: f.retryAfterSec, requestId: f.requestId };
    case 'server':
      return { kind, status: f.status, code: f.code, requestId: f.requestId };
    case 'ether':
    case 'foreign':
      return { kind, status: f.status, requestId: f.requestId };
    case 'network':
      return { kind, reason: f.reason, message: f.message };
    case 'silenced':
      return { kind, until: new Date(f.until).toISOString() };
  }
}

/** Identifies a set of secrets without keeping them around in a second place. */
function secretsStamp(secrets: Secrets): string {
  return createHash('sha256').update(`${secrets.password}\u0000${secrets.invitation}`).digest('hex');
}
