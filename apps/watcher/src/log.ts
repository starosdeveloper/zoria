import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { appendPrivate, writePrivateAtomic } from './files.ts';
import type { WatcherConfig } from './config.ts';

const run = promisify(execFile);

export type Level = 'info' | 'warn' | 'alert';

export interface Notifier {
  send(text: string): Promise<void>;
}

/** Console + JSONL journal. The journal keeps X-Request-Id for outage reports (ТЗ §6). */
export class Journal {
  private readonly file: string;
  private readonly heartbeatFile: string;

  constructor(stateDir: string) {
    this.file = join(stateDir, 'events.jsonl');
    this.heartbeatFile = join(stateDir, 'heartbeat');
  }

  write(level: Level, event: string, data: Record<string, unknown> = {}): void {
    const at = new Date().toISOString();
    const tail = Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : '';
    const line = `${at} ${level.toUpperCase().padEnd(5)} ${event}${tail}`;
    if (level === 'info') console.log(line);
    else console.error(line);
    try {
      appendPrivate(this.file, `${JSON.stringify({ at, level, event, ...data })}\n`);
    } catch (error) {
      console.error(`${at} WARN  journal-write-failed ${String(error)}`);
    }
  }

  /** External monitors (systemd timer, cron) alert when this file stops moving. */
  heartbeat(): void {
    try {
      writePrivateAtomic(this.heartbeatFile, `${new Date().toISOString()}\n`);
    } catch (error) {
      this.write('warn', 'heartbeat-write-failed', { error: String(error) });
    }
  }
}

/**
 * Alerts go to a webhook (ntfy-style POST of plain text), Telegram and the desktop.
 * The desktop channel needs no setup and works even with no network to the outside;
 * it is the fallback that keeps a silent watcher from being unnoticed. Failures are
 * logged, never thrown.
 */
export function makeNotifier(config: WatcherConfig, journal: Journal): Notifier {
  const targets: ((text: string) => Promise<unknown>)[] = [];
  if (config.notify.desktop) {
    // urgency=critical keeps the bubble on screen until it is dismissed.
    targets.push((text) => run('notify-send', ['--urgency=critical', '--app-name=Зоря.нет', 'Зоря.нет', text]));
  }
  const { url, telegram } = config.notify;
  if (url) {
    targets.push((text) =>
      fetch(url, { method: 'POST', body: text, headers: { Title: 'Zoria watcher' }, signal: AbortSignal.timeout(10_000) }),
    );
  }
  if (telegram) {
    targets.push((text) =>
      fetch(`https://api.telegram.org/bot${telegram.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: telegram.chatId, text }),
        signal: AbortSignal.timeout(10_000),
      }),
    );
  }
  return {
    async send(text: string): Promise<void> {
      const results = await Promise.allSettled(targets.map((t) => t(`[${config.server}] ${text}`)));
      for (const r of results) {
        if (r.status === 'rejected') journal.write('warn', 'notify-failed', { error: String(r.reason) });
        else if (r.value instanceof Response && !r.value.ok) journal.write('warn', 'notify-failed', { status: r.value.status });
      }
      if (targets.length === 0) journal.write('warn', 'notify-nowhere', { hint: 'ни один канал уведомлений не настроен' });
    },
  };
}
