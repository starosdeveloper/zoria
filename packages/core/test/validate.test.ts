import { describe, expect, it } from 'vitest';
import {
  checkDisplayName,
  checkInvitation,
  normalizeUsername,
  checkDraft,
  checkPassword,
  checkUsername,
  fieldForCode,
  parseRepository,
} from '../src/domain/validate.ts';

describe('repository address (CL-14)', () => {
  it.each([
    ['north/zoria-client', 'north/zoria-client'],
    ['north/zoria-client/', 'north/zoria-client'],
    ['north/zoria-client.git', 'north/zoria-client'],
    ['github.com/north/zoria-client', 'north/zoria-client'],
    ['www.github.com/north/zoria-client', 'north/zoria-client'],
    ['https://github.com/north/zoria-client', 'north/zoria-client'],
    ['http://github.com/north/zoria-client', 'north/zoria-client'],
    ['https://www.github.com/north/zoria-client.git', 'north/zoria-client'],
    ['https://github.com/north/zoria-client/', 'north/zoria-client'],
    ['HTTPS://GitHub.com/North/Zoria.Client', 'North/Zoria.Client'],
    ['git@github.com:north/zoria-client.git', 'north/zoria-client'],
    ['git@github.com:north/zoria-client', 'north/zoria-client'],
    ['  north/zoria-client  ', 'north/zoria-client'],
  ])('accepts %s', (input, slug) => {
    expect(parseRepository(input)).toEqual({ ok: true, slug });
  });

  it.each([
    'https://github.com/north/zoria-client/blob/main/README.md',
    'https://github.com/north/zoria-client/tree/dev',
    'https://github.com/north/zoria-client/issues',
    'https://github.com/north/zoria-client?tab=readme',
    'https://github.com/north/zoria-client#readme',
    'north/zoria-client/tree/main',
  ])('rejects link inside the repository: %s', (input) => {
    expect(parseRepository(input)).toEqual({ ok: false, reason: 'not-root' });
  });

  it.each(['https://gitlab.com/north/repo', 'git@gitlab.com:north/repo.git', 'bitbucket.org/north/repo'])(
    'rejects non-GitHub hosts: %s',
    (input) => {
      expect(parseRepository(input)).toEqual({ ok: false, reason: 'not-github' });
    },
  );

  it.each(['', 'north', 'https://github.com/north', 'https://github.com/', '-bad/repo', 'north/.git'])(
    'rejects malformed input: %j',
    (input) => {
      expect(parseRepository(input).ok).toBe(false);
    },
  );

  it('rejects addresses over 256 characters', () => {
    expect(parseRepository(`north/${'a'.repeat(260)}`)).toEqual({ ok: false, reason: 'too-long' });
  });
});

describe('field rules (spec §5.6)', () => {
  it('username', () => {
    expect(checkUsername('north')).toBeNull();
    expect(checkUsername('a_b-9')).toBeNull();
    expect(checkUsername('ab')).not.toBeNull();
    expect(checkUsername('9north')).not.toBeNull();
    expect(checkUsername('north!')).not.toBeNull();
    expect(checkUsername('n'.repeat(33))).not.toBeNull();
    expect(checkUsername('Ніч')).not.toBeNull();
  });

  it('display name', () => {
    expect(checkDisplayName('Північна вахта')).toBeNull();
    expect(checkDisplayName(' lead')).not.toBeNull();
    expect(checkDisplayName('a\tb')).not.toBeNull();
    expect(checkDisplayName('x'.repeat(81))).not.toBeNull();
    expect(checkDisplayName('')).not.toBeNull();
  });

  it('password length counts characters, not UTF-16 units', () => {
    expect(checkPassword('correct-horse')).toBeNull();
    expect(checkPassword('short')).not.toBeNull();
    expect(checkPassword('🔑'.repeat(12))).toBeNull();
    expect(checkPassword('x'.repeat(257))).not.toBeNull();
  });

  it('draft collects every field error', () => {
    const errors = checkDraft({ username: 'x', displayName: ' ', password: '1', invitation: ' ', repositoryUrl: 'x', lang: 'uk' });
    expect(Object.keys(errors).sort()).toEqual(['displayName', 'invitation', 'password', 'repositoryUrl', 'username']);
  });

  it('invitation: required, trimmed, at most 100 characters', () => {
    expect(checkInvitation('STAND-2026')).toBeNull();
    expect(checkInvitation('  STAND-2026  ')).toBeNull();
    expect(checkInvitation('   ')).not.toBeNull();
    expect(checkInvitation('x'.repeat(101))).not.toBeNull();
  });

  it('username is sent lowercase (OpenAPI 1.1.0 pattern)', () => {
    expect(normalizeUsername('  North_1 ')).toBe('north_1');
    expect(checkDraft({ username: 'North', displayName: 'N', password: 'correct-horse', invitation: 'c', repositoryUrl: 'a/b', lang: 'uk' })).toEqual({});
  });

  it('maps server codes to form fields', () => {
    expect(fieldForCode('invalid-invitation', null)).toBe('invitation');
    expect(fieldForCode('invalid-field', 'password')).toBe('password');
    expect(fieldForCode('repository-not-eligible', null)).toBe('repositoryUrl');
    expect(fieldForCode('invalid-field', 'url')).toBe('repositoryUrl');
    expect(fieldForCode('username-unavailable', null)).toBe('username');
    expect(fieldForCode('registration-closed', null)).toBeNull();
  });
});
