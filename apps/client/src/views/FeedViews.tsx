import type { Message, Notice } from '@zoria/core';
import type { AppModel, Snapshot } from '../state/model.ts';
import { Badge, LocalTime, Markdown, Panel } from '../components/common.tsx';

function NoticeCard({ notice }: { notice: Notice }) {
  if (notice.type !== 'repository') return null;
  const tone = notice.accessStatus === 'verified' ? 'ok' : notice.accessStatus === 'needs-attention' ? 'bad' : 'warn';
  return (
    <div className="notice-card">
      <Badge tone={tone}>{notice.accessStatus}</Badge> <a href={notice.url} target="_blank" rel="noopener noreferrer">{notice.url}</a>
      {notice.reason ? <p>{notice.reason}</p> : null}
      {notice.reasonCode ? <code className="small">{notice.reasonCode}</code> : null}
    </div>
  );
}

function MessageBody({ m, model, busy }: { m: Message; model: AppModel; busy: boolean }) {
  return (
    <article className="message">
      <header>
        <h3>{m.title}</h3>
        <div className="muted small">
          <LocalTime value={m.createdAt} zone /> · {m.kind === 'stage' ? 'выдана часть задания' : 'письмо'}
          {m.readAt ? (
            <>
              {' '}· прочитано <LocalTime value={m.readAt} />
            </>
          ) : null}
        </div>
      </header>
      {/* CL-29: a known notice renders as a card; an unknown type falls back to the plain letter below. */}
      {m.notice ? <NoticeCard notice={m.notice} /> : null}
      <Markdown source={m.body} />
      <div className="actions">
        {m.readAt === null ? (
          <button type="button" onClick={() => { void model.markRead(m.id); }} disabled={busy}>
            Отметить прочитанным
          </button>
        ) : null}
        {m.stageId ? (
          <button type="button" className="ghost" onClick={() => { model.setView('stages'); void model.openStage(m.stageId ?? ''); }}>
            Открыть часть
          </button>
        ) : null}
        <button type="button" className="ghost" onClick={() => { model.closeMessage(); }}>
          Закрыть
        </button>
      </div>
    </article>
  );
}

