import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseEnvFile, resolveSecrets } from '../src/secrets.ts';

const PASSWORD = 'X4ie9a-NHVJXG-M7CLNf';
let dir: string;
let file: string;

function write(text: string, mode = 0o600): void {
  writeFileSync(file, text, { mode });
  chmodSync(file, mode);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zoria-secrets-'));
  file = join(dir, 'watcher.env');
  delete process.env.ZORIA_PASSWORD;
  delete process.env.ZORIA_INVITATION;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ZORIA_PASSWORD;
  delete process.env.ZORIA_INVITATION;
});

describe('watcher secrets', () => {
  it('parses KEY=VALUE with comments, blanks and quotes', () => {
    expect(parseEnvFile('# c\n\nA=1\nB = "two words"\nC=\'x\'\nbroken\nD=a=b\n')).toEqual({ A: '1', B: 'two words', C: 'x', D: 'a=b' });
  });

  it('missing code is reported, not thrown; login needs only the password', () => {
    write(`ZORIA_PASSWORD=${PASSWORD}\nZORIA_INVITATION=\n`);
    const register = resolveSecrets(file, {}, 'register');
    expect(register.ok).toBe(false);
    if (!register.ok) expect(register.problems.join()).toMatch(/код заявки/);
    expect(resolveSecrets(file, {}, 'login')).toEqual({ ok: true, secrets: { password: PASSWORD, invitation: '' } });
  });

  it('picks up a code written later without restart; the file wins over a stale environment', () => {
    process.env.ZORIA_INVITATION = 'OLD-CODE';
    write(`ZORIA_PASSWORD=${PASSWORD}\nZORIA_INVITATION=  NEW-CODE  \n`);
    expect(resolveSecrets(file, {})).toEqual({ ok: true, secrets: { password: PASSWORD, invitation: 'NEW-CODE' } });
  });

  it('falls back to the environment, then to inline config values', () => {
    process.env.ZORIA_PASSWORD = PASSWORD;
    expect(resolveSecrets(join(dir, 'absent.env'), { invitation: 'INLINE' })).toEqual({ ok: true, secrets: { password: PASSWORD, invitation: 'INLINE' } });
  });

  it('refuses a secrets file readable by others', () => {
    write(`ZORIA_PASSWORD=${PASSWORD}\nZORIA_INVITATION=CODE\n`, 0o644);
    const r = resolveSecrets(file, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]).toMatch(/chmod 600/);
  });

  it('keeps the password byte for byte', () => {
    write(`ZORIA_PASSWORD="  spaced password  "\nZORIA_INVITATION=C\n`);
    const r = resolveSecrets(file, {});
    expect(r.ok && r.secrets.password).toBe('  spaced password  ');
  });
});
