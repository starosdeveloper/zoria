/** Small persistence port: localStorage in the browser, a 0600 file in Node. Failures degrade to memory. */
export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export class MemoryStore implements KeyValueStore {
  private readonly map = new Map<string, string>();
  get(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.map.set(key, value);
  }
  remove(key: string): void {
    this.map.delete(key);
  }
}

/** Wraps Web Storage; private mode or blocked storage throws on access, so every call falls back to memory. */
export class WebStorageStore implements KeyValueStore {
  private readonly fallback = new MemoryStore();
  private readonly storage: () => Storage;
  private readonly prefix: string;

  constructor(storage: () => Storage, prefix: string) {
    this.storage = storage;
    this.prefix = prefix;
  }

  get(key: string): string | null {
    try {
      return this.storage().getItem(this.prefix + key);
    } catch {
      return this.fallback.get(key);
    }
  }
  set(key: string, value: string): void {
    this.fallback.set(key, value);
    try {
      this.storage().setItem(this.prefix + key, value);
    } catch {
      // Memory copy above already holds the value; storage being unavailable is expected in private mode.
      return;
    }
  }
  remove(key: string): void {
    this.fallback.remove(key);
    try {
      this.storage().removeItem(this.prefix + key);
    } catch {
      return;
    }
  }
}
