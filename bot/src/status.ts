/* bot :: status
   внутрішній службовий порт голови - єдиний вхід до бота ззовні його
   процесу. Його слухає control-plane стека (`zaria-kit init stack`), і з
   цього знімка він збирає `/health` і `/metrics` службового контракту
   (`kit/02-control-plane.md`). Другого каналу від голови немає: лічильники
   проводу бачить лише вона.

   Порт вмикається змінною STATUS_PORT. Без неї сервера немає зовсім:
   локальному пакету (`npm run play`) він не потрібен, а в стеку він живе у
   внутрішній мережі й назовні не публікується.

     GET  /state    знімок голови: провід, такт, лічильники, щоденник
     POST /preset   {"preset"} - між партіями; у бою і на заморожуванні 409

   Тіла запитів - до кілобайта: сюди ходить лише control-plane. Слова
   відмов машинні (`preset`, `live`, `freeze`, `json`, `path`) - мовою
   учасника їх переказує той, хто говорить з учасником. */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

export interface HeadStats {
  ticks: number;
  orders: number;
  nacks: number;
  bytesIn: number;
  bytesOut: number;
  resyncMs: number;
  resumes: number;
  faults: number;
  deferred: number;
  lastTickAt: number;
}

export interface HeadState {
  /* lobby - у партію ще не увійшли; live - провід живий; done - партію скінчено */
  state: 'lobby' | 'live' | 'done';
  slot: string | null;
  preset: string;
  presets: string[];
  freeze: boolean;
  /* такт світу із заголовка останнього кадру спостереження */
  tick: number;
  /* кадрів, на які голова дала відповідь; розбіжність із tick - пропуски */
  frames: number;
  ticks: number;
  /* причина кінця партії: end - вузол попрощався, close:<код> - закрив */
  why: string;
  engine: string;
  uptimeMs: number;
  stats: HeadStats;
  belief: { frames: number; ageMs: number };
}

export interface Head {
  state(): HeadState;
  /* змінити пресет між партіями; відмова - Refusal зі своїм кодом HTTP */
  promote(preset: unknown): string;
}

export class Refusal extends Error {
  readonly code: number;

  constructor(code: number, word: string) {
    super(word);
    this.code = code;
    this.name = 'Refusal';
  }
}

const LIMIT = 1024;

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((ok, bad) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > LIMIT) {
        /* читати далі нічого, але рвати з'єднання не можна: відмову ще треба
           віддати. `destroy` тут закривав сокет раніше за відповідь, і стек
           бачив обрив замість слова `json` - помилку не з чим було зіставити */
        req.pause();
        bad(new Refusal(400, 'json'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('json');
        ok(v as Record<string, unknown>);
      } catch {
        bad(new Refusal(400, 'json'));
      }
    });
    req.on('error', bad);
  });
}

function send(res: ServerResponse, code: number, value: unknown): void {
  const text = JSON.stringify(value);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function route(head: Head, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? '/').split('?')[0];
  try {
    if (req.method === 'GET' && path === '/state') send(res, 200, head.state());
    else if (req.method === 'POST' && path === '/preset') send(res, 200, { preset: head.promote((await readBody(req))['preset']) });
    else send(res, 404, { error: 'path' });
  } catch (e) {
    if (e instanceof Refusal) send(res, e.code, { error: e.message });
    else send(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
}

export function statusServer(head: Head): Server {
  return createServer((req, res) => {
    void route(head, req, res);
  });
}
