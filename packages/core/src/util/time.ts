/** Resolves after `ms`, or rejects with the signal's reason once aborted. The timer never outlives the signal. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/** Name of the device time zone, shown next to every local time (CL-38). */
export function localZoneName(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
}

// The UI speaks Russian, so dates read the same in the browser and in the watcher log.
const localFormat = new Intl.DateTimeFormat('ru-RU', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** Server times are UTC; the participant sees device-local time (CL-38). */
export function formatLocal(iso: string | number | null): string {
  if (iso === null) return '—';
  const ms = typeof iso === 'number' ? iso : Date.parse(iso);
  return Number.isNaN(ms) ? '—' : localFormat.format(ms);
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
