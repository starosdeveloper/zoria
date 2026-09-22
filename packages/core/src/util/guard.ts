// Minimal structural readers for untrusted JSON. Each reader returns the typed
// value or `undefined`; a response that does not match is treated as noise/foreign
// shape by the caller instead of crashing the UI (CL-01). Unknown fields are ignored (CL-06).

export type Reader<T> = (value: unknown) => T | undefined;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const str: Reader<string> = (v) => (typeof v === 'string' ? v : undefined);

export const bool: Reader<boolean> = (v) => (typeof v === 'boolean' ? v : undefined);

export const num: Reader<number> = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export const int: Reader<number> = (v) => (typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined);

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/** UTC ISO 8601 timestamp as sent by the server; kept as string, validated as parseable. */
export const isoTime: Reader<string> = (v) =>
  typeof v === 'string' && ISO_UTC.test(v) && !Number.isNaN(Date.parse(v)) ? v : undefined;

export function nullable<T>(reader: Reader<T>): Reader<T | null> {
  return (v) => (v === null ? null : reader(v));
}

/** Optional field: absent or `undefined` becomes `null`, present must match. */
export function optionalNull<T>(reader: Reader<T>): Reader<T | null> {
  return (v) => (v === undefined || v === null ? null : reader(v));
}

export function oneOf<const T extends readonly string[]>(...values: T): Reader<T[number]> {
  return (v) => (typeof v === 'string' && (values as readonly string[]).includes(v) ? v : undefined);
}

export function arrayOf<T>(reader: Reader<T>): Reader<T[]> {
  return (v) => {
    if (!Array.isArray(v)) return undefined;
    const out: T[] = [];
    for (const item of v) {
      const parsed = reader(item);
      if (parsed === undefined) return undefined;
      out.push(parsed);
    }
    return out;
  };
}

type Shape = Record<string, Reader<unknown>>;
type FromShape<S extends Shape> = { [K in keyof S]: S[K] extends Reader<infer T> ? T : never };

/** Object with the listed fields; extra fields are ignored, a mismatch in any listed field rejects the whole object. */
export function object<S extends Shape>(shape: S): Reader<FromShape<S>> {
  return (v) => {
    if (!isRecord(v)) return undefined;
    const out: Record<string, unknown> = {};
    for (const [key, reader] of Object.entries(shape)) {
      const parsed = reader(v[key]);
      if (parsed === undefined) return undefined;
      out[key] = parsed;
    }
    return out as FromShape<S>;
  };
}

/** Accept any JSON value; used where the caller only needs "it parsed". */
export const unknownValue: Reader<unknown> = (v) => v;
