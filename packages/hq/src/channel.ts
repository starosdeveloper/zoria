/* hq :: channel
   Профайлер канала (Ш3): по журналу партии — сколько байт и команд подал слот на
   каждом такте и сколько из них отбил воротарь, с кодами.

   Журнал (`.runlog`, 04-protocol 10.1) несёт кадры команд сырыми байтами
   `[такт, слот, байты]` — только непустые — и отказы воротаря `[слот, такт,
   номер команды, код]` (10.4). Кадр команд — массив CBOR (6.1), и число команд —
   длина этого массива из его же заголовка (RFC 8949, 3.1): разбирать сами
   команды профайлеру не нужно. Кадр, у которого заголовок не массив, — сам по
   себе находка: вузол такой кадр отбивает целиком (6.3). */

/** Код отказа воротаря — слово таблицы 04-protocol 6.6. */
export const DENY_WORD: Readonly<Record<number, string>> = {
  1: 'сміття',
  2: 'стеля',
  3: 'машина',
  4: 'поворот',
  5: 'тариф',
  6: 'канал',
  7: 'вуха',
  8: 'верф',
  9: 'заряд',
  10: 'вага рою',
  11: 'земля',
  12: 'немає шляху',
  13: 'не своя голка',
  14: 'спалах',
  15: 'погляд',
  16: 'таран',
  17: 'ціль',
  18: 'глушіння',
  19: 'угода',
  20: 'клич',
  21: 'відмова',
  22: 'торги',
};

/** Длина массива CBOR из заголовка кадра; null — заголовок не массив определённой длины. */
export function cborArrayLength(bytes: Uint8Array): number | null {
  const head = bytes[0];
  if (head === undefined || head >> 5 !== 4) return null;
  const info = head & 0x1f;
  if (info < 24) return info;
  const width = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : 0;
  if (width === 0 || bytes.length < 1 + width) return null; /* 27 — длина за 2^32, 31 — неопределённая (2.3 запрещает) */
  let n = 0;
  for (let i = 1; i <= width; i++) n = n * 256 + (bytes[i] ?? 0);
  return n;
}

export interface TickChannel {
  t: number;
  /** байт кадра команд; 0 — слот молчал */
  bytes: number;
  /** команд в кадре; null — кадр не массив CBOR */
  commands: number | null;
  /** отказы воротаря этого такта: номер команды в кадре → код */
  denies: { index: number; code: number; word: string }[];
}

export interface ChannelProfile {
  slot: string;
  ticks: TickChannel[];
  totals: { bytes: number; commands: number; denies: number; silent: number; malformed: number };
  /** отказы по словам, по убыванию */
  byCode: { code: number; word: string; count: number }[];
}

/** Профиль канала одного слота за такты 1..ticks. */
export function channelProfile(
  submits: readonly (readonly [number, string, Uint8Array])[],
  denies: readonly (readonly [string, number, number, number])[],
  slot: string,
  ticks: number,
): ChannelProfile {
  const frame = new Map<number, Uint8Array>();
  for (const [t, s, b] of submits) if (s === slot) frame.set(t, b);
  const denied = new Map<number, { index: number; code: number; word: string }[]>();
  for (const [s, t, index, code] of denies) {
    if (s !== slot) continue;
    const list = denied.get(t) ?? [];
    list.push({ index, code, word: DENY_WORD[code] ?? 'код ' + String(code) });
    denied.set(t, list);
  }

  const out: TickChannel[] = [];
  const totals = { bytes: 0, commands: 0, denies: 0, silent: 0, malformed: 0 };
  const codes = new Map<number, number>();
  for (let t = 1; t <= ticks; t++) {
    const b = frame.get(t);
    const commands = b ? cborArrayLength(b) : 0;
    const d = denied.get(t) ?? [];
    out.push({ t, bytes: b?.length ?? 0, commands, denies: d });
    totals.bytes += b?.length ?? 0;
    if (commands === null) totals.malformed++;
    else totals.commands += commands;
    if (!b) totals.silent++;
    totals.denies += d.length;
    for (const x of d) codes.set(x.code, (codes.get(x.code) ?? 0) + 1);
  }
  const byCode = [...codes]
    .map(([code, count]) => ({ code, word: DENY_WORD[code] ?? 'код ' + String(code), count }))
    .sort((a, b) => b.count - a.count || a.code - b.code);
  return { slot, ticks: out, totals, byCode };
}
