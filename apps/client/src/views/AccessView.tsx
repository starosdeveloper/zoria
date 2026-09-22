import type { AppModel, Snapshot } from '../state/model.ts';
import { Badge, CopyButton, LocalTime, Panel } from '../components/common.tsx';

const STATUS = {
  pending: { tone: 'warn', text: 'ожидает проверки' },
  verified: { tone: 'ok', text: 'подтверждён' },
  'needs-attention': { tone: 'bad', text: 'требует внимания' },
} as const;

/** Our own texts per machine reason (CL-24); `organizer` always shows the organizer's words. */
const REASON: Record<string, string> = {
  'marker-found': 'Файл .zoria называет ваш аккаунт. Держите доступ до конца конкурса.',
  'marker-other': 'Файл .zoria называет другой аккаунт. Исправьте первую строку файла на свой логин.',
  'marker-absent': 'Приглашение принято, но файла .zoria в корне ветки по умолчанию нет. Положите его.',
  'inviter-mismatch': 'Приглашение отправил не тот GitHub-аккаунт, что указан в заявке. Переотправьте его с логина из заявки.',
};

export function AccessView({ s, model }: { s: Snapshot; model: AppModel }) {
  if (!s.session) {
    return (
      <Panel title="Доступ к репозиторию">
        <p>Нужна регистрация или вход.</p>
        <div className="actions">
          <button type="button" className="primary" onClick={() => { model.setView('register'); }}>К регистрации</button>
          <button type="button" onClick={() => { model.requireLogin(); }}>Войти</button>
        </div>
      </Panel>
    );
  }
  const login = s.session.user.username;
  const access = s.config?.repositoryAccess ?? null;
  const repo = s.repository;
  const status = repo ? (STATUS as Record<string, { tone: 'ok' | 'warn' | 'bad'; text: string } | undefined>)[repo.accessStatus] : undefined;
  const command = `echo ${login} > .zoria && git add .zoria && git commit -m "Зоря.нет: логін у мережі" && git push`;
  const reasonText = repo
    ? repo.reasonCode === 'organizer' || !repo.reasonCode
      ? repo.reason
      : (REASON[repo.reasonCode] ?? repo.reason)
    : null;

  return (
    <div className="grid">
      <Panel title="Что сделать">
        <ol className="steps">
          <li>
            Пригласите в репозиторий <strong>{access?.githubUsername ?? 'zoria-net-bot'}</strong>
            {access ? <CopyButton text={access.githubUsername} /> : null}
            <div className="muted small">{access?.permission ?? 'Write в личном репозитории, Read в репозитории организации.'}</div>
            <div className="muted small">
              <strong>Репозиторий должен оставаться частным</strong> до конца сезона: приглашение из открытого бот не принимает (заявка получит needs-attention). Закрыли репозиторий — бот примет приглашение сам, оно действует 7 дней.
            </div>
          </li>
          <li>
            Положите в корень ветки по умолчанию файл <code>.zoria</code> с одной строкой: <code className="big-code">{login}</code>
            <pre className="cmd">{command}</pre>
            <CopyButton text={command} label="Копировать команду" />
          </li>
          <li>Ждите: бот проверяет приглашения раз в минуту, .zoria — раз в 10 минут.</li>
        </ol>
        {access?.instructions ? <p className="muted">{access.instructions}</p> : null}
        {s.config && !access ? <p className="muted">Сервер сообщает: допуск по репозиторию отключён.</p> : null}
      </Panel>

      <Panel
        title="Статус доступа"
        actions={
          <button type="button" className="ghost" onClick={() => { void model.refreshRepository(); }} disabled={s.busy.repository === true}>
            обновить
          </button>
        }
      >
        {repo === undefined ? (
          <p className="muted">Загрузка…</p>
        ) : repo === null ? (
          <p>Заявки на репозиторий нет.</p>
        ) : (
          <>
            {repo.verifiedElsewhere ? (
              <div className="alert alert-bad">
                Этот репозиторий уже подтверждён за другим аккаунтом — ваша заявка подтвердиться не может. Проверьте .zoria и пишите организаторам.
              </div>
            ) : null}
            <dl className="facts">
              <dt>Репозиторий</dt>
              <dd>
                <a href={repo.url} target="_blank" rel="noopener noreferrer">{repo.url}</a>
              </dd>
              <dt>Статус</dt>
              <dd>
                <Badge tone={status?.tone ?? 'info'}>{status?.text ?? repo.accessStatus}</Badge> <code>{repo.accessStatus}</code>
              </dd>
              <dt>Причина</dt>
              <dd>
                {reasonText ?? <span className="muted">—</span>}
                {repo.reasonCode ? <div className="muted small"><code>{repo.reasonCode}</code></div> : null}
              </dd>
              <dt>Проверено</dt>
              <dd>
                <LocalTime value={repo.checkedAt} zone />
              </dd>
              <dt>Изменено</dt>
              <dd>
                <LocalTime value={repo.updatedAt} zone />
              </dd>
            </dl>
            <p className="muted small">Срок подтверждения: 06.10, 00:00 по Киеву (05.10 21:00 UTC). Не подтверждено — выбывание.</p>
          </>
        )}
      </Panel>

      <Panel title="Сменить репозиторий">
        <p className="muted small">Любой ваш частный репозиторий. После смены — заново приглашение и .zoria.</p>
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            void model.changeRepository();
          }}
        >
          <label className={`field${s.repoError ? ' has-error' : ''}`}>
            <span className="field-label">Новый репозиторий</span>
            <input value={s.repoDraft} onChange={(e) => { model.setRepoDraft(e.target.value); }} spellCheck={false} placeholder="owner/repo" />
            {s.repoError ? <span className="error">{s.repoError}</span> : <span className="hint">Статус сбросится в pending.</span>}
          </label>
          <div className="actions">
            <button type="submit" disabled={s.busy.repo === true || s.repoDraft.trim() === ''}>
              Сменить
            </button>
          </div>
        </form>
      </Panel>
    </div>
  );
}
