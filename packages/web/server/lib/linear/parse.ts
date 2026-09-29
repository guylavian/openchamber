export function isString(value: unknown): value is string {
  return Object.prototype.toString.call(value) === '[object String]';
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value == null || Array.isArray(value)) {
    return false;
  }
  return Object.getPrototypeOf(value) === Object.prototype;
}

export function readTrimmedString(value: unknown): string {
  return isString(value) && value.trim() ? value.trim() : '';
}

export function readFiniteNumber(value: unknown): number | null {
  return Number.isFinite(value) ? (value as number) : null;
}

export function readEnv(name: string): string {
  const raw = process.env[name];
  return raw ? raw.trim() : '';
}