export function InboxView({ s, model }: { s: Snapshot; model: AppModel }) {
  if (!s.session) return <NeedLogin model={model} />;
  const open = s.openMessage;
  return (
    <div className="split">
      <Panel
        title={`Письма${s.summary ? ` · непрочитанных ${s.summary.unread}` : ''}`}
        actions={<button type="button" className="ghost" onClick={() => { void model.refreshInbox(); }} disabled={s.busy.inbox === true}>обновить</button>}
      >
        {s.inbox === null ? (
          <p className="muted">Загрузка…</p>
        ) : s.inbox.length === 0 ? (
          <p className="muted">Писем нет.</p>
        ) : (
          <ul className="list">
            {s.inbox.map((m) => (
              <li key={m.id} className={`${m.readAt ? '' : 'unread'}${open?.id === m.id ? ' active' : ''}`}>
                <button type="button" className="list-item" onClick={() => { void model.openMessage(m.id); }}>
                  <span className="title">{m.title}</span>
                  <span className="muted small">
                    <LocalTime value={m.createdAt} />
                    {m.notice?.type === 'repository' ? ` · ${m.notice.accessStatus}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <div>{open ? <MessageBody m={open} model={model} busy={s.busy[`read:${open.id}`] === true} /> : <p className="muted pad">Выберите письмо.</p>}</div>
    </div>
  );
}

export function NewsView({ s, model }: { s: Snapshot; model: AppModel }) {
  if (!s.session) return <NeedLogin model={model} />;
  return (
    <Panel title="Новости" actions={<button type="button" className="ghost" onClick={() => { void model.refreshNews(); }} disabled={s.busy.news === true}>обновить</button>}>
      {s.news === null ? (
        <p className="muted">Загрузка…</p>
      ) : s.news.length === 0 ? (
        <p className="muted">Новостей нет.</p>
      ) : (
        s.news
          .filter((n) => n.archivedAt === null)
          .map((n) => (
            <article key={n.id} className="message">
              <header>
                <h3>{n.title}</h3>
                <div className="muted small">
                  <LocalTime value={n.publishedAt ?? n.createdAt} zone />
                  {n.updatedAt !== n.createdAt ? (
                    <>
                      {' '}· правка <LocalTime value={n.updatedAt} />
                    </>
                  ) : null}
                </div>
              </header>
              <Markdown source={n.body} />
            </article>
          ))
      )}
    </Panel>
  );
}

export function StagesView({ s, model }: { s: Snapshot; model: AppModel }) {
  if (!s.session) return <NeedLogin model={model} />;
  return (
    <div className="grid">
      <Panel
        title={`Части задания${s.summary ? ` · выдано ${s.summary.releasedStages}, подтверждено ${s.summary.acknowledgedStages}` : ''}`}
        actions={<button type="button" className="ghost" onClick={() => { void model.refreshStages(); }} disabled={s.busy.stages === true}>обновить</button>}
      >
        {s.stages === null ? (
          <p className="muted">Загрузка…</p>
        ) : s.stages.length === 0 ? (
          <p className="muted">Частей пока нет. Часть 2 — 28.09.2026; появится здесь сама.</p>
        ) : (
          <ul className="list">
            {s.stages.map((st) => (
              <li key={st.id}>
                <button type="button" className="list-item" onClick={() => { void model.openStage(st.id); }}>
                  <span className="title">
                    {st.position}. {st.title} {st.errataAt ? <Badge tone="warn">уточнение</Badge> : null}{' '}
                    {st.acknowledgedAt ? <Badge tone="ok">получено</Badge> : null}
                  </span>
                  {st.excerpt ? <span className="muted small">{st.excerpt}</span> : null}
                  <span className="muted small">
                    выдана <LocalTime value={st.releasedAt} zone />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {Object.values(s.stageDetails)
        .sort((a, b) => a.position - b.position)
        .map((st) => (
          <Panel key={st.id} title={`${st.position}. ${st.title}`}>
            {st.errata ? (
              <aside className="errata">
                <strong>Уточнение</strong> <LocalTime value={st.errataAt} zone />
                <Markdown source={st.errata} />
              </aside>
            ) : null}
            <Markdown source={st.body} />
            <div className="actions">
              {st.acknowledgedAt ? (
                <span className="muted">
                  Получение подтверждено <LocalTime value={st.acknowledgedAt} zone />
                </span>
              ) : (
                <button type="button" className="primary" onClick={() => { void model.ackStage(st.id); }} disabled={s.busy[`ack:${st.id}`] === true}>
                  Подтвердить получение
                </button>
              )}
            </div>
          </Panel>
        ))}
    </div>
  );
}

export function RollView({ s, model }: { s: Snapshot; model: AppModel }) {
  const roll = s.ether.roll;
  const me = s.session?.user;
  return (
    <Panel
      title={`Журнал выхода на связь${s.ether.onAir !== null ? ` · ${s.ether.onAir}` : ''}`}
      actions={<button type="button" className="ghost" onClick={() => { void model.refreshRoll(); }} disabled={s.busy.roll === true}>обновить (≤ 1/мин)</button>}
    >
      {roll === null ? (
        <p className="muted">Журнал ещё не получен.</p>
      ) : roll.length === 0 ? (
        <p className="muted">Журнал пуст.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th className="num">№</th>
              <th>Время</th>
              <th className="num">от открытия</th>
              <th>Имя</th>
            </tr>
          </thead>
          <tbody>
            {roll.map((r) => {
              const mine = me !== undefined && (r.at === me.createdAt || r.name === me.displayName);
              return (
                <tr key={r.n} className={mine ? 'mine' : ''}>
                  <td className="num">{r.n}</td>
                  <td>
                    <LocalTime value={r.at} />
                  </td>
                  <td className="num">{r.sinceOpen} с</td>
                  <td>
                    {r.name} {mine ? <Badge tone="ok">вы</Badge> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function NeedLogin({ model }: { model: AppModel }) {
  return (
    <Panel>
      <p>Нужен вход.</p>
      <button type="button" className="primary" onClick={() => { model.requireLogin(); }}>
        Войти
      </button>
    </Panel>
  );
}
