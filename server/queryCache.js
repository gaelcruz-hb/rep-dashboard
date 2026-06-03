// Tiny in-memory response cache with single-flight dedupe.
//
// Two jobs:
//   1. TTL cache — identical requests within `ttlMs` reuse the last computed value, so 25 users
//      polling the same endpoint collapse to ~1 recompute per TTL instead of 25.
//   2. In-flight dedupe — if N identical requests arrive before the first finishes, they all await
//      the SAME producer promise rather than each firing the full query fan-out at Databricks.
//
// Single Node process + ≤25 users → a plain Map is plenty (no Redis needed). Entries are lazily
// evicted on read; a periodic sweep keeps the map from growing unboundedly across distinct keys.

const cache    = new Map();   // key -> { value, exp }
const inflight  = new Map();  // key -> Promise

export async function cached(key, ttlMs, producer) {
  const hit = cache.get(key);
  if (hit && Date.now() < hit.exp) return hit.value;

  const pending = inflight.get(key);
  if (pending) return pending;                 // dedupe: ride the in-flight computation

  const p = (async () => producer())();
  inflight.set(key, p);
  try {
    const value = await p;
    cache.set(key, { value, exp: Date.now() + ttlMs });
    return value;
  } finally {
    inflight.delete(key);                      // failures aren't cached — next call retries
  }
}

// Stable cache key from an Express request: path + query params sorted so key order doesn't matter.
export function cacheKey(req) {
  const entries = Object.entries(req.query ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const qs = entries.map(([k, v]) => `${k}=${v}`).join("&");
  return qs ? `${req.path}?${qs}` : req.path;
}

// Express middleware: cache + dedupe a GET route's JSON response, WITHOUT touching the
// handler body. A fresh cache hit is served immediately; concurrent identical requests ride
// the first one's result; only successful (2xx) responses are cached.
export function cacheRoute(ttlMs) {
  return (req, res, next) => {
    const key = cacheKey(req);

    const hit = cache.get(key);
    if (hit && Date.now() < hit.exp) return res.json(hit.value);

    const pending = inflight.get(key);
    if (pending) {
      return pending.then(
        value => res.json(value),
        () => res.status(500).json({ error: "Internal server error" }),
      );
    }

    // First request for this key: run the handler and capture its JSON payload.
    let resolveFn, rejectFn;
    const p = new Promise((resolve, reject) => { resolveFn = resolve; rejectFn = reject; });
    p.catch(() => {});            // we settle it ourselves; avoid unhandled-rejection noise
    inflight.set(key, p);

    const origJson = res.json.bind(res);
    res.json = body => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        cache.set(key, { value: body, exp: Date.now() + ttlMs });
        resolveFn(body);
      } else {
        rejectFn(new Error(`upstream ${res.statusCode}`));
      }
      inflight.delete(key);
      return origJson(body);
    };
    // If the connection drops or the handler never responds, don't leave the key stuck inflight.
    res.on("close", () => {
      if (inflight.get(key) === p) { inflight.delete(key); rejectFn(new Error("response closed")); }
    });

    next();
  };
}

// Periodically drop expired entries (distinct keys accumulate otherwise).
const SWEEP_MS = 5 * 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [k, { exp }] of cache) if (now >= exp) cache.delete(k);
}, SWEEP_MS).unref?.();
