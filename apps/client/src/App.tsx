import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { localZoneName } from '@zoria/core';
import { AppModel, SESSION_WARN_MS, VIEWS, type Snapshot, type View } from './state/model.ts';
import { Badge, LocalTime, useNow } from './components/common.tsx';
import { EtherView } from './views/EtherView.tsx';
import { LoginView, RegisterView } from './views/RegisterView.tsx';
import { AccessView } from './views/AccessView.tsx';
import { InboxView, NewsView, RollView, StagesView } from './views/FeedViews.tsx';
import { SettingsView } from './views/SettingsView.tsx';
import { HqView } from './views/HqView.tsx';

const TAB_LABEL: Record<View, string> = {
  ether: 'Эфир',
  register: 'Регистрация',
  access: 'Доступ',
  inbox: 'Письма',
  news: 'Новости',
  stages: 'Части',
  roll: 'Журнал',
  hq: 'Штаб',
  settings: 'Настройки',
};

function Content({ s, model }: { s: Snapshot; model: AppModel }) {
  switch (s.view) {
    case 'ether':
      return <EtherView s={s} model={model} />;
    case 'register':
      return <RegisterView s={s} model={model} />;
    case 'access':
      return <AccessView s={s} model={model} />;
    case 'inbox':
      return <InboxView s={s} model={model} />;
    case 'news':
      return <NewsView s={s} model={model} />;
    case 'stages':
      return <StagesView s={s} model={model} />;
    case 'roll':
      return <RollView s={s} model={model} />;
    case 'hq':
      return <HqView />;
    case 'settings':
      return <SettingsView s={s} model={model} />;
  }
}

export function App() {
  const model = useMemo(() => new AppModel(), []);
  useEffect(() => {
    model.start();
    return () => {
      model.stop();
    };
  }, [model]);
  const s = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const now = useNow(5000);
  const expiresIn = s.session ? Date.parse(s.session.expiresAt) - (now + s.ether.clockOffsetMs) : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Зоря.нет <span className="muted">{s.server.id === 'prod' ? 'боевой' : 'стенд'}</span>
        </div>
        <nav className="tabs">
          {VIEWS.map((v) => (
            <button key={v} type="button" className={s.view === v ? 'tab active' : 'tab'} onClick={() => { model.setView(v); }}>
              {TAB_LABEL[v]}
              {v === 'inbox' && s.summary && s.summary.unread > 0 ? <span className="dot">{s.summary.unread}</span> : null}
              {v === 'stages' && s.summary && s.summary.releasedStages > s.summary.acknowledgedStages ? <span className="dot">!</span> : null}
            </button>
          ))}
        </nav>
        <div className="who">
          {s.session ? <Badge tone="ok">{s.session.user.username}</Badge> : <Badge tone="muted">не в сети</Badge>}
          <span className="muted small">{localZoneName()}</span>
        </div>
      </header>

      {s.silentUntil > now ? (
        <div className="banner banner-bad">
          Адрес заглушён: до <LocalTime value={s.silentUntil} /> клиент не отправляет ни одного запроса (CL-07).
        </div>
      ) : null}
      {expiresIn !== null && expiresIn < SESSION_WARN_MS ? (
        <div className="banner banner-warn">
          Сессия закончится через {Math.max(0, Math.round(expiresIn / 60_000))} мин.{' '}
          <button type="button" className="link" onClick={() => { model.requireLogin(); }}>
            Войти снова
          </button>
        </div>
      ) : null}
      {s.notice ? (
        <div className={`banner banner-${s.notice.tone === 'error' ? 'bad' : s.notice.tone === 'ok' ? 'ok' : 'info'}`}>
          <span>{s.notice.text}</span>
          {s.notice.requestId ? (
            <span className="small">
              {' '}
              X-Request-Id: <code>{s.notice.requestId}</code> · {s.notice.at} — добавьте в сообщение о сбое
            </span>
          ) : null}
          <button type="button" className="link" onClick={() => { model.dismissNotice(); }}>
            ✕
          </button>
        </div>
      ) : null}

      <main className="content">
        <Content s={s} model={model} />
      </main>

      {s.loginRequired ? <LoginView s={s} model={model} /> : null}
    </div>
  );
}
