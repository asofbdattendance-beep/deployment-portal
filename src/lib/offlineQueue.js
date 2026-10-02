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

// ─── Error taxonomy (Task 1: L-04 + L-08) ───────────────────────────────
// Pure classifier — no I/O, unit-tested in offlineQueue.test.js.
// Server contracts from sql/v46 (scan_in) + sql/v41 (scan_out):
//  - dedup: replay already applied server-side → drop row, keep draining.
//  - drop: row will never succeed, no operator action → remove, keep draining.
//  - permanent: auth/clock failures needing human fix → quarantine terminal,
//    keep draining (never backoff+break — that wedged the queue ~12 min).
//  - retry: network/timeout/deploy-ordering → markFailed + backoff + break.
export function classifyScanError(msg, err) {
  const s = String(msg || err?.message || '')
  if (s.includes('Already IN') || s.includes('No open session')) return 'dedup'
  // V5: unique-constraint violation on the open-session index — a benign
  // concurrent double-IN already recorded server-side → dedup (drop the row,
  // keep draining, never head-of-line-block). Matched case-insensitively:
  // PostgREST surfaces raw Postgres error text whose case is not contractual.
  const lower = s.toLowerCase()
  if (
    lower.includes('duplicate key value') &&
    (lower.includes('uq_dp_one_open') || lower.includes('dp_attendance_sessions'))
  ) return 'dedup'
  if (s.includes('Invalid badge') || s.includes('Badge not found')) return 'drop'
  if (s.includes('Session does not match')) return 'drop' // L-08 stale p_open_id
  if (
    s.includes('Not authorized to scan') ||
    s.includes('Timestamp cannot be in the future') ||
    s.includes('Timestamp too old')
  ) return 'permanent'
  return 'retry'
}

export function getDrainTiming() {
  const g = typeof globalThis !== 'undefined' ? globalThis : {}
  const base = Number(g.__OFFLINEQ_BASE_INTERVAL__ ?? 7000)
  const max = Number(g.__OFFLINEQ_MAX_INTERVAL__ ?? 60000)
  return {
    base: Number.isFinite(base) && base > 0 ? base : 7000,
    max: Number.isFinite(max) && max > 0 ? max : 60000,
  }
}

// Test-only reset for the sticky-backoff regression (L-02 follow-up).
export function __resetDrainState() {
  _consecutiveFailures = 0
  _draining = false
}

