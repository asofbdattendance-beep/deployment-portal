// Offline queue — IndexedDB (robust, no data loss under jammers)
import { safeOpenDB, CACHE_TTL, MAX_DRAIN_ATTEMPTS, withTimeout } from './scannerUtils'
import { supabase as defaultSupabase } from './supabase'

// NULL-OWNER DECISION (D1a): rows enqueued while logged out (or when the
// session is unresolvable) are stored with `owner: null`. Null-owner rows are
// NEVER auto-drained — drain requires a logged-in user and only touches rows
// whose owner matches that user — so a shared device can never sync user A's
// queued scans under user B's login/centre. Null-owner rows are cleared
// manually: per-row via removeQueued(id), or failed ones in bulk via
// clearFailedQueue() while logged out.
// BACKWARD COMPAT: no IndexedDB version bump — `owner` is an inline row
// field, old rows without it still read fine and `?? null` treats a missing
// owner exactly like null-owner.

// Canonical "terminally failed" predicate: v1 rows carry only the `failed`
// boolean, newer rows also carry `status: 'failed'`. Both count.
function isFailedRow(r) {
  return !!r && (r.status === 'failed' || r.failed === true)
}

async function resolveOwnerId(client) {
  try {
    const c = client || defaultSupabase
    const { data } = await c.auth.getSession()
    return data?.session?.user?.id ?? null
  } catch {
    return null
  }
}

function quarantineRow(id, reason) {
  // Immediate terminal failure — never retried, never treated as network error.
  return getDB().then(db => {
    if (!db) return
    return new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      const req = store.get(id)
      req.onsuccess = () => {
        const v = req.result
        if (v) store.put({ ...v, failed: true, status: 'failed', failReason: reason })
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve() // don't throw — best-effort
    })
  })
}

const MAX_QUEUE_SIZE = 200

const DB_NAME = 'sewadar_offline_q'
const DB_VERSION = 2
const STORE = 'scan_queue'
const CACHE = 'sewadar_cache'

let _dbPromise = null
let _dbInstance = null

function getDB() {
  if (_dbInstance && _dbInstance.objectStoreNames && _dbInstance.objectStoreNames.length > 0) return Promise.resolve(_dbInstance)
  if (_dbPromise) return _dbPromise
  _dbPromise = safeOpenDB(DB_NAME, DB_VERSION).then(db => {
    if (!db) return null
    _dbInstance = db
    db.onversionchange = () => { db.close(); _dbInstance = null; _dbPromise = null }
    db.onclose = () => { _dbInstance = null; _dbPromise = null }
    return db
  }).catch(() => { _dbPromise = null; return null })
  return _dbPromise
}

export async function enqueueScan(scan) {
  const db = await getDB()
  if (!db) return undefined
  // D1b: fullness check counts only live rows — terminally `failed` rows are
  // never evicted, so counting them lets poison rows wedge the queue full.
  const existing = await new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
    req.onsuccess = () => resolve(req.result || [])
    req.onerror = () => reject(req.error)
  })
  if (existing.filter(r => !isFailedRow(r)).length >= MAX_QUEUE_SIZE) {
    console.warn('[OfflineQueue] Queue full, rejecting scan')
    return null
  }
  // D1a: tag the row with the current user id (null when logged out /
  // unresolvable — enqueue still works, drain skips null-owner rows).
  const owner = await resolveOwnerId(null)
  const id = scan.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return new Promise((resolve, reject) => {
    const tx2 = db.transaction(STORE, 'readwrite')
    tx2.objectStore(STORE).put({ ...scan, id, createdAt: Date.now(), attempts: 0, synced: false, owner: owner ?? null })
    tx2.oncomplete = () => resolve(id)
    tx2.onerror = () => reject(tx2.error)
  })
}

export async function getQueuedScans() {
  const db = await getDB()
  if (!db) return []
  // D1a: scoped to the current session user — other users' rows are invisible
  // here (missing owner reads as null-owner, visible only while logged out).
  const uid = await resolveOwnerId(null)
  return new Promise((res, rej) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
    req.onsuccess = () => res((req.result || []).filter(r => (r.owner ?? null) === uid))
    req.onerror = () => rej(req.error)
  })
}

export async function removeQueued(id) {
  const db = await getDB()
  if (!db) return
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function markFailed(id) {
  const db = await getDB()
  if (!db) return
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const req = store.get(id)
    req.onsuccess = () => {
      const v = req.result
      if (v) {
        const attempts = (v.attempts || 0) + 1
        const failed = attempts >= MAX_DRAIN_ATTEMPTS
        // Canonical `status: 'failed'` marker alongside the legacy boolean so
        // cap-exclusion/quarantine checks see one vocabulary.
        store.put({ ...v, attempts, failed, ...(failed ? { status: 'failed' } : {}) })
      }
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve() // don't throw — best-effort
  })
}

export async function clearFailedQueue() {
  // D1b: bulk-remove terminally failed rows for the current session user only
  // (other users' rows are never deleted). Returns the removed count.
  // Null-owner failed rows are cleared only while logged out. No UI wires
  // this yet — exported for future use.
  const db = await getDB()
  if (!db) return 0
  const uid = await resolveOwnerId(null)
  const rows = await new Promise((res) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
    req.onsuccess = () => res(req.result || [])
    req.onerror = () => res([])
  })
  const doomed = rows.filter(r => isFailedRow(r) && (r.owner ?? null) === uid)
  if (doomed.length === 0) return 0
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    for (const r of doomed) store.delete(r.id)
    tx.oncomplete = () => resolve(doomed.length)
    tx.onerror = () => resolve(0)
  })
}

export async function cacheSet(key, value) {
  const db = await getDB()
  if (!db) return
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CACHE, 'readwrite')
    tx.objectStore(CACHE).put({ key, value, at: Date.now() })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
