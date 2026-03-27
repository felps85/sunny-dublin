const PREFIX = "sunny-dublin:";

export function readNumber(key: string) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

export function writeNumber(key: string, value: number) {
  try {
    localStorage.setItem(PREFIX + key, String(value));
  } catch {
    // ignore
  }
}

type CachedValue<T> = {
  value: T;
  expiresAt: number;
};

export function readJson<T>(key: string) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return undefined;
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function writeJson<T>(key: string, value: T) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

export function readCachedJson<T>(key: string) {
  const entry = readJson<CachedValue<T>>(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) return undefined;
  return entry.value;
}

export function writeCachedJson<T>(key: string, value: T, ttlMs: number) {
  writeJson<CachedValue<T>>(key, {
    value,
    expiresAt: Date.now() + ttlMs
  });
}
