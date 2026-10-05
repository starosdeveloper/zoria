import {
  ApiClient,
  checkDraft,
  describeFailure,
  describeKeyError,
  diffSummary,
  EtherMonitor,
  ETHER_INTERVAL_MS,
  fetchAllPages,
  fieldForCode,
  isAbortError,
  normalizeUsername,
  HttpTransport,
  INITIAL_ETHER,
  KeyRing,
  parseRepository,
  readSession,
  registerWithRecovery,
  RequestGate,
  ROLL_INTERVAL_MS,
  runPoll,
  tryParseJson,
  type Config,
  type DraftErrors,
  type EtherSnapshot,
  type Failure,
  type Lang,
  type Message,
  type News,
  type RegistrationDraft,
  type RegisterStep,
  type Repository,
  type Result,
  type ServerId,
  type ServerProfile,
  type Session,
  type Stage,
  type StageSummary,
  type Summary,
  type TrustedKey,
} from '@zoria/core';
import { initialListening, initialServer, local, saveListening, saveServer, serverProfile, session as sessionStore } from './settings.ts';

export const VIEWS = ['ether', 'register', 'access', 'inbox', 'news', 'stages', 'roll', 'hq', 'settings'] as const;
export type View = (typeof VIEWS)[number];

const SUMMARY_INTERVAL_MS = 15_000;
export const SESSION_WARN_MS = 60 * 60_000;

export interface Notice {
  tone: 'error' | 'info' | 'ok';
  text: string;
  /** Set only for 5xx (CL-37): goes into an outage report together with `at`. */
  requestId: string | null;
  at: string;
}

export type RegistrationStatus = 'idle' | 'armed' | 'sending' | 'done' | 'error';

export interface Snapshot {
  server: ServerProfile;
  listening: boolean;
  ether: EtherSnapshot;
  key: TrustedKey | null;
  keyError: string | null;
  silentUntil: number;
  config: Config | null;
  session: Session | null;
  summary: Summary | null;
  repository: Repository | null | undefined;
  inbox: Message[] | null;
  news: News[] | null;
  stages: StageSummary[] | null;
  stageDetails: Readonly<Record<string, Stage>>;
  openMessage: Message | null;
  draft: RegistrationDraft;
  draftErrors: DraftErrors;
  registration: { status: RegistrationStatus; log: string[] };
  repoDraft: string;
  repoError: string | null;
  view: View;
  loginRequired: boolean;
  loginError: string | null;
  notice: Notice | null;
  busy: Readonly<Record<string, boolean>>;
}

const EMPTY_DRAFT: RegistrationDraft = { username: '', displayName: '', password: '', invitation: '', repositoryUrl: '', lang: 'uk' };

/** Draft is kept per tab without the password and the one-time code (CL-16: secrets stay with the participant only). */
function loadDraft(): RegistrationDraft {
  const raw = sessionStore.get('draft');
  const parsed = raw ? tryParseJson(raw) : null;
  if (!parsed?.ok || typeof parsed.value !== 'object' || parsed.value === null) return EMPTY_DRAFT;
  const v = parsed.value as Partial<Record<keyof RegistrationDraft, unknown>>;
  const s = (x: unknown): string => (typeof x === 'string' ? x : '');
  return {
    username: s(v.username),
    displayName: s(v.displayName),
    password: '',
    invitation: '',
    repositoryUrl: s(v.repositoryUrl),
    lang: v.lang === 'en' ? 'en' : 'uk',
  };
}

/**
 * Application state and all traffic. React reads snapshots through `subscribe`/`getSnapshot`;
 * every network loop is owned by an AbortController that dies with the server choice.
 */
export class AppModel {
  private snapshot: Snapshot;
  private readonly listeners = new Set<() => void>();
  private api!: ApiClient;
  private monitor!: EtherMonitor;
  private gate!: RequestGate;
  private keys!: KeyRing;
  private serverScope: AbortController | null = null;
  private etherLoop: AbortController | null = null;
  private accountLoop: AbortController | null = null;
  private rollFetchedAt = 0;
  private stageErrataSeen = new Map<string, string | null>();

