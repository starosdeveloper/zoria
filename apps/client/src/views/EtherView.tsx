import { formatDuration, localZoneName, voiceLine } from '@zoria/core';
import type { AppModel, Snapshot } from '../state/model.ts';
import { Badge, LocalTime, Panel, useNow } from '../components/common.tsx';

const PHASE_LABEL = {
  unknown: 'нет сигнала',
  static: 'шум',
  window: 'просвет',
  after: 'после просвета',
} as const;

const NOISE_LABEL = {
  signal: 'сигнал',
  stale: 'эхо / задержка',
  malformed: 'битый кадр',
  'bad-seal': 'подделка',
  'unknown-key': 'чужой ключ',
  'bad-frame': 'кадр не по схеме',
  transport: 'обрыв / тайм-аут',
  silent: 'узел молчит (503)',
} as const;

export function EtherView({ s, model }: { s: Snapshot; model: AppModel }) {
  const now = useNow();
  const { ether } = s;
  const serverNow = now + ether.clockOffsetMs;
  const toOpen = ether.opensAtMs === null ? null : ether.opensAtMs - serverNow;
  const toClose = ether.window ? Date.parse(ether.window.closesAt) - serverNow : null;
  const letter = ether.fragmentsOf
    ? Array.from({ length: ether.fragmentsOf }, (_, i) => ether.fragments.get(i + 1) ?? '░░░')
    : [];

  return (
    <div className="grid">
      <Panel
        title="Эфир"
        actions={
          <label className="switch">
            <input type="checkbox" checked={s.listening} onChange={(e) => { model.setListening(e.target.checked); }} />
            слушать
          </label>
        }
      >
        <div className="phase">
          <span className={`phase-dot phase-${ether.phase}`} />
          <strong>{ether.phase === 'unknown' && ether.silentNode ? 'узел молчит' : PHASE_LABEL[ether.phase]}</strong>
          {ether.latestAt ? (
            <span className="muted">
              последний кадр: <LocalTime value={ether.latestAt} />
            </span>
          ) : null}
        </div>

        {ether.silentNode ? (
          <p className="muted">
            Сервер отвечает <code>{ether.silentNode.code}</code>: узел ещё не в эфире или перезапускается. Это не сбой клиента —
            повторяем {ether.silentNode.retryAfterSec !== null ? `раз в ${Math.max(15, ether.silentNode.retryAfterSec)} с` : 'с паузой'}. Молчит с{' '}
            <LocalTime value={ether.silentNode.sinceLocalMs} />.
          </p>
        ) : null}

        {ether.phase === 'static' && toOpen !== null ? (
          <div className="countdown">
            <div className="label">Провозвестник: просвет откроется</div>
            <div className="big">{toOpen > 0 ? formatDuration(toOpen) : 'сейчас'}</div>
            <div>
              <LocalTime value={ether.opensAtMs} zone />
            </div>
            {voiceLine(ether.harbinger?.text ?? null) ? <blockquote className="voice">{voiceLine(ether.harbinger?.text ?? null)}</blockquote> : null}
          </div>
        ) : null}

        {ether.phase === 'static' && toOpen === null && ether.latestAt ? (
          <p className="muted">
            Провозвестника нет: ближайшие 6 часов просвета не будет. Время по часам сервера, показ — {localZoneName()}.
          </p>
        ) : null}

        {ether.window ? (
          <div className="countdown">
            <div className="label">{ether.phase === 'window' ? 'Просвет открыт, закроется через' : 'Просвет был'}</div>
            {ether.phase === 'window' && toClose !== null ? <div className="big">{formatDuration(toClose)}</div> : null}
            <div>
              <LocalTime value={ether.window.opensAt} /> — <LocalTime value={ether.window.closesAt} zone />
            </div>
            {ether.phase === 'window' && !s.session ? (
              <button type="button" className="primary" onClick={() => { model.setView('register'); }}>
                К регистрации
              </button>
            ) : null}
          </div>
        ) : null}

        <dl className="facts">
          <dt>В журнале</dt>
          <dd>{ether.onAir ?? '—'}</dd>
          <dt>Поправка часов</dt>
          <dd>{ether.latestAt ? `${(ether.clockOffsetMs / 1000).toFixed(1)} с` : '—'}</dd>
          <dt>Ключ печати</dt>
          <dd>
            {s.key ? (
              <>
                <code>{s.key.id}</code> {s.key.trust === 'pinned' ? <Badge tone="ok">сверен с ТЗ</Badge> : <Badge tone="warn">не сверен с ТЗ</Badge>}
              </>
            ) : ether.silentNode ? (
              <Badge tone="muted">придёт, когда узел выйдет в эфир</Badge>
            ) : (
              <Badge tone="bad">{s.keyError ?? 'загрузка…'}</Badge>
            )}
          </dd>
        </dl>
      </Panel>

      <Panel title="Что приходит">
        <table className="counters">
          <tbody>
            {(Object.keys(NOISE_LABEL) as (keyof typeof NOISE_LABEL)[]).map((k) => (
              <tr key={k}>
                <td>{NOISE_LABEL[k]}</td>
                <td className="num">{ether.counters[k]}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">Действуем только по кадрам с верной печатью. Ответы без печати до просвета — шум (CL-02).</p>
      </Panel>

      {letter.length > 0 ? (
        <Panel title={`Письмо Смотрителя: ${ether.fragments.size} из ${ether.fragmentsOf ?? 0}`}>
          <p className="letter">{letter.join(' ')}</p>
        </Panel>
      ) : null}
    </div>
  );
}
