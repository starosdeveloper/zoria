import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tryParseJson, type KeyValueStore } from '@zoria/core';

/** Owner-only permissions for anything holding a token or password (CL-20). */
export const PRIVATE_FILE = 0o600;
export const PRIVATE_DIR = 0o700;

export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIR });
  chmodSync(path, PRIVATE_DIR);
}

/** tmp + rename: a crash mid-write never leaves a half-written token file. */
export function writePrivateAtomic(path: string, content: string): void {
  ensurePrivateDir(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: PRIVATE_FILE });
  renameSync(tmp, path);
}

export function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** True when group/other have any access to the file. */
export function isExposed(path: string): boolean {
  return (statSync(path).mode & 0o077) !== 0;
}

export function appendPrivate(path: string, line: string): void {
  ensurePrivateDir(dirname(path));
  appendFileSync(path, line, { mode: PRIVATE_FILE });
}

/** KeyValueStore backed by one JSON file in the state directory. */
export class FileStore implements KeyValueStore {
  private readonly path: string;
  private data: Record<string, string>;

  constructor(dir: string, name: string) {
    this.path = join(dir, name);
    const raw = readIfExists(this.path);
    const parsed = raw === null ? null : tryParseJson(raw);
    this.data = parsed?.ok && typeof parsed.value === 'object' && parsed.value !== null ? (parsed.value as Record<string, string>) : {};
  }

  get(key: string): string | null {
    const v = this.data[key];
    return typeof v === 'string' ? v : null;
  }

  set(key: string, value: string): void {
    this.data = { ...this.data, [key]: value };
    writePrivateAtomic(this.path, JSON.stringify(this.data));
  }

  remove(key: string): void {
    const { [key]: _removed, ...rest } = this.data;
    this.data = rest;
    writePrivateAtomic(this.path, JSON.stringify(this.data));
  }
}
