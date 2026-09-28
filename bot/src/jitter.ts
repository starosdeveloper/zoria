/* bot :: jitter
   перше з'єднання з вузлом: повний джитер поверх експоненційного відкату
   (full jitter) - той самий закон, що в connectBot для повернень
   (04-protocol.md, розділ 8).

   Перша спроба - негайно. Кожна наступна чекає рівномірно
   [0, min(стеля, база * 2^n)), база - третина стелі. Саме рівномірно від
   нуля: константа плюс невеликий розкид стадо не розводить, а зсуває
   цілком. Боти встають разом, і якщо лобі ще не відкрито, ломляться в нього
   всі одразу - рівно той випадок, заради якого закон. */

export function backoffMs(attempt: number, ceilMs: number, rnd: () => number = Math.random): number {
  const base = Math.max(1, Math.round(ceilMs / 3));
  const cap = Math.min(ceilMs, base * Math.pow(2, attempt));
  return Math.floor(rnd() * cap);
}

/* повторювати варто лише мережу: сокет не піднявся або закрився до
   присяги кодом транспорту (менше 4000). Коди застосунку 4000-4999 -
   вердикт вузла (печатка чужа, слот зайнятий), піни і маніфест -
   несумісність; повтор їх не лікує. Розбір за текстом помилки connectBot
   (англійською, як її пише SDK): структурного коду вона не несе, тому список
   повторюваного білий, а не чорний */
export function retryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.startsWith('wire did not come up')) return true;
  const m = /^wire closed before the oath, code (\d+)/.exec(msg);
  return m !== null && Number(m[1]) < 4000;
}

export interface RetryOpts {
  tries: number;
  ceilMs: number;
  rnd?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, waitMs: number, err: unknown) => void;
}

export async function withJitter<T>(o: RetryOpts, attempt: () => Promise<T>): Promise<T> {
  const sleep = o.sleep ?? ((ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms)));
  for (let n = 0; ; n++) {
    try {
      return await attempt();
    } catch (e) {
      if (n + 1 >= o.tries || !retryable(e)) throw e;
      const wait = backoffMs(n, o.ceilMs, o.rnd);
      o.onRetry?.(n + 1, wait, e);
      await sleep(wait);
    }
  }
}