  constructor() {
    const id = initialServer();
    this.snapshot = {
      server: serverProfile(id),
      listening: initialListening(),
      ether: INITIAL_ETHER,
      key: null,
      keyError: null,
      silentUntil: 0,
      config: null,
      session: null,
      summary: null,
      repository: undefined,
      inbox: null,
      news: null,
      stages: null,
      stageDetails: {},
      openMessage: null,
      draft: loadDraft(),
      draftErrors: {},
      registration: { status: 'idle', log: [] },
      repoDraft: '',
      repoError: null,
      view: 'ether',
      loginRequired: false,
      loginError: null,
      notice: null,
      busy: {},
    };
  }

  // ---------- store plumbing ----------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): Snapshot => this.snapshot;

  private set(patch: Partial<Snapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }

  private busy(key: string, on: boolean): void {
    this.set({ busy: { ...this.snapshot.busy, [key]: on } });
  }

  // ---------- lifecycle ----------

  start(): void {
    this.connect(this.snapshot.server.id);
  }

  stop(): void {
    this.serverScope?.abort();
    this.serverScope = null;
  }

  private connect(id: ServerId): void {
    this.stop();
    // Loops of the previous scope are already aborted with it; forget them so new ones start.
    this.etherLoop = null;
    this.accountLoop = null;
    const scope = new AbortController();
    this.serverScope = scope;
    const server = serverProfile(id);

    this.gate = new RequestGate({ store: local, storeKey: `gate.${id}` });
    this.gate.subscribe(() => {
      this.set({ silentUntil: this.gate.silentUntil });
    });
    const transport = new HttpTransport(server.apiBase, this.gate);
    this.api = new ApiClient({
      transport,
      token: () => this.snapshot.session?.token ?? null,
      etherOpen: () => this.snapshot.ether.phase === 'window' || this.snapshot.ether.phase === 'after',
    });
    this.keys = new KeyRing(() => this.api.etherKey(scope.signal), server.fingerprint);
    this.monitor = new EtherMonitor(this.api, this.keys);
    this.monitor.subscribe((o) => {
      const key = this.keys.known[0] ?? null;
      this.set({ ether: o.state, key, keyError: key ? null : this.keys.error ? describeKeyError(this.keys.error) : this.snapshot.keyError });
      if (o.phaseChanged && o.state.phase === 'window') this.onWindowOpened();
    });

    this.set({
      server,
      ether: INITIAL_ETHER,
      key: null,
      keyError: null,
      silentUntil: this.gate.silentUntil,
      config: null,
      session: this.restoreSession(id),
      summary: null,
      repository: undefined,
      inbox: null,
      news: null,
      stages: null,
      stageDetails: {},
      openMessage: null,
      loginRequired: false,
      notice: null,
    });

    void this.loadKey(id, scope.signal);
    if (this.snapshot.listening) this.startEther();
    if (this.snapshot.session) this.startAccount();
  }

  switchServer(id: ServerId): void {
    if (id === this.snapshot.server.id) return;
    saveServer(id);
    this.set({ loginError: null });
    this.set({ registration: { status: 'idle', log: [] } });
    this.connect(id);
  }

  setListening(on: boolean): void {
    saveListening(on);
    this.set({ listening: on });
    if (on) this.startEther();
    else {
      this.etherLoop?.abort();
      this.etherLoop = null;
    }
  }

  setView(view: View): void {
    this.set({ view, openMessage: view === 'inbox' ? this.snapshot.openMessage : null });
    if (view === 'roll') void this.refreshRoll();
    if (view === 'access' && this.snapshot.config === null) void this.refreshConfig();
  }

  dismissNotice(): void {
    this.set({ notice: null });
  }

  // ---------- key ----------