export async function cacheDelete(key) {
  const db = await getDB()
  if (!db) return
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CACHE, 'readwrite')
    tx.objectStore(CACHE).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
export async function cacheGet(key) {
  const db = await getDB()
  if (!db) return null
  return new Promise((res) => {
    const req = db.transaction(CACHE, 'readonly').objectStore(CACHE).get(key)
    req.onsuccess = () => res(req.result?.value ?? null)
    req.onerror = () => res(null)
  })
}

export async function preloadDeployed(scheduleId, deployedList) {
  // deployedList: [{badge_number, deptId, is_vss}]
  await cacheSet(`deployed:${scheduleId}`, deployedList)
  await cacheSet(`deployed_at:${scheduleId}`, Date.now())
}

export async function getCachedDeployed(scheduleId) {
  const db = await getDB()
  if (!db) return []
  return new Promise((res) => {
    const req = db.transaction(CACHE, 'readonly').objectStore(CACHE).get(`deployed_at:${scheduleId}`)
    req.onsuccess = () => {
      const at = req.result?.value
      if (at && Date.now() - at > CACHE_TTL) { res([]); return }
      const req2 = db.transaction(CACHE, 'readonly').objectStore(CACHE).get(`deployed:${scheduleId}`)
      req2.onsuccess = () => res(req2.result?.value ?? [])
      req2.onerror = () => res([])
    }
    req.onerror = () => res([])
  })
}

let _draining = false
let _consecutiveFailures = 0
const BASE_INTERVAL = 7000
const MAX_INTERVAL = 60000

// drain — called on online, visibility, interval. Returns rows synced.
// D1d: guarded by a cross-tab `navigator.locks` lock when available, with the
// in-memory mutex as fallback (private-mode browsers) — the lock is held for
// the whole drain and released in `finally`.
export async function drainQueue(supabase, onProgress) {
  const run = async () => {
    if (_draining) return 0 // mutex — prevent re-entrant drains
    _draining = true
    try {
      // D1a: logged out → no-op. Otherwise only rows owned by this session
      // user drain; anyone else's (and null-owner) rows are left untouched.
      const uid = await resolveOwnerId(supabase)
      if (!uid) return 0
      const db = await getDB()
      if (!db) return 0
      const queued = await new Promise((res) => {
        const tx = db.transaction(STORE, 'readonly')
        const req = tx.objectStore(STORE).getAll()
        req.onsuccess = () => res(req.result || [])
        req.onerror = () => res([])
      })
      const pending = queued
        .filter(q => (q.owner ?? null) === uid && !q.synced && !isFailedRow(q))
        .sort((a, b) => a.createdAt - b.createdAt)

      if (pending.length === 0) { _consecutiveFailures = 0; return 0 }

      let drained = 0
      for (const q of pending) {
        // D1c: validate timestamp parseability BEFORE attempting the row — an
        // unparseable q.ts used to throw inside the drain try, counted as a
        // network error and head-of-line-blocked the whole queue. Quarantined
        // rows are terminal (`failed`, reason `bad-timestamp`) and skipped
        // via `continue`, never `break`, never retried as network errors.
        let ts
        try {
          const d = new Date(q.ts)
          if (Number.isNaN(d.getTime())) throw new Error('bad-timestamp')
          ts = d.toISOString()
        } catch (e) {
          await quarantineRow(q.id, 'bad-timestamp')
          onProgress?.(q, false, e)
          continue
        }
        try {
          if (q.action === 'IN') {
            const { error } = await withTimeout(
              supabase.rpc('scan_in', { p_badge: q.badge, p_schedule: q.schedule_id, p_ts: ts, p_nonce: q.id, p_centre: q.centre }),
              10000,
              `Drain IN`
            )
            if (error) throw error
          } else {
            const { error } = await withTimeout(
              supabase.rpc('scan_out', { p_badge: q.badge, p_schedule: q.schedule_id, p_ts: ts, p_open_id: q.open_id || null, p_nonce: q.id }),
              10000,
              `Drain OUT`
            )
            if (error) throw error
          }
          await removeQueued(q.id)
          drained++
          onProgress?.(q, true)
        } catch (e) {
          const msg = String(e?.message || '')
          if (msg.includes('Already IN') || msg.includes('No open session')) {
            await markFailed(q.id)
          } else if (msg.includes('Invalid badge') || msg.includes('Badge not found')) {
            await removeQueued(q.id)
          } else {
            await markFailed(q.id)
            _consecutiveFailures++
            break // network error — stop draining, backoff
          }
          onProgress?.(q, false, e)
        }
      }
      return drained
    } finally {
      _draining = false
    }
  }
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request('offline-scan-drain', run)
  }
  return run()
}

export function installDrainListeners(supabase, cb) {
  let intervalId = null
  const getInterval = () => {
    const base = Math.min(BASE_INTERVAL * Math.pow(1.5, _consecutiveFailures), MAX_INTERVAL)
    const jitter = base * 0.8 + Math.random() * base * 0.4 // ±20% jitter
    return Math.round(jitter)
  }

  const fn = () => {
    if (document.visibilityState !== 'visible') return
    drainQueue(supabase, cb).catch(() => {})
  }

  const scheduleNext = () => {
    if (intervalId) clearTimeout(intervalId)
    intervalId = setTimeout(() => {
      fn()
      scheduleNext()
    }, getInterval())
  }

  window.addEventListener('online', fn)
  document.addEventListener('visibilitychange', fn)
  scheduleNext()

  return () => {
    window.removeEventListener('online', fn)
    document.removeEventListener('visibilitychange', fn)
    if (intervalId) clearTimeout(intervalId)
  }
}
