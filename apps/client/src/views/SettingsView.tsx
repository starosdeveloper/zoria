import { useState } from 'react';
import { DEFAULT_SERVERS, localZoneName, type ServerId } from '@zoria/core';
import type { AppModel, Snapshot } from '../state/model.ts';
import { Badge, BreakableUrl, LocalTime, Panel, useNow } from '../components/common.tsx';

export function SettingsView({ s, model }: { s: Snapshot; model: AppModel }) {
  const now = useNow(5000);
  const [permission, setPermission] = useState(() => ('Notification' in window ? Notification.permission : 'denied'));
  return (
    <div className="grid">
      <Panel title="Сервер">
        <div className="radio-group">
          {(Object.keys(DEFAULT_SERVERS) as ServerId[]).map((id) => (
            <label key={id} className="radio">
              <input type="radio" name="server" checked={s.server.id === id} onChange={() => { model.switchServer(id); }} />
              {DEFAULT_SERVERS[id].label}
            </label>
          ))}
        </div>
        <dl className="facts">
          <dt>Адрес API</dt>
          <dd>
            <BreakableUrl url={s.server.apiBase} />
          </dd>
          <dt>Отпечаток из ТЗ</dt>
          <dd>{s.server.fingerprint ? <code className="wrap">{s.server.fingerprint}</code> : <Badge tone="warn">не задан (.env)</Badge>}</dd>
          <dt>Ключ сервера</dt>
          <dd>
            {s.key ? <code className="wrap">{s.key.fingerprint}</code> : s.ether.silentNode ? 'придёт, когда узел выйдет в эфир' : (s.keyError ?? '—')}
          </dd>
          <dt>Часовой пояс</dt>
          <dd>{localZoneName()}</dd>
          <dt>Глушение</dt>
          <dd>{s.silentUntil > now ? <>молчим до <LocalTime value={s.silentUntil} /></> : 'нет'}</dd>
        </dl>
      </Panel>

      <Panel title="Аккаунт">
        {s.session ? (
          <>
            <dl className="facts">
              <dt>Логин</dt>
              <dd>
                <code>{s.session.user.username}</code>
              </dd>
              <dt>Имя в журнале</dt>
              <dd>{s.session.user.displayName}</dd>
              <dt>Сессия до</dt>
              <dd>
                <LocalTime value={s.session.expiresAt} zone />
              </dd>
              <dt>Язык писем</dt>
              <dd>
                <select
                  value={s.session.user.lang}
                  disabled={s.busy.lang === true}
                  onChange={(e) => { void model.setLang(e.target.value === 'en' ? 'en' : 'uk'); }}
                >
                  <option value="uk">українська (uk)</option>
                  <option value="en">English (en)</option>
                </select>
              </dd>
            </dl>
            <p className="muted small">Язык переводит уведомления сервера и причины решения по репозиторию; новости и части не переводятся.</p>
            <div className="actions">
              <button type="button" onClick={() => { void model.developerCheck(); }} disabled={s.busy.devcheck === true}>
                Проверить обмен
              </button>
              <button type="button" className="danger" onClick={() => { void model.logout(); }}>
                Выйти
              </button>
            </div>
          </>
        ) : (
          <button type="button" className="primary" onClick={() => { model.requireLogin(); }}>
            Войти
          </button>
        )}
      </Panel>

      <Panel title="Уведомления браузера">
        <p className="muted small">Локальные уведомления о новой части задания и смене статуса доступа. Работают, пока вкладка открыта.</p>
        {permission === 'granted' ? (
          <Badge tone="ok">включены</Badge>
        ) : (
          <button
            type="button"
            disabled={permission === 'denied'}
            onClick={() => {
              void Notification.requestPermission().then(setPermission);
            }}
          >
            {permission === 'denied' ? 'запрещены в браузере' : 'Разрешить'}
          </button>
        )}
      </Panel>
    </div>
  );
}
