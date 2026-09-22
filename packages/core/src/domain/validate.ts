// Field rules from client spec §5.6 (редакция 22.09, OpenAPI 1.1.0), checked before sending (CL-13, CL-14).

export const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_-]{2,31}$/;
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;
export const DISPLAY_NAME_MAX = 80;
export const REPOSITORY_URL_MAX = 256;
/** One-time application code (`invitation`, OpenAPI 1.1.0: maxLength 100). */
export const INVITATION_MAX = 100;

export type FieldError = string | null;

/** Length in Unicode code points, as the server counts characters. */
function codePoints(value: string): number {
  let n = 0;
  for (const _ of value) n++;
  return n;
}

export function checkUsername(value: string): FieldError {
  if (value.length === 0) return 'Введите логин.';
  if (!USERNAME_RE.test(value))
    return 'Логин: 3–32 символа, латинская буква в начале, дальше латинские буквы, цифры, «_» и «-».';
  return null;
}

export function checkDisplayName(value: string): FieldError {
  if (value.length === 0) return 'Введите отображаемое имя.';
  if (codePoints(value) > DISPLAY_NAME_MAX) return `Не длиннее ${DISPLAY_NAME_MAX} символов.`;
  if (value !== value.trim()) return 'Без пробелов в начале и в конце.';
  if (/[\n\r\t]/.test(value)) return 'Без переводов строки и табуляции.';
  return null;
}

/** Login is case-insensitive and stored lowercase; the 1.1.0 schema pattern is lowercase-only. */
export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function checkInvitation(value: string): FieldError {
  const code = value.trim();
  if (code.length === 0) return 'Введите код заявки из письма или сообщения организаторов.';
  if (codePoints(code) > INVITATION_MAX) return `Код заявки не длиннее ${INVITATION_MAX} символов.`;
  return null;
}

export function checkPassword(value: string): FieldError {
  const length = codePoints(value);
  if (length < PASSWORD_MIN) return `Пароль не короче ${PASSWORD_MIN} символов.`;
  if (length > PASSWORD_MAX) return `Пароль не длиннее ${PASSWORD_MAX} символов.`;
  return null;
}

export type RepoParse =
  | { ok: true; slug: string }
  | { ok: false; reason: 'empty' | 'too-long' | 'not-github' | 'not-root' | 'invalid' };

const OWNER = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})';
const NAME = '[A-Za-z0-9._-]{1,100}';
const BARE_RE = new RegExp(`^(${OWNER})/(${NAME})$`);
const SSH_RE = new RegExp(`^git@github\\.com:(${OWNER})/(${NAME})/?$`, 'i');
const HOST_RE = /^(?:https?:\/\/)?(?:www\.)?github\.com(?=[/?#]|$)(.*)$/i;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function slugOf(owner: string, name: string): RepoParse {
  const repo = name.replace(/\.git$/i, '');
  if (repo.length === 0 || repo === '.' || repo === '..') return { ok: false, reason: 'invalid' };
  return { ok: true, slug: `${owner}/${repo}` };
}

/**
 * Accepts `owner/repo`, github.com URLs with or without scheme and `www.`, SSH form,
 * trailing `.git` or `/`. Links inside a repository (file, branch, tab, `?`, `#`) are
 * rejected as not-root so the participant is asked for the repository itself.
 */
export function parseRepository(input: string): RepoParse {
  const value = input.trim();
  if (value.length === 0) return { ok: false, reason: 'empty' };
  if (value.length > REPOSITORY_URL_MAX) return { ok: false, reason: 'too-long' };

  const ssh = SSH_RE.exec(value);
  if (ssh?.[1] && ssh[2]) return slugOf(ssh[1], ssh[2]);

  const host = HOST_RE.exec(value);
  if (host) {
    const rest = host[1] ?? '';
    if (/[?#]/.test(rest)) return { ok: false, reason: 'not-root' };
    const segments = rest.split('/').filter((s) => s.length > 0);
    if (segments.length > 2) return { ok: false, reason: 'not-root' };
    if (segments.length < 2 || rest.includes('//')) return { ok: false, reason: 'invalid' };
    const match = BARE_RE.exec(`${segments[0] ?? ''}/${segments[1] ?? ''}`);
    return match?.[1] && match[2] ? slugOf(match[1], match[2]) : { ok: false, reason: 'invalid' };
  }

  if (SCHEME_RE.test(value) || value.startsWith('git@') || /^[^/]+\.[a-z]{2,}\//i.test(value)) {
    return { ok: false, reason: 'not-github' };
  }

  const bare = BARE_RE.exec(value.replace(/\/$/, ''));
  if (bare?.[1] && bare[2]) return slugOf(bare[1], bare[2]);
  if (/[?#]/.test(value) || value.split('/').filter(Boolean).length > 2) return { ok: false, reason: 'not-root' };
  return { ok: false, reason: 'invalid' };
}

export function checkRepository(value: string): FieldError {
  const parsed = parseRepository(value);
  if (parsed.ok) return null;
  switch (parsed.reason) {
    case 'empty':
      return 'Укажите свой частный репозиторий: owner/repo или адрес на github.com.';
    case 'too-long':
      return `Адрес не длиннее ${REPOSITORY_URL_MAX} символов.`;
    case 'not-github':
      return 'Нужен репозиторий на github.com.';
    case 'not-root':
      return 'Это ссылка внутрь репозитория. Нужен адрес самого репозитория: owner/repo.';
    case 'invalid':
      return 'Не похоже на адрес репозитория. Формат: owner/repo.';
  }
}

export interface RegistrationDraft {
  username: string;
  displayName: string;
  password: string;
  /** One-time code from the organizers; kept in memory only, like the password. */
  invitation: string;
  repositoryUrl: string;
  lang: 'uk' | 'en';
}

export type DraftErrors = Partial<Record<keyof RegistrationDraft, string>>;

export function checkDraft(draft: RegistrationDraft): DraftErrors {
  const errors: DraftErrors = {};
  const set = (key: keyof RegistrationDraft, error: FieldError): void => {
    if (error !== null) errors[key] = error;
  };
  set('username', checkUsername(normalizeUsername(draft.username)));
  set('displayName', checkDisplayName(draft.displayName));
  set('password', checkPassword(draft.password));
  set('invitation', checkInvitation(draft.invitation));
  set('repositoryUrl', checkRepository(draft.repositoryUrl));
  return errors;
}

/** Map a server error code to the form field it belongs to, when `field` is absent. */
export function fieldForCode(code: string, field: string | null): keyof RegistrationDraft | null {
  const known: readonly string[] = ['username', 'displayName', 'password', 'invitation', 'repositoryUrl', 'lang'];
  if (field !== null && known.includes(field)) return field as keyof RegistrationDraft;
  if (field === 'url') return 'repositoryUrl';
  if (code === 'username-unavailable') return 'username';
  if (code === 'invalid-invitation') return 'invitation';
  if (code.startsWith('repository-') || code === 'invalid-repository') return 'repositoryUrl';
  return null;
}