  /** CL-04: fetch the key once, compare fingerprints, keep it. */
  private async loadKey(id: ServerId, signal: AbortSignal): Promise<void> {
    const saved = local.get(`key.${id}`);
    const parsed = saved ? tryParseJson(saved) : null;
    if (parsed?.ok && typeof parsed.value === 'object' && parsed.value !== null) {
      const v = parsed.value as { publicKey?: unknown; fingerprint?: unknown };
      if (typeof v.publicKey === 'string' && typeof v.fingerprint === 'string' && (await this.keys.restore({ publicKey: v.publicKey, fingerprint: v.fingerprint }))) {
        this.set({ key: this.keys.known[0] ?? null });
        return;
      }
    }
    await this.keys.reload();
    if (signal.aborted) return;
    const key = this.keys.known[0] ?? null;
    if (key) local.set(`key.${id}`, JSON.stringify({ publicKey: key.publicKey, fingerprint: key.fingerprint }));
    this.set({ key, keyError: this.keys.error ? describeKeyError(this.keys.error) : null });
  }

  // ---------- ether ----------

  private startEther(): void {
    if (this.etherLoop || !this.serverScope) return;
    const loop = new AbortController();
    this.etherLoop = loop;
    const signal = AbortSignal.any([loop.signal, this.serverScope.signal]);
    void runPoll({
      intervalMs: ETHER_INTERVAL_MS,
      jitterMs: 2_000,
      signal,
      tick: (s) => this.monitor.poll('/ether', s),
      onError: (error) => {
        this.set({ notice: { tone: 'error', text: `Эфир: ${String(error)}`, requestId: null, at: new Date().toISOString() } });
      },
    });
  }

  async refreshRoll(): Promise<void> {
    if (Date.now() - this.rollFetchedAt < ROLL_INTERVAL_MS) return;
    this.rollFetchedAt = Date.now();
    this.busy('roll', true);
    try {
      await this.monitor.poll('/ether/roll', this.serverScope?.signal);
    } finally {
      this.busy('roll', false);
    }
  }

  get serverNowOffset(): number {
    return this.snapshot.ether.clockOffsetMs;
  }

  private onWindowOpened(): void {
    if (this.snapshot.registration.status === 'armed' && !this.snapshot.session) void this.submitRegistration();
  }

  // ---------- registration ----------

  updateDraft(patch: Partial<RegistrationDraft>): void {
    const draft = { ...this.snapshot.draft, ...patch };
    const { password: _password, invitation: _invitation, ...persisted } = draft;
    sessionStore.set('draft', JSON.stringify(persisted));
    const errors = { ...this.snapshot.draftErrors };
    for (const key of Object.keys(patch) as (keyof RegistrationDraft)[]) Reflect.deleteProperty(errors, key);
    this.set({ draft, draftErrors: errors });
  }

  /** CL-16: arm the prepared application; it goes out on the first sealed `window` frame. */
  arm(on: boolean): void {
    if (on) {
      const errors = checkDraft(this.snapshot.draft);
      if (Object.keys(errors).length > 0) {
        this.set({ draftErrors: errors });
        return;
      }
    }
    this.set({ registration: { status: on ? 'armed' : 'idle', log: this.snapshot.registration.log } });
    if (on && this.snapshot.ether.phase === 'window') void this.submitRegistration();
  }

  private log(line: string): void {
    const stamp = new Date().toLocaleTimeString();
    const log = [...this.snapshot.registration.log, `${stamp} ${line}`].slice(-30);
    this.set({ registration: { ...this.snapshot.registration, log } });
  }

