import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Secrets } from './secrets.ts';
import {
  checkDisplayName,
  checkRepository,
  checkUsername,
  DEFAULT_SERVERS,
  isServerId,
  normalizeUsername,
  normalizeFingerprint,
  parseRepository,
  tryParseJson,
  type Lang,
  type ServerId,
} from '@zoria/core';
import { isExposed, readIfExists } from './files.ts';

export interface WatcherConfig {
  server: ServerId;
  apiBase: string;
  fingerprint: string | null;
  /** `watch` only listens and alerts; `register` also sends the prepared application. */
  mode: 'watch' | 'register';
  account: AccountProfile | null;
  /** 0600 file with ZORIA_PASSWORD / ZORIA_INVITATION, re-read whenever the secrets are needed. */
  secretsFile: string;
  notify: { url: string | null; telegram: { botToken: string; chatId: string } | null; desktop: boolean };
  stateDir: string;
  configPath: string;
}

/** Everything about the account except the secrets, which are resolved lazily (secrets.ts). */
export interface AccountProfile {
  username: string;
  displayName: string;
  repositoryUrl: string;
  lang: Lang;
  inline: Partial<Secrets>;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function defaultConfigPath(): string {
  return process.env.ZORIA_WATCHER_CONFIG ?? join(homedir(), '.config', 'zoria', 'watcher.json');
}

function expandHome(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

function field(obj: Record<string, unknown>, key: string): unknown {
  return obj[key];
}

function optString(obj: Record<string, unknown>, key: string): string | null {
  const v = field(obj, key);
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new ConfigError(`"${key}" должен быть строкой`);
  return v;
}

/**
 * Loads and validates the watcher config. Password and one-time application code are not
 * required here: they live in the secrets file or environment and are read when used. Nothing here is ever written into the repository.
 */
export function loadConfig(path = defaultConfigPath()): WatcherConfig {
  const configPath = resolve(expandHome(path));
  const raw = readIfExists(configPath);
  if (raw === null) throw new ConfigError(`нет файла конфигурации ${configPath} (образец: apps/watcher/watcher.example.json)`);
  const parsed = tryParseJson(raw);
  if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
    throw new ConfigError(`${configPath}: не JSON-объект`);
  }
  const obj = parsed.value as Record<string, unknown>;

  const server = field(obj, 'server') ?? 'stand';
  if (!isServerId(server)) throw new ConfigError('"server": "prod" или "stand"');
  const apiBase = (optString(obj, 'apiBase') ?? DEFAULT_SERVERS[server].apiBase).replace(/\/+$/, '');

  const fpRaw = optString(obj, 'fingerprint');
  const fingerprint = normalizeFingerprint(fpRaw);
  if (fpRaw !== null && fingerprint === null) throw new ConfigError('"fingerprint": 64 шестнадцатеричных символа (SHA-256 ключа печати из ТЗ)');

  const mode = field(obj, 'mode') ?? 'watch';
  if (mode !== 'watch' && mode !== 'register') throw new ConfigError('"mode": "watch" или "register"');

  let account: AccountProfile | null = null;
  const acc = field(obj, 'account');
  if (acc !== undefined && acc !== null) {
    if (typeof acc !== 'object' || Array.isArray(acc)) throw new ConfigError('"account" должен быть объектом');
    const a = acc as Record<string, unknown>;
    const inlinePassword = optString(a, 'password');
    const inlineInvitation = optString(a, 'invitation');
    if ((inlinePassword !== null || inlineInvitation !== null) && isExposed(configPath)) {
      throw new ConfigError(`${configPath} содержит пароль или код заявки и доступен другим пользователям: chmod 600 ${configPath}`);
    }
    const langRaw = optString(a, 'lang') ?? 'uk';
    if (langRaw !== 'uk' && langRaw !== 'en') throw new ConfigError('"account.lang": "uk" или "en"');
    const lang: Lang = langRaw;
    const username = normalizeUsername(optString(a, 'username') ?? '');
    const displayName = optString(a, 'displayName') ?? '';
    const repositoryUrl = optString(a, 'repositoryUrl') ?? '';
    // Secrets are checked when they are used (secrets.ts), not here: the code may arrive later.
    const first = [
      ['username', checkUsername(username)],
      ['displayName', checkDisplayName(displayName)],
      ['repositoryUrl', checkRepository(repositoryUrl)],
    ].find(([, error]) => error !== null);
    if (first) throw new ConfigError(`account.${first[0] ?? ''}: ${first[1] ?? ''}`);
    const repo = parseRepository(repositoryUrl);
    account = {
      username,
      displayName,
      repositoryUrl: repo.ok ? repo.slug : repositoryUrl,
      lang,
      inline: { ...(inlinePassword !== null ? { password: inlinePassword } : {}), ...(inlineInvitation !== null ? { invitation: inlineInvitation } : {}) },
    };
  }
  if (mode === 'register' && account === null) throw new ConfigError('mode "register" требует "account"');

  const notifyRaw = field(obj, 'notify');
  const n = typeof notifyRaw === 'object' && notifyRaw !== null ? (notifyRaw as Record<string, unknown>) : {};
  const tg = field(n, 'telegram');
  const t = typeof tg === 'object' && tg !== null ? (tg as Record<string, unknown>) : null;
  const botToken = t ? optString(t, 'botToken') : null;
  const chatId = t ? optString(t, 'chatId') : null;
  if ((botToken !== null || chatId !== null) && isExposed(configPath)) {
    throw new ConfigError(`${configPath} содержит токен бота: chmod 600 ${configPath}`);
  }

  const stateDir = resolve(expandHome(optString(obj, 'stateDir') ?? join(homedir(), '.local', 'state', 'zoria')), server);

  return {
    server,
    apiBase,
    fingerprint,
    mode,
    account,
    notify: {
      url: optString(n, 'url'),
      telegram: botToken && chatId ? { botToken, chatId } : null,
      // Desktop bubbles are on unless switched off: a watcher nobody hears is no use.
      desktop: field(n, 'desktop') !== false,
    },
    stateDir,
    configPath,
    secretsFile: resolve(expandHome(optString(obj, 'secretsFile') ?? join(homedir(), '.config', 'zoria', 'watcher.env'))),
  };
}
