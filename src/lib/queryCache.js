// src/lib/queryCache.js
// Tiny TTL+SWR cache with in-flight dedup. No dependencies.
// Use for read-heavy Supabase calls that many viewers/pages repeat
// (aggregates, directory maps, centre lists). Keyed by a string; ttlMs is
// the "fresh" window, staleMs (optional) is how long a stale value may be
// served while revalidating in the background.
const store = new Map() // key -> { value, ts, promise }

export function cached(key, ttlMs, loader, opts = {}) {
  const now = Date.now()
  const staleMs = opts.staleMs || 0
  const entry = store.get(key)

  // In-flight: join the existing request (dedup).
  if (entry && entry.promise) return entry.promise

  // Fresh.
  if (entry && now - entry.ts < ttlMs) return Promise.resolve(entry.value)

  // Stale-while-revalidate: serve stale, revalidate in background.
  if (entry && staleMs > 0 && now - entry.ts < ttlMs + staleMs) {
    const promise = Promise.resolve()
      .then(loader)
      .then(
        (v) => { store.set(key, { value: v, ts: Date.now(), promise: null }); return v },
        () => { /* keep stale value on error */ }
      )
    store.set(key, { value: entry.value, ts: entry.ts, promise })
    return Promise.resolve(entry.value)
  }

  // Miss: fetch.
  const promise = Promise.resolve()
    .then(loader)
    .then(
      (v) => { store.set(key, { value: v, ts: Date.now(), promise: null }); return v },
      (err) => { store.delete(key); throw err }
    )
  store.set(key, { value: entry ? entry.value : undefined, ts: entry ? entry.ts : now, promise })
  return promise
}

export function invalidate(prefix) {
  for (const k of Array.from(store.keys())) {
    if (k.startsWith(prefix)) store.delete(k)
  }
}

export function clear() {
  store.clear()
}

// Test hook only.
export function __reset() {
  store.clear()
}
