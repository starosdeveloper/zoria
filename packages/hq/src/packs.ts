/* hq :: packs
   Сравнение пресетов (Ш4) по записям пакетов: `pack.json` (06-local-pack, 5).

   Метрика — та же, что у турнира (оценивание 7.1): средняя доля за партию,
   3 — первое место везде, 2 — середина. Рядом — статьи рахунка, из которых
   доля сложилась, и пропуски присяги (глухое место — доля 0, 24.6).

   Пресеты сравниваются только на общих долинах: одинаковые жереб и состав
   соперников. Замеры 03–04.10 показали, что набор из трёх жеребов врёт на ±3
   доли и сам по себе: разница пресетов на разных долинах — это разница долин. */

/** Поля `pack.json`, которые читает штаб. Наше место — участник 0 («ваш бот»). */
export interface PackRecord {
  seed: number;
  ticks: number;
  roster: string[];
  shares: number[];
  absent: boolean[][];
  breakdown: { total: number; network: number; orders: number; stolen: number; pactTax: number; jams: number; rams: number }[];
}

export interface PresetSummary {
  name: string;
  packs: number;
  matches: number;
  /** сумма долей нашего места и её потолок (9 на пакет) */
  shares: number;
  maxShares: number;
  /** средняя доля за партию — метрика турнира */
  meanShare: number;
  /** средние за партию статьи рахунка нашего места */
  perMatch: { total: number; network: number; orders: number; stolen: number; pactTax: number };
  /** партий, где наше место не присягнуло */
  absent: number;
}

/** Ключ долины: жереб, длина партии и соперники по порядку. */
export const valleyKey = (p: PackRecord): string => `${String(p.seed)}/${String(p.ticks)}/${p.roster.slice(1).join('+')}`;

export function summarize(name: string, packs: readonly PackRecord[]): PresetSummary {
  const n = packs.length;
  const matches = n * 3;
  let shares = 0;
  let absent = 0;
  const sum = { total: 0, network: 0, orders: 0, stolen: 0, pactTax: 0 };
  for (const p of packs) {
    shares += p.shares[0] ?? 0;
    absent += (p.absent[0] ?? []).filter(Boolean).length;
    const b = p.breakdown[0];
    if (!b) continue;
    sum.total += b.total;
    sum.network += b.network;
    sum.orders += b.orders;
    sum.stolen += b.stolen;
    sum.pactTax += b.pactTax;
  }
  const per = (x: number) => (matches ? x / matches : 0);
  return {
    name,
    packs: n,
    matches,
    shares,
    maxShares: n * 9,
    meanShare: per(shares),
    perMatch: { total: per(sum.total), network: per(sum.network), orders: per(sum.orders), stolen: per(sum.stolen), pactTax: per(sum.pactTax) },
    absent,
  };
}

export interface Comparison {
  /** долины, сыгранные обоими пресетами */
  common: string[];
  /** пресеты только по общим долинам, лучший первым */
  ranked: PresetSummary[];
  /** по долинам: доли каждого пресета */
  byValley: { valley: string; shares: Record<string, number> }[];
  /** долины, сыгранные не всеми пресетами — в сравнение не вошли */
  dropped: string[];
}

/** Сравнение пресетов по долинам, которые сыграли все. */
export function compare(presets: Readonly<Record<string, readonly PackRecord[]>>): Comparison {
  const names = Object.keys(presets);
  const sets = names.map((n) => new Map((presets[n] ?? []).map((p) => [valleyKey(p), p])));
  const all = new Set(sets.flatMap((s) => [...s.keys()]));
  const common = [...all].filter((v) => sets.every((s) => s.has(v))).sort();
  const dropped = [...all].filter((v) => !common.includes(v)).sort();
  const ranked = names
    .map((n, i) => summarize(n, common.map((v) => sets[i]?.get(v)).filter((p): p is PackRecord => p !== undefined)))
    .sort((a, b) => b.meanShare - a.meanShare || a.name.localeCompare(b.name));
  const byValley = common.map((valley) => ({
    valley,
    shares: Object.fromEntries(names.map((n, i) => [n, sets[i]?.get(valley)?.shares[0] ?? 0])),
  }));
  return { common, ranked, byValley, dropped };
}
