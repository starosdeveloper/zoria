import { useEffect, useState, type ReactNode } from 'react';
import { parseRepository, type RegistrationDraft } from '@zoria/core';
import type { AppModel, Snapshot } from '../state/model.ts';
import { Badge, Panel } from '../components/common.tsx';

function Field({ label, error, hint, children }: { label: string; error: string | undefined; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className={`field${error ? ' has-error' : ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && !error ? <span className="hint">{hint}</span> : null}
      {error ? (
        <span className="error" role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}

export function RegisterView({ s, model }: { s: Snapshot; model: AppModel }) {
  const { draft, draftErrors: errors, registration, ether } = s;
  const [showPassword, setShowPassword] = useState(false);
  const update = (patch: Partial<RegistrationDraft>): void => {
    model.updateDraft(patch);
  };
  const repo = parseRepository(draft.repositoryUrl);
  const open = ether.phase === 'window';
  const sending = registration.status === 'sending';

  if (s.session) {
    return (
      <Panel title="Регистрация">
        <p>
          Вы вошли как <strong>{s.session.user.username}</strong>. Дальше — приглашение и файл <code>.zoria</code>.
        </p>
        <button type="button" className="primary" onClick={() => { model.setView('access'); }}>
          К доступу к репозиторию
        </button>
      </Panel>
    );
  }

  return (
    <div className="grid">
      <Panel
        title="Заявка"
        actions={
          open ? <Badge tone="ok">просвет открыт</Badge> : ether.phase === 'after' ? <Badge tone="bad">регистрация закрыта</Badge> : <Badge tone="muted">просвета ещё нет</Badge>
        }
      >
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            void model.submitRegistration();
          }}
        >
          <Field label="Логин" error={errors.username} hint="3–32 символа: латинская буква, затем буквы, цифры, «_», «-». Уйдёт строчными; его же пишут в .zoria.">
            <input value={draft.username} onChange={(e) => { update({ username: e.target.value }); }} autoComplete="username" spellCheck={false} />
          </Field>
          <Field label="Отображаемое имя" error={errors.displayName} hint={<strong>Его видят все в журнале выхода на связь.</strong>}>
            <input value={draft.displayName} onChange={(e) => { update({ displayName: e.target.value }); }} maxLength={80} />
          </Field>
          <Field label="Пароль" error={errors.password} hint="12–256 символов. Хранится только в памяти этой вкладки.">
            <div className="row">
              <input
                type={showPassword ? 'text' : 'password'}
                value={draft.password}
                onChange={(e) => { update({ password: e.target.value }); }}
                autoComplete="new-password"
              />
              <button type="button" className="ghost" onClick={() => { setShowPassword((v) => !v); }}>
                {showPassword ? 'скрыть' : 'показать'}
              </button>
            </div>
          </Field>
          <Field
            label="Код заявки"
            error={errors.invitation}
            hint="Одноразовый код от организаторов — пришёл на почту или в Telegram, указанные в заявке. Хранится только в памяти вкладки."
          >
            <input value={draft.invitation} onChange={(e) => { update({ invitation: e.target.value }); }} autoComplete="off" spellCheck={false} />
          </Field>
          <Field
            label="Ваш репозиторий на GitHub"
            error={errors.repositoryUrl}
            hint={
              <>
                {repo.ok ? <>Уйдёт как <code>{repo.slug}</code>. </> : 'owner/repo или адрес на github.com. '}
                <strong>Репозиторий должен быть частным:</strong> в открытый бот не заходит.
              </>
            }
          >
            <input value={draft.repositoryUrl} onChange={(e) => { update({ repositoryUrl: e.target.value }); }} spellCheck={false} />
          </Field>
          <Field label="Язык писем сервера" error={undefined}>
            <select value={draft.lang} onChange={(e) => { update({ lang: e.target.value === 'en' ? 'en' : 'uk' }); }}>
              <option value="uk">українська (uk)</option>
              <option value="en">English (en)</option>
            </select>
          </Field>

          <div className="actions">
            <button type="submit" className="primary" disabled={sending || !open}>
              {sending ? 'Отправка…' : 'Зарегистрироваться'}
            </button>
            <label className="switch">
              <input
                type="checkbox"
                checked={registration.status === 'armed'}
                disabled={sending || open}
                onChange={(e) => { model.arm(e.target.checked); }}
              />
              отправить автоматически по первому кадру просвета
            </label>
          </div>
          {registration.status === 'armed' ? (
            <p className="hint">
              Заявка заряжена. Вкладка должна оставаться открытой, эфир — включён. Для ночи надёжнее watcher (README).
            </p>
          ) : null}
        </form>
      </Panel>

      <Panel title="Журнал отправки">
        {registration.log.length === 0 ? (
          <p className="muted">Пока пусто.</p>
        ) : (
          <ol className="log">
            {registration.log.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ol>
        )}
        <p className="muted small">
          Потерянный ответ не повторяется вслепую: сначала вход с теми же логином и паролем (CL-17). Второй аккаунт — снятие с конкурса.
        </p>
      </Panel>
    </div>
  );
}

export function LoginView({ s, model }: { s: Snapshot; model: AppModel }) {
  const [username, setUsername] = useState(s.draft.username);
  const [password, setPassword] = useState('');
  // Escape and a click outside close the window: a modal that cannot be dismissed traps the
  // participant on the wrong server, where the login can only ever fail.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') model.cancelLogin();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [model]);

  const other = s.server.id === 'prod' ? 'stand' : 'prod';
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) model.cancelLogin();
      }}
    >
      <form
        className="modal"
        onSubmit={(e) => {
          e.preventDefault();
          void model.login(username, password);
        }}
      >
        <h2>Вход</h2>
        <p className="muted">Сессия закончилась или не найдена. После входа вернём на тот же экран — введённое не потеряется.</p>
        <p className="small">
          Вход на <strong>{s.server.id === 'prod' ? 'боевой сервер' : 'учебный стенд'}</strong> — <code>{s.server.apiBase}</code>. Аккаунты этих
          серверов разные.{' '}
          <button type="button" className="link" onClick={() => { model.switchServer(other); }}>
            Переключиться на {other === 'prod' ? 'боевой' : 'стенд'}
          </button>
        </p>
        <label className="field">
          <span className="field-label">Логин</span>
          <input value={username} onChange={(e) => { setUsername(e.target.value); }} autoComplete="username" autoFocus />
        </label>
        <label className="field">
          <span className="field-label">Пароль</span>
          <input type="password" value={password} onChange={(e) => { setPassword(e.target.value); }} autoComplete="current-password" />
        </label>
        {s.loginError ? <p className="error">{s.loginError}</p> : null}
        <div className="actions">
          <button type="submit" className="primary" disabled={s.busy.login === true}>
            {s.busy.login ? 'Вход…' : 'Войти'}
          </button>
          <button type="button" className="ghost" onClick={() => { model.cancelLogin(); }}>
            Отмена
          </button>
        </div>
      </form>
    </div>
  );
}
