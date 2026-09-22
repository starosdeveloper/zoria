// Response shapes of the part 1 contract (client spec §5.4, OpenAPI 1.1.0 of 22.09).
// Readers accept extra fields and reject a mismatch in any listed one.

import {
  arrayOf,
  bool,
  int,
  isoTime,
  nullable,
  object,
  oneOf,
  optionalNull,
  str,
  type Reader,
} from '../util/guard.ts';

export const LANGS = ['uk', 'en'] as const;
export type Lang = (typeof LANGS)[number];

export const readRepositoryAccess = object({
  githubUsername: str,
  permission: str,
  instructions: str,
});
export type RepositoryAccess = NonNullable<ReturnType<typeof readRepositoryAccess>>;

export const readConfig = object({
  apiVersion: int,
  title: str,
  season: str,
  registrationOpen: bool,
  inviteRequired: bool,
  repositoryRequired: bool,
  repositoryAccess: nullable(readRepositoryAccess),
  webClient: bool,
});
export type Config = NonNullable<ReturnType<typeof readConfig>>;

export const readUser = object({
  id: str,
  username: str,
  displayName: str,
  role: str,
  disabled: bool,
  createdAt: isoTime,
  lang: str,
});
export type User = NonNullable<ReturnType<typeof readUser>>;

export const readSession = object({
  token: str,
  sessionId: str,
  expiresAt: isoTime,
  user: readUser,
});
export type Session = NonNullable<ReturnType<typeof readSession>>;

export const ACCESS_STATUSES = ['pending', 'verified', 'needs-attention'] as const;
export type AccessStatus = (typeof ACCESS_STATUSES)[number];

export const readRepository = object({
  url: str,
  // Unknown future status is still shown as text rather than rejecting the whole object.
  accessStatus: str,
  checkedAt: nullable(isoTime),
  reason: nullable(str),
  reasonCode: optionalNull(str),
  updatedAt: isoTime,
  verifiedElsewhere: bool,
});
export type Repository = NonNullable<ReturnType<typeof readRepository>>;

export const readSummary = object({
  unread: int,
  releasedStages: int,
  acknowledgedStages: int,
  latestNews: nullable(isoTime),
  repositoryAt: nullable(isoTime),
  serverTime: isoTime,
});
export type Summary = NonNullable<ReturnType<typeof readSummary>>;

export const readNews = object({
  id: str,
  title: str,
  body: str,
  createdAt: isoTime,
  updatedAt: isoTime,
  publishedAt: nullable(isoTime),
  archivedAt: nullable(isoTime),
});
export type News = NonNullable<ReturnType<typeof readNews>>;

const readRepositoryNotice = object({
  type: oneOf('repository'),
  url: str,
  accessStatus: str,
  reason: nullable(str),
  reasonCode: optionalNull(str),
});

export type Notice =
  | { type: 'repository'; url: string; accessStatus: string; reason: string | null; reasonCode: string | null }
  | { type: 'unknown'; rawType: string };

/** Unknown `notice.type` is displayed as a plain message (CL-29), never a parse failure. */
export const readNotice: Reader<Notice> = (v) => {
  const repo = readRepositoryNotice(v);
  if (repo) return repo;
  const typed = object({ type: str })(v);
  return typed ? { type: 'unknown', rawType: typed.type } : undefined;
};

export const readMessage = object({
  id: str,
  messageId: nullable(str),
  stageId: nullable(str),
  kind: str,
  title: str,
  body: str,
  createdAt: isoTime,
  readAt: nullable(isoTime),
  notice: nullable(readNotice),
});
export type Message = NonNullable<ReturnType<typeof readMessage>>;

export const readStageSummary = object({
  id: str,
  position: int,
  title: str,
  excerpt: optionalNull(str),
  publishedAt: isoTime,
  releasedAt: isoTime,
  acknowledgedAt: nullable(isoTime),
  errataAt: nullable(isoTime),
});
export type StageSummary = NonNullable<ReturnType<typeof readStageSummary>>;

export const readStage = object({
  id: str,
  position: int,
  title: str,
  body: str,
  publishedAt: isoTime,
  releasedAt: isoTime,
  acknowledgedAt: nullable(isoTime),
  errata: nullable(str),
  errataAt: nullable(isoTime),
});
export type Stage = NonNullable<ReturnType<typeof readStage>>;

export function readPage<T>(item: Reader<T>): Reader<{ items: T[]; nextOffset: number | null }> {
  return object({ items: arrayOf(item), nextOffset: nullable(int) });
}

export const readEtherKey = object({
  algorithm: str,
  key: str,
  publicKey: str,
  fingerprint: str,
});
export type EtherKeyInfo = NonNullable<ReturnType<typeof readEtherKey>>;

export const readDeveloperCheck = object({
  apiVersion: int,
  accountId: str,
  serverTime: isoTime,
  echo: str,
  checks: object({ authenticated: bool, json: bool, utf8: bool }),
});
export type DeveloperCheck = NonNullable<ReturnType<typeof readDeveloperCheck>>;

export const readErrorBody = object({
  error: object({
    code: str,
    field: optionalNull(str),
    requestId: optionalNull(str),
  }),
});

export interface RegisterRequest {
  username: string;
  displayName: string;
  password: string;
  /** One-time application code (OpenAPI 1.1.0, required). */
  invitation: string;
  repositoryUrl: string;
  lang?: Lang;
}
