const store = new Map();

export function cacheGet(key) {
  const entry = store.get(key);
  if (!entry || Date.now() > entry.exp) return null;
  return entry.data;
}

export function cacheSet(key, data, ttlMs = 90_000) {
  store.set(key, { data, exp: Date.now() + ttlMs });
}
