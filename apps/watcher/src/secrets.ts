import { checkInvitation, checkPassword } from '@zoria/core';
import { isExposed, readIfExists } from './files.ts';

export interface Secrets {
  password: string;
  invitation: string;
}

export type SecretsResult = { ok: true; secrets: Secrets } | { ok: false; problems: string[] };

/** KEY=VALUE lines; `#` comments and blank lines skipped; optional surrounding quotes removed. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

/**
 * Password and one-time code are read at the moment they are needed, not at start:
 * the code arrives days after the watcher is installed, and filling the file must not
 * require a restart. Order: the 0600 secrets file (fresh on every call), then the process
 * environment, then the values inlined in watcher.json. The file wins over the environment
 * because an environment loaded at start is a stale copy of that same file.
 * `login` needs only the password; `register` also needs the code.
 */
export function resolveSecrets(file: string, inline: Partial<Secrets>, purpose: 'register' | 'login' = 'register'): SecretsResult {
  const problems: string[] = [];
  let fromFile: Record<string, string> = {};
  const text = readIfExists(file);
  if (text !== null) {
    if (isExposed(file)) problems.push(`${file} доступен другим пользователям: chmod 600 ${file}`);
    else fromFile = parseEnvFile(text);
  }
  const pick = (env: string, key: keyof Secrets): string => fromFile[env] || process.env[env] || inline[key] || '';
  // A password is taken byte for byte; only the code is trimmed (it is pasted from a message).
  const password = pick('ZORIA_PASSWORD', 'password');
  const invitation = pick('ZORIA_INVITATION', 'invitation').trim();

  const passwordError = checkPassword(password);
  if (passwordError) problems.push(`пароль: ${passwordError}`);
  const invitationError = purpose === 'register' ? checkInvitation(invitation) : null;
  if (invitationError) problems.push(`код заявки: ${invitationError}`);
  return problems.length === 0 ? { ok: true, secrets: { password, invitation } } : { ok: false, problems };
}
