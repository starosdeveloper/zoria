import type { Failure, Result } from '../api/result.ts';

export type PageFetcher<T> = (offset: number) => Promise<Result<{ items: T[]; nextOffset: number | null }>>;

/** Safety bounds: 1 000 000 is the server's offset ceiling; restarts cap a list that keeps moving. */
const MAX_PAGES = 200;
const MAX_RESTARTS = 3;

/**
 * Reads a list page by page until `nextOffset: null`, de-duplicated by `id` (CL-28).
 * If an id from an earlier page shows up again, new items were inserted mid-way and the
 * pages shifted: start over from offset 0.
 */
export async function fetchAllPages<T extends { id: string }>(
  fetchPage: PageFetcher<T>,
): Promise<{ ok: true; items: T[] } | { ok: false; error: Failure }> {
  for (let restart = 0; restart <= MAX_RESTARTS; restart++) {
    const seen = new Map<string, T>();
    let offset: number | null = 0;
    let shifted = false;
    for (let page = 0; offset !== null && page < MAX_PAGES; page++) {
      const result = await fetchPage(offset);
      if (!result.ok) return result;
      for (const item of result.data.items) {
        if (seen.has(item.id)) shifted = true;
        else seen.set(item.id, item);
      }
      if (shifted) break;
      const next: number | null = result.data.nextOffset;
      // A server offset that does not advance would loop forever.
      offset = next !== null && next > offset ? next : null;
    }
    if (!shifted) return { ok: true, items: [...seen.values()] };
  }
  return { ok: false, error: { kind: 'foreign', status: 200, requestId: null } };
}
