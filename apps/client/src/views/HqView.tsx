import { useMemo, useState } from 'react';
import { BeliefTimeline, parseJournal } from '@zoria/hq';
import { ChannelView } from './ChannelView.tsx';

/*
 * Штаб (часть 3): вера бота по такту из его дневника (`belief-N.ndjson`) и
 * профайлер канала по журналу партии (`ChannelView`).
 *
 * Состояние вкладки — своё и локальное: загруженный файл и выбранный такт
 * сетевой модели клиента не касаются. Вёрстка размечена `data-hq-*` сразу:
 * якоря, которые объявит часть 3, ставятся одной правкой.
 */

interface Loaded {
  name: string;
  timeline: BeliefTimeline;
  first: number;
  last: number;
}

export function HqView() {
  return (
    <div className="hq">
      <BeliefView />
      <ChannelView />
    </div>
  );
}

function BeliefView() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(1);

  const onFile = (file: File | undefined) => {
    if (!file) return;
    file
      .text()
      .then((text) => {
        const timeline = new BeliefTimeline(parseJournal(text));
        const span = timeline.span;
        if (!span) throw new Error('в дневнике ни одного кадра');
        setLoaded({ name: file.name, timeline, first: span[0], last: span[1] });
        setTick(span[0]);
        setError(null);
      })
      .catch((e: unknown) => {
        setLoaded(null);
        setError(e instanceof Error ? e.message : String(e));
      });
  };

  const belief = useMemo(() => loaded?.timeline.at(tick) ?? null, [loaded, tick]);

  return (
    <section className="panel" data-hq="belief">
      <h2>Штаб: вера бота</h2>
      <label className="field">
        <span>
          Дневник веры (<code>belief-N.ndjson</code>):
        </span>
        <input
          type="file"
          accept=".ndjson,application/x-ndjson,application/json"
          data-hq-input="belief"
          onChange={(e) => {
            onFile(e.target.files?.[0]);
          }}
        />
      </label>
      {error ? (
        <p className="banner banner-bad" data-hq-error="belief">
          {error}
        </p>
      ) : null}
      {loaded ? (
        <>
          <p className="muted small" data-hq-file="belief">
            {loaded.name}: такты {loaded.first}–{loaded.last}
          </p>
          <label className="field">
            Такт{' '}
            <input
              type="range"
              min={loaded.first}
              max={loaded.last}
              value={tick}
              data-hq-scrub=""
              onChange={(e) => {
                setTick(Number(e.target.value));
              }}
            />{' '}
            <output data-hq-tick="">{tick}</output>
          </label>
          {belief ? (
            <dl className="facts" data-hq-belief="">
              <dt>Заряд</dt>
              <dd data-hq-energy="">{Math.round(belief.pulse.energy)}</dd>
              <dt>Голок, известных боту</dt>
              <dd data-hq-known="">{belief.own.size}</dd>
              <dt>Из них молчат</dt>
              <dd data-hq-dark="">{belief.dark.size}</dd>
              <dt>Чужих машин на виду</dt>
              <dd data-hq-foes="">{belief.foe.length}</dd>
              <dt>Своих машин</dt>
              <dd data-hq-units="">{belief.units.length}</dd>
              <dt>Вера старше такта на</dt>
              <dd data-hq-stale="">{belief.stale}</dd>
            </dl>
          ) : (
            <p className="muted">На этом такте веры нет: до первого полного кадра дневника.</p>
          )}
        </>
      ) : null}
    </section>
  );
}
