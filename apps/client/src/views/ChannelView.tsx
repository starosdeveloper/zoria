import { useEffect, useMemo, useRef, useState } from 'react';
import { channelProfile, readRunlog, type ChannelProfile, type Runlog, type SlotLetter } from '@zoria/hq';

/*
 * Штаб, профайлер канала (Ш3): что слот подал на каждом такте и что из этого
 * отбил воротарь — прямо из журнала партии (`match-N.runlog`), без движка.
 *
 * График — один холст на всю партию: 1200 тактов в DOM-столбиках — это 1200
 * узлов на каждую смену слота, холст перерисовывается за один проход. Цвета
 * берутся из переменных темы в миг рисования, поэтому тёмная тема не требует
 * второго набора.
 */

interface Loaded {
  name: string;
  log: Runlog;
}

const SLOTS: readonly SlotLetter[] = ['A', 'B', 'C'];
const HEIGHT = 140;

export function ChannelView() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slot, setSlot] = useState<SlotLetter>('A');
  const [hover, setHover] = useState<number | null>(null);

  const onFile = (file: File | undefined) => {
    if (!file) return;
    file
      .arrayBuffer()
      .then((buf) => {
        const log = readRunlog(new Uint8Array(buf));
        setLoaded({ name: file.name, log });
        setSlot(log.bots[0] ?? 'A');
        setHover(null);
        setError(null);
      })
      .catch((e: unknown) => {
        setLoaded(null);
        setError(e instanceof Error ? e.message : String(e));
      });
  };

  const profile = useMemo(
    () => (loaded ? channelProfile(loaded.log.submits, loaded.log.denies, slot, loaded.log.ticks) : null),
    [loaded, slot],
  );
  const episodes = useMemo(
    () => loaded?.log.episodes.filter(([s]) => s === slot).map(([, from, to]) => [from, to] as const) ?? [],
    [loaded, slot],
  );
  const at = profile && hover !== null ? profile.ticks[hover - 1] : undefined;

  return (
    <section className="panel" data-hq="channel">
      <h2>Штаб: профайлер канала</h2>
      <label className="field">
        <span>
          Журнал партии (<code>match-N.runlog</code>):
        </span>
        <input
          type="file"
          accept=".runlog,application/cbor,application/octet-stream"
          data-hq-input="runlog"
          onChange={(e) => {
            onFile(e.target.files?.[0]);
          }}
        />
      </label>
      {error ? (
        <p className="banner banner-bad" data-hq-error="runlog">
          {error}
        </p>
      ) : null}
      {loaded && profile ? (
        <>
          <p className="muted small" data-hq-file="runlog">
            {loaded.name}: {loaded.log.ticks} тактов, рушій {loaded.log.engine.slice(0, 8)}…
          </p>
          <div className="hq-slots" role="radiogroup" aria-label="Слот">
            {SLOTS.map((s, i) => (
              <label key={s}>
                <input
                  type="radio"
                  name="hq-slot"
                  value={s}
                  checked={slot === s}
                  data-hq-slot={s}
                  onChange={() => {
                    setSlot(s);
                  }}
                />{' '}
                {s}
                {loaded.log.hall[i] ? ` — ${loaded.log.hall[i]}` : ''}
                {loaded.log.bots.includes(s) ? '' : ' (встроенная голова)'}
              </label>
            ))}
          </div>
          <ChannelChart profile={profile} episodes={episodes} hover={hover} onHover={setHover} />
          <p className="small" data-hq-at="">
            {at ? (
              <>
                Такт <b>{at.t}</b>: {at.bytes} байт, команд {at.commands ?? 'кадр не массив CBOR'}
                {at.denies.length
                  ? `; отказы: ${at.denies.map((d) => `№${String(d.index)} ${d.word}`).join(', ')}`
                  : ''}
              </>
            ) : (
              <span className="muted">Наведите на график — такт и его кадр.</span>
            )}
          </p>
          <dl className="facts" data-hq-totals="">
            <dt>Байт подано</dt>
            <dd data-hq-bytes="">{profile.totals.bytes}</dd>
            <dt>Команд</dt>
            <dd data-hq-commands="">{profile.totals.commands}</dd>
            <dt>Отказов воротаря</dt>
            <dd data-hq-denies="">{profile.totals.denies}</dd>
            <dt>Тактов молчания</dt>
            <dd data-hq-silent="">{profile.totals.silent}</dd>
            <dt>Кадров не по форме</dt>
            <dd data-hq-malformed="">{profile.totals.malformed}</dd>
            <dt>Тактов под наказом</dt>
            <dd data-hq-nakaz="">{episodes.reduce((n, [a, b]) => n + b - a + 1, 0)}</dd>
          </dl>
          {profile.byCode.length ? (
            <table className="table" data-hq-codes="">
              <thead>
                <tr>
                  <th>Код</th>
                  <th>Слово</th>
                  <th>Отказов</th>
                </tr>
              </thead>
              <tbody>
                {profile.byCode.map((c) => (
                  <tr key={c.code} data-hq-code={c.code}>
                    <td>{c.code}</td>
                    <td>{c.word}</td>
                    <td>{c.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted small">Воротарь не отбил ни одной команды этого слота.</p>
          )}
        </>
      ) : null}
    </section>
  );
}

interface ChartProps {
  profile: ChannelProfile;
  episodes: readonly (readonly [number, number])[];
  hover: number | null;
  onHover: (t: number | null) => void;
}

function ChannelChart({ profile, episodes, hover, onHover }: ChartProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  /* ширина холста — часть рисунка: без перерисовки на её смену такт под курсором
     и столбик под ним разъезжаются */
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    setWidth(canvas.clientWidth);
    const watch = new ResizeObserver(() => {
      setWidth(canvas.clientWidth);
    });
    watch.observe(canvas);
    return () => {
      watch.disconnect();
    };
  }, []);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || width === 0) return;
    const css = getComputedStyle(canvas);
    const color = (name: string) => css.getPropertyValue(name).trim() || '#888';
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(HEIGHT * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, HEIGHT);

    const n = profile.ticks.length;
    /* такт — целый пиксель: на дробных краях столбик в 1 px размывается в серый */
    const x = (t: number) => Math.floor(((t - 1) / n) * width);
    const step = width / n;
    const peak = Math.max(1, ...profile.ticks.map((k) => k.bytes));
    const plot = HEIGHT - 14; /* нижняя полоса — метки отказов */

    ctx.fillStyle = color('--warn-bg');
    for (const [from, to] of episodes) ctx.fillRect(x(from), 0, (to - from + 1) * step, plot);

    ctx.fillStyle = color('--info');
    for (const k of profile.ticks) {
      if (!k.bytes) continue;
      const h = (k.bytes / peak) * (plot - 4);
      ctx.fillRect(x(k.t), plot - h, Math.max(step, 1), h);
    }
    ctx.fillStyle = color('--bad');
    for (const k of profile.ticks) {
      if (k.commands === null) ctx.fillRect(x(k.t), 0, Math.max(step, 2), plot);
      if (k.denies.length) ctx.fillRect(x(k.t) - 1, plot + 3, Math.max(step, 3), 8);
    }
    ctx.strokeStyle = color('--line');
    ctx.beginPath();
    ctx.moveTo(0, plot + 0.5);
    ctx.lineTo(width, plot + 0.5);
    ctx.stroke();
    if (hover !== null) {
      ctx.strokeStyle = color('--ink');
      ctx.beginPath();
      ctx.moveTo(x(hover) + step / 2, 0);
      ctx.lineTo(x(hover) + step / 2, HEIGHT);
      ctx.stroke();
    }
  }, [profile, episodes, hover, width]);

  return (
    <canvas
      ref={ref}
      className="hq-chart"
      height={HEIGHT}
      data-hq-chart="channel"
      aria-label={`Байты кадров по тактам, слот ${profile.slot}; синие столбики — байты, красные метки снизу — отказы, жёлтый фон — наказ`}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const t = Math.floor(((e.clientX - r.left) / r.width) * profile.ticks.length) + 1;
        onHover(Math.min(Math.max(t, 1), profile.ticks.length));
      }}
      onMouseLeave={() => {
        onHover(null);
      }}
    />
  );
}