  async submitRegistration(): Promise<void> {
    const { draft } = this.snapshot;
    const errors = checkDraft(draft);
    if (Object.keys(errors).length > 0) {
      this.set({ draftErrors: errors });
      return;
    }
    if (this.snapshot.registration.status === 'sending') return;
    const repo = parseRepository(draft.repositoryUrl);
    this.set({ registration: { status: 'sending', log: this.snapshot.registration.log } });
    let outcome: Awaited<ReturnType<typeof registerWithRecovery>>;
    try {
      outcome = await registerWithRecovery(
        this.api,
        { ...draft, username: normalizeUsername(draft.username), invitation: draft.invitation.trim(), repositoryUrl: repo.ok ? repo.slug : draft.repositoryUrl },
        {
          ...(this.serverScope ? { signal: this.serverScope.signal } : {}),
          onStep: (step) => {
            this.log(describeStep(step));
          },
        },
      );
    } catch (error) {
      // Only a server switch or unmount aborts the flow; anything else is a bug worth showing.
      if (!isAbortError(error)) this.set({ notice: { tone: 'error', text: `Регистрация: ${String(error)}`, requestId: null, at: new Date().toISOString() } });
      this.set({ registration: { status: 'idle', log: this.snapshot.registration.log } });
      return;
    }
    switch (outcome.kind) {
      case 'registered':
        this.log(outcome.via === 'login' ? 'Аккаунт уже был создан — вошли в него.' : 'Зарегистрированы.');
        this.acceptSession(outcome.session);
        this.set({ registration: { status: 'done', log: this.snapshot.registration.log }, view: 'access' });
        void this.refreshConfig();
        return;
      case 'not-open':
        this.log('Сервер ещё в шуме: регистрации нет.');
        this.set({ registration: { status: 'armed', log: this.snapshot.registration.log } });
        return;
      case 'rejected':
      case 'gave-up': {
        const failure = outcome.kind === 'rejected' ? outcome.failure : outcome.lastFailure;
        this.log(describeFailure(failure));
        const field = failure.kind === 'api' ? fieldForCode(failure.code, failure.field) : null;
        this.set({
          registration: { status: 'error', log: this.snapshot.registration.log },
          draftErrors: field ? { ...this.snapshot.draftErrors, [field]: describeFailure(failure) } : this.snapshot.draftErrors,
          notice: field ? null : noticeOf(failure),
        });
        return;
      }
    }
  }

  // ---------- session ----------

  private restoreSession(id: ServerId): Session | null {
    const raw = sessionStore.get(`session.${id}`);
    const parsed = raw ? tryParseJson(raw) : null;
    const s = parsed?.ok ? readSession(parsed.value) : undefined;
    return s && Date.parse(s.expiresAt) > Date.now() ? s : null;
  }

  private acceptSession(s: Session): void {
    sessionStore.set(`session.${this.snapshot.server.id}`, JSON.stringify(s));
    this.set({ session: s, loginRequired: false, loginError: null, summary: null });
    this.startAccount();
  }

