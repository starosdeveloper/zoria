import type { Summary } from '../api/types.ts';

export type RefreshTarget = 'inbox' | 'stages' | 'news' | 'repository';

/**
 * What to re-read after a summary poll (CL-27):
 * unread → /inbox then /stages; latestNews → /news; releasedStages → /stages; repositoryAt → /me/repository.
 * With no previous summary everything is read once.
 */
export function diffSummary(prev: Summary | null, next: Summary): RefreshTarget[] {
  if (prev === null) return ['inbox', 'stages', 'news', 'repository'];
  const out = new Set<RefreshTarget>();
  if (prev.unread !== next.unread) {
    out.add('inbox');
    out.add('stages');
  }
  if (prev.latestNews !== next.latestNews) out.add('news');
  if (prev.releasedStages !== next.releasedStages || prev.acknowledgedStages !== next.acknowledgedStages) out.add('stages');
  if (prev.repositoryAt !== next.repositoryAt) out.add('repository');
  // Keep the documented order: inbox before stages.
  return (['inbox', 'stages', 'news', 'repository'] as const).filter((t) => out.has(t));
}
