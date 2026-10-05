/* hq :: cbor
   Чтение CBOR (RFC 8949) для журнала партии в браузере: штабу нужен `.runlog`
   без SDK, а SDK лежит в частном реестре.

   Журнал пишется каноническим CBOR (04-protocol 2.3), но читатель принимает
   любую корректную форму определённой длины — штаб показывает чужие записи и
   не должен падать на допустимом, хоть и не каноническом, байте. Неопределённые
   длины (2.3 их запрещает) и обрезанный вход — ошибка с позицией, не тихий
   `undefined`. Байтовые строки отдаются срезом входа, без копии: кадр команд
   профайлеру нужен как есть. */

export type Cbor =
  | number
  | bigint
  | string
  | boolean
  | null
  | undefined
  | Uint8Array
  | Cbor[]
  | Map<Cbor, Cbor>
  | { tag: number; value: Cbor };

export class CborError extends Error {
  readonly at: number;
  constructor(message: string, at: number) {
    super(`CBOR, байт ${String(at)}: ${message}`);
    this.at = at;
  }
}

/** Глубина вложенности: журнал — пять уровней; предел защищает стек от чужого файла. */
const MAX_DEPTH = 64;

class Reader {
  pos = 0;
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private need(n: number) {
    if (this.pos + n > this.bytes.length) throw new CborError(`нужно ещё ${String(n)}, вход кончился`, this.pos);
  }

  private argument(info: number): number | bigint {
    if (info < 24) return info;
    switch (info) {
      case 24:
        this.need(1);
        return this.view.getUint8(this.pos++);
      case 25:
        this.need(2);
        this.pos += 2;
        return this.view.getUint16(this.pos - 2);
      case 26:
        this.need(4);
        this.pos += 4;
        return this.view.getUint32(this.pos - 4);
      case 27: {
        this.need(8);
        this.pos += 8;
        const big = this.view.getBigUint64(this.pos - 8);
        return big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
      }
      default:
        throw new CborError(info === 31 ? 'неопределённая длина' : `зарезервированное значение ${String(info)}`, this.pos - 1);
    }
  }

  private length(info: number): number {
    const n = this.argument(info);
    if (typeof n === 'bigint' || n > this.bytes.length) throw new CborError(`длина ${String(n)} больше входа`, this.pos);
    return n;
  }

  item(depth: number): Cbor {
    if (depth > MAX_DEPTH) throw new CborError('слишком глубокая вложенность', this.pos);
    this.need(1);
    const head = this.view.getUint8(this.pos++);
    const major = head >> 5;
    const info = head & 0x1f;
    switch (major) {
      case 0:
        return this.argument(info);
      case 1: {
        const n = this.argument(info);
        return typeof n === 'bigint' ? -1n - n : -1 - n;
      }
      case 2: {
        const n = this.length(info);
        this.need(n);
        this.pos += n;
        return this.bytes.subarray(this.pos - n, this.pos);
      }
      case 3: {
        const n = this.length(info);
        this.need(n);
        this.pos += n;
        return new TextDecoder('utf-8', { fatal: true }).decode(this.bytes.subarray(this.pos - n, this.pos));
      }
      case 4: {
        const n = this.length(info);
        const out: Cbor[] = [];
        for (let i = 0; i < n; i++) out.push(this.item(depth + 1));
        return out;
      }
      case 5: {
        const n = this.length(info);
        const out = new Map<Cbor, Cbor>();
        for (let i = 0; i < n; i++) {
          const k = this.item(depth + 1);
          out.set(k, this.item(depth + 1));
        }
        return out;
      }
      case 6: {
        const tag = this.argument(info);
        return { tag: Number(tag), value: this.item(depth + 1) };
      }
      default:
        return this.simple(info);
    }
  }

  private simple(info: number): Cbor {
    switch (info) {
      case 20:
        return false;
      case 21:
        return true;
      case 22:
        return null;
      case 23:
        return undefined;
      case 25:
        this.need(2);
        this.pos += 2;
        return half(this.view.getUint16(this.pos - 2));
      case 26:
        this.need(4);
        this.pos += 4;
        return this.view.getFloat32(this.pos - 4);
      case 27:
        this.need(8);
        this.pos += 8;
        return this.view.getFloat64(this.pos - 8);
      default:
        throw new CborError(`простое значение ${String(info)} не поддержано`, this.pos - 1);
    }
  }
}

/** binary16 → число (RFC 8949, приложение D). */
function half(h: number): number {
  const exp = (h >> 10) & 0x1f;
  const mant = h & 0x3ff;
  const val = exp === 0 ? mant * 2 ** -24 : exp !== 31 ? (mant + 1024) * 2 ** (exp - 25) : mant === 0 ? Infinity : NaN;
  return h & 0x8000 ? -val : val;
}

/** Один элемент CBOR на весь вход; хвост после него — ошибка. */
export function decodeCbor(bytes: Uint8Array): Cbor {
  const r = new Reader(bytes);
  const value = r.item(0);
  if (r.pos !== bytes.length) throw new CborError(`после элемента ещё ${String(bytes.length - r.pos)} байт`, r.pos);
  return value;
}