  async login(username: string, password: string): Promise<void> {
    this.busy('login', true);
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const r = await this.api.login(normalizeUsername(username), password, this.serverScope?.signal);
        if (r.ok) {
          // CL-21: back to the same screen; drafts live in the model, so nothing was lost.
          this.acceptSession(r.data);
          return;
        }
        if (r.error.kind === 'throttled' && r.error.code === 'authentication-busy') {
          await new Promise((resolve) => setTimeout(resolve, r.error.kind === 'throttled' ? r.error.retryAfterSec * 1000 : 5000));
          continue;
        }
        this.set({ loginError: describeFailure(r.error) });
        return;
      }
      this.set({ loginError: 'Очередь проверки паролей занята. Попробуйте ещё раз.' });
    } finally {
      this.busy('login', false);
    }
  }

  async logout(): Promise<void> {
    if (this.snapshot.session) await this.api.logout(this.serverScope?.signal);
    this.dropSession(false);
  }

  requireLogin(): void {
    this.set({ loginRequired: true });
  }

  cancelLogin(): void {
    this.set({ loginRequired: false, loginError: null });
  }

  private dropSession(expired: boolean): void {
    this.accountLoop?.abort();
    this.accountLoop = null;
    sessionStore.remove(`session.${this.snapshot.server.id}`);
    this.set({
      session: null,
      summary: null,
      repository: undefined,
      inbox: null,
      news: null,
      stages: null,
      stageDetails: {},
      openMessage: null,
      loginRequired: expired,
    });
  }

  /** Common handling of a failed authenticated call: 401 → login, envelope → ether, rest → notice. */
  private handleFailure(f: Failure): void {
    if (f.kind === 'network' && f.reason === 'aborted') return;
    // CL-02: before the window any unsealed answer is noise — even a plausible 401 or 422.
    // Acting on it (dropping the session, showing an error) would be concluding from noise.
    if (this.snapshot.ether.phase === 'static' && (f.kind === 'api' || f.kind === 'foreign' || f.kind === 'server')) return;
    if (f.kind === 'api' && f.status === 401) {
      this.dropSession(true);
      return;
    }
    if (f.kind === 'ether') {
      void this.monitor.ingest(f.body, Date.now());
      return;
    }
    this.set({ notice: noticeOf(f) });
  }

  private async guarded<T>(key: string, call: () => Promise<Result<T>>): Promise<T | null> {
    this.busy(key, true);
    try {
      const r = await call();
      if (r.ok) return r.data;
      this.handleFailure(r.error);
      return null;
    } finally {
      this.busy(key, false);
    }
  }

  // ---------- account polling (CL-27) ----------

  private startAccount(): void {
    if (this.accountLoop || !this.serverScope) return;
    const loop = new AbortController();
    this.accountLoop = loop;
    const signal = AbortSignal.any([loop.signal, this.serverScope.signal]);
    void runPoll({
      intervalMs: SUMMARY_INTERVAL_MS,
      jitterMs: 1_000,
      signal,
      tick: async (s) => {
        const r = await this.api.summary(s);
        if (!r.ok) {
          if (r.error.kind === 'throttled') return { next: 'at', at: Date.now() + r.error.retryAfterSec * 1000 };
          if (r.error.kind === 'silenced') return { next: 'at', at: r.error.until };
          this.handleFailure(r.error);
          return r.error.kind === 'server' || r.error.kind === 'network' ? { next: 'backoff' } : { next: 'interval' };
        }
        const targets = diffSummary(this.snapshot.summary, r.data);
        const newStage = this.snapshot.summary !== null && r.data.releasedStages > this.snapshot.summary.releasedStages;
        this.set({ summary: r.data });
        for (const t of targets) {
          if (t === 'inbox') await this.refreshInbox();
          if (t === 'stages') await this.refreshStages();
          if (t === 'news') await this.refreshNews();
          if (t === 'repository') await this.refreshRepository();
        }
        if (newStage) notifyBrowser('Зоря.нет: выдана новая часть задания');
        return { next: 'interval' };
      },
    });
  }

  async refreshConfig(): Promise<void> {
    const r = await this.api.config(this.serverScope?.signal);
    if (r.ok) this.set({ config: r.data });
    else if (r.error.kind === 'ether') void this.monitor.ingest(r.error.body, Date.now());
  }

  async refreshRepository(): Promise<void> {
    const data = await this.guarded('repository', () => this.api.repository(this.serverScope?.signal));
    if (!data) return;
    const prev = this.snapshot.repository;
    this.set({ repository: data.repository });
    if (prev && data.repository && prev.accessStatus !== data.repository.accessStatus) {
      notifyBrowser(`Зоря.нет: доступ к репозиторию — ${data.repository.accessStatus}`);
    }
  }

  async refreshInbox(): Promise<void> {
    this.busy('inbox', true);
    try {
      const r = await fetchAllPages((offset) => this.api.inbox(offset, this.serverScope?.signal));
      if (r.ok) this.set({ inbox: r.items });
      else this.handleFailure(r.error);
    } finally {
      this.busy('inbox', false);
    }
  }

  async refreshNews(): Promise<void> {
    this.busy('news', true);
    try {
      const r = await fetchAllPages((offset) => this.api.news(offset, this.serverScope?.signal));
      if (r.ok) this.set({ news: r.items });
      else this.handleFailure(r.error);
    } finally {
      this.busy('news', false);
    }
  }

  async refreshStages(): Promise<void> {
    const data = await this.guarded('stages', () => this.api.stages(this.serverScope?.signal));
    if (!data) return;
    const items = [...data.items].sort((a, b) => a.position - b.position);
    this.set({ stages: items });
    // CL-31: a changed errataAt is the signal to re-read an already opened part.
    for (const s of items) {
      if (this.stageErrataSeen.has(s.id) && this.stageErrataSeen.get(s.id) !== s.errataAt) void this.openStage(s.id);
    }
  }

  async openStage(id: string): Promise<void> {
    const data = await this.guarded(`stage:${id}`, () => this.api.stage(id, this.serverScope?.signal));
    if (!data) return;
    this.stageErrataSeen.set(id, data.stage.errataAt);
    this.set({ stageDetails: { ...this.snapshot.stageDetails, [id]: data.stage } });
  }

  async ackStage(id: string): Promise<void> {
    const data = await this.guarded(`ack:${id}`, () => this.api.ackStage(id, this.serverScope?.signal));
    if (!data) return;
    this.set({ stageDetails: { ...this.snapshot.stageDetails, [id]: data.stage } });
    await this.refreshStages();
  }

  async openMessage(id: string): Promise<void> {
    const data = await this.guarded(`message:${id}`, () => this.api.message(id, this.serverScope?.signal));
    if (data) this.set({ openMessage: data.message });
  }

  closeMessage(): void {
    this.set({ openMessage: null });
  }

  async markRead(id: string): Promise<void> {
    const data = await this.guarded(`read:${id}`, () => this.api.markRead(id, this.serverScope?.signal));
    if (!data) return;
    const inbox = this.snapshot.inbox?.map((m) => (m.id === id ? data.message : m)) ?? null;
    this.set({ inbox, openMessage: this.snapshot.openMessage?.id === id ? data.message : this.snapshot.openMessage });
  }

  setRepoDraft(value: string): void {
    this.set({ repoDraft: value, repoError: null });
  }

  /** CL-26: PUT /me/repository with the login session; status resets to pending. */
  async changeRepository(): Promise<void> {
    const parsed = parseRepository(this.snapshot.repoDraft);
    if (!parsed.ok) {
      this.set({ repoError: 'Нужен адрес самого репозитория: owner/repo или https://github.com/owner/repo.' });
      return;
    }
    this.busy('repo', true);
    try {
      const r = await this.api.changeRepository(parsed.slug, this.serverScope?.signal);
      if (r.ok) {
        this.set({ repository: r.data.repository, repoDraft: '', notice: { tone: 'ok', text: 'Репозиторий изменён, статус — pending.', requestId: null, at: new Date().toISOString() } });
        return;
      }
      if (r.error.kind === 'api' && r.error.status !== 401) this.set({ repoError: describeFailure(r.error) });
      else this.handleFailure(r.error);
    } finally {
      this.busy('repo', false);
    }
  }

  async setLang(lang: Lang): Promise<void> {
    const data = await this.guarded('lang', () => this.api.setLang(lang, this.serverScope?.signal));
    const s = this.snapshot.session;
    if (data && s) this.acceptSession({ ...s, user: data.user });
  }

  async developerCheck(): Promise<void> {
    const echo = 'Зоря ✓ «ї» 🛰';
    const data = await this.guarded('devcheck', () => this.api.developerCheck(echo, this.serverScope?.signal));
    if (!data) return;
    const ok = data.echo === echo && data.checks.authenticated && data.checks.json && data.checks.utf8;
    this.set({ notice: { tone: ok ? 'ok' : 'error', text: ok ? 'Проверка обмена: всё сходится, Unicode цел.' : `Проверка обмена не сошлась: ${JSON.stringify(data.checks)}`, requestId: null, at: new Date().toISOString() } });
  }
}

function describeStep(step: RegisterStep): string {
  switch (step.step) {
    case 'register':
      return `Отправка заявки, попытка ${step.attempt}.`;
    case 'wait':
      return `Ждём ${Math.ceil(step.ms / 1000)} с (${step.reason}).`;
    case 'login-probe':
      return step.why === 'lost-response' ? 'Ответ потерян — проверяем входом, создан ли аккаунт.' : 'Логин занят — проверяем входом, не наш ли он.';
    case 'probe-result':
      return step.exists ? 'Аккаунт существует и он наш.' : 'Аккаунта с этим паролем нет.';
  }
}

function noticeOf(f: Failure): Notice {
  return { tone: 'error', text: describeFailure(f), requestId: f.kind === 'server' ? f.requestId : null, at: new Date().toISOString() };
}

function notifyBrowser(text: string): void {
  try {
    if ('Notification' in window && Notification.permission === 'granted') new Notification(text);
  } catch {
    // Notifications are a convenience; the in-app state already shows the change.
    return;
  }
}