// Test-only read of the sticky-backoff counter (V5/V12 drain tests assert
// growth on retry and decay on forward progress). Mirrors __resetDrainState.
export function __getConsecutiveFailures() {
  return _consecutiveFailures
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

// ─── enqueueScan result contract (Task A1: L-01 / L-02) ─────────────────────
// enqueueScan NEVER rejects. Every path resolves a result object:
//   { ok: true,  id }                        row durably written
//   { ok: false, reason: 'unavailable' }     no IndexedDB (private mode, blocked)
//   { ok: false, reason: 'full' }            MAX_QUEUE_SIZE LIVE rows reached
//   { ok: false, reason: 'write-failed', error }
//                                          the readiness read or the store
//                                          write errored/threw
// The old contract (bare id string on success, undefined/null on failure, and
// a REJECTED promise from tx.onerror) let an IndexedDB write error escape as an
// exception out of `handleScan`, breaking its "every exit resolves {ok}"
// guarantee, and made the three failure modes indistinguishable at every
// call site — an unavailable DB and a full queue both read as "storage
// unavailable".
export async function enqueueScan(scan) {
  const db = await getDB()
  if (!db) return { ok: false, reason: 'unavailable' }
  // D1b: fullness check counts only live rows — terminally `failed` rows are
  // never evicted, so counting them lets poison rows wedge the queue full.
  let existing
  try {
    existing = await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
      req.onsuccess = () => resolve(req.result || [])
      req.onerror = () => reject(req.error)
    })
  } catch (e) {
    // The readiness read is a best-effort precondition, NOT the enqueue. It used
    // to reject the whole call, turning a transient read error into a thrown
    // exception in the scan flow; now it is a reported write failure.
    console.warn('[OfflineQueue] Readiness read failed:', e)
    return { ok: false, reason: 'write-failed', error: e }
  }
  // D1a: tag the row with the current user id (null when logged out /
  // unresolvable — enqueue still works, drain skips null-owner rows).
  const owner = await resolveOwnerId(null)
  // A3 (L-03): the cap counts LIVE rows owned by THIS user only. Null-owner
  // orphans (a getSession() blip while logged in) previously consumed the
  // shared cap yet could never drain, wedging the queue at 200 with no UI
  // remedy. A per-owner cap keeps logged-out queueing bounded too. Failed
  // rows stay excluded (D1b).
  if (existing.filter(r => !isFailedRow(r) && (r.owner ?? null) === (owner ?? null)).length >= MAX_QUEUE_SIZE) {
    console.warn('[OfflineQueue] Queue full, refusing scan')
    return { ok: false, reason: 'full' }
  }
  const id = scan.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return new Promise((resolve) => {
    let tx2 = null
    // `IDBTransaction.error` THROWS (InvalidStateError) unless the transaction
    // finished with an error — an exception inside a handler would surface as
    // an unhandled error and leave this promise PENDING. Never let that escape.
    const txError = () => { try { return tx2 ? tx2.error : null } catch { return null } }
    try {
      tx2 = db.transaction(STORE, 'readwrite')
      tx2.objectStore(STORE).put({ ...scan, id, createdAt: Date.now(), attempts: 0, synced: false, owner: owner ?? null })
    } catch (e) {
      // A closing connection or a non-cloneable value throws synchronously.
      resolve({ ok: false, reason: 'write-failed', error: e })
      return
    }
    tx2.oncomplete = () => resolve({ ok: true, id })
    tx2.onerror = () => resolve({ ok: false, reason: 'write-failed', error: txError() })
    // A quota breach fires `abort`, not `error`. Without this the promise never
    // settles and the operator's scan hangs on `await enqueueScan(...)` forever.
    tx2.onabort = () => resolve({ ok: false, reason: 'write-failed', error: txError() })
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

// A3 (L-03): orphan recovery. Null-owner NON-failed rows can never drain
// (D1a: drain requires a logged-in user and only touches own rows), so a
// getSession() blip leaves rows no flow will ever consume. They are removed
// ONLY while logged out — when (r.owner ?? null) === uid === null, the
// caller sees exactly these rows in getQueuedScans, so nothing belonging to
// a logged-in user (or another user) is ever touched. Returns removed count.
export async function clearOrphanedQueue() {
  const db = await getDB()
  if (!db) return 0
  const uid = await resolveOwnerId(null)
  if (uid !== null) return 0
  const rows = await new Promise((res) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
    req.onsuccess = () => res(req.result || [])
    req.onerror = () => res([])
  })
  const doomed = rows.filter(r => !isFailedRow(r) && (r.owner ?? null) === null)
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
// Timing defaults live in getDrainTiming() (globalThis-injectable for T2).

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
              supabase.rpc('scan_in', { p_badge: q.badge, p_schedule: q.schedule_id, p_ts: ts, p_nonce: q.id, p_centre: q.centre, p_is_manual: q.is_manual || false }),
              10000,
              `Drain IN`
            )
            if (error) throw error
          } else {
            const { error } = await withTimeout(
              // scan_out declares (p_badge, p_schedule, p_ts, p_open_id) only —
              // an extra p_nonce makes PostgREST return PGRST202 and the row
              // below is marked failed + head-of-line-blocks the queue.
              supabase.rpc('scan_out', { p_badge: q.badge, p_schedule: q.schedule_id, p_ts: ts, p_open_id: q.open_id || null }),
              10000,
              `Drain OUT`
            )
            if (error) throw error
          }
          await removeQueued(q.id)
          drained++
          // Decay sticky backoff on forward progress (else ~6 blips pin 60s forever).
          _consecutiveFailures = Math.max(0, _consecutiveFailures - 1)
          onProgress?.(q, true)
        } catch (e) {
          const msg = String(e?.message || '')
          const kind = classifyScanError(msg, e)
          if (kind === 'dedup' || kind === 'drop') {
            await removeQueued(q.id)
            drained++
            _consecutiveFailures = Math.max(0, _consecutiveFailures - 1)
          } else if (kind === 'permanent') {
            await quarantineRow(q.id, msg.slice(0, 160) || 'permanent')
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
    const { base: BASE, max: MAX } = getDrainTiming()
    const base = Math.min(BASE * Math.pow(1.5, _consecutiveFailures), MAX)
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
