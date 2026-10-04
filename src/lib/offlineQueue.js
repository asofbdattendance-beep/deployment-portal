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
      tx.oncomplete = () => { notifyQueueChanged(); resolve() }
      tx.onerror = () => resolve() // don't throw — best-effort
      // Abort (quota, versionchange-close) fires instead of error — without
      // this the promise pends forever and latches _draining.
      tx.onabort = () => resolve()
    })
  })
}

// ─── Error taxonomy (Task 1: L-04 + L-08; T8) ────────────────────────────
// Pure classifier — no I/O, unit-tested in offlineQueue.test.js.
// Server contracts from sql/v46 (scan_in) + sql/v41 (scan_out):
//  - dedup: replay already applied server-side → drop row, keep draining.
//  - drop: row will never succeed, no operator action → remove, keep draining.
//  - permanent: auth/RLS/clock failures needing human fix → quarantine
//    terminal, keep draining (never backoff+break — that wedged the queue
//    ~12 min). T8: decided from err.code AND message text — message-only
//    matching let 401/403/42501 and PostgREST RLS denials classify as
//    `retry` → markFailed + break, wedging the queue behind a row that can
//    never succeed. PGRST202 stays `retry`: it means the RPC itself is
//    missing (frontend shipped before the migration — deploy ordering),
//    which resolves itself without operator action.
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
    s.includes('Timestamp too old') ||
    // A queued OUT whose ts precedes its session's IN time can never succeed
    // on retry (the row ts is fixed at enqueue) — quarantining keeps the
    // queue flowing instead of head-of-line-blocking behind it for all
    // MAX_DRAIN_ATTEMPTS backoff cycles.
    s.includes('OUT time must be after IN time')
  ) return 'permanent'
  // T8: honour err.code (supabase-js attaches .code to RPC errors; it may be
  // numeric or string). 401/403/42501 and any PGRST3xx are auth/RLS denials —
  // the row can never succeed, so quarantine instead of retrying. PGRST202
  // (missing function) is deliberately NOT matched by the PGRST3 prefix and
  // stays `retry`.
  const codeStr = String(err?.code ?? '').trim()
  if (codeStr === '401' || codeStr === '403' || codeStr === '42501') return 'permanent'
  if (/^PGRST3/i.test(codeStr)) return 'permanent'
  // Same denials when the code only survives inside the message text (raw
  // Postgres/PostgREST error bodies, pre-wrapped messages).
  if (/permission denied|row-level|row level|\bjwt\b|not authorized/i.test(s)) return 'permanent'
  if (/\b(401|403|42501)\b/.test(s)) return 'permanent'
  if (/PGRST3\d*/i.test(s) && !/PGRST202/i.test(s)) return 'permanent'
  return 'retry'
}

// T9: did this failure ever reach the server? Pure network/timeout failures
// (jammer, dropped connection, withTimeout abort) must NOT burn one of the
// row's MAX_DRAIN_ATTEMPTS — the scan was never attempted, so counting it
// terminally loses scans that may succeed on the next drain.
export function isNetworkNotReached(msg) {
  return /failed to fetch|timed?\s*out|abort|network\s*error|fetch failed|load failed/i.test(String(msg || ''))
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

export const MAX_QUEUE_SIZE = 2000

const DB_NAME = 'sewadar_offline_q'
const DB_VERSION = 2
const STORE = 'scan_queue'
const CACHE = 'sewadar_cache'

/**
 * QUEUE_CHANGED_EVENT — fired on `window` whenever the queue mutates
 * (enqueue, drain removal, quarantine, markFailed, clears). The app-level
 * sync engine (`offlineSync.js`) listens for it to refresh counts and kick
 * a drain, so producers never import the engine (no import cycle: the
 * engine imports this constant FROM here).
 */
export const QUEUE_CHANGED_EVENT = 'portal-queue-changed'

/** Broadcast a queue mutation. Never throws — sync must survive UI errors. */
export function notifyQueueChanged() {
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new window.CustomEvent(QUEUE_CHANGED_EVENT))
    }
  } catch {
    // A notification must never break the write it announces.
  }
}

let _dbPromise = null
let _dbInstance = null

function getDB() {
  if (_dbInstance && _dbInstance.objectStoreNames && _dbInstance.objectStoreNames.length > 0) return Promise.resolve(_dbInstance)
  if (_dbPromise) return _dbPromise
  _dbPromise = safeOpenDB(DB_NAME, DB_VERSION).then(db => {
    // A transient open failure must not wedge the module: safeOpenDB resolves
    // null (never rejects), so without this reset _dbPromise stays a
    // resolved-null forever and every later call returns null — rows on disk
    // become unreadable and undrainable until a reload. Retry next call.
    if (!db) { _dbPromise = null; return null }
    _dbInstance = db
    db.onversionchange = () => { db.close(); _dbInstance = null; _dbPromise = null }
    db.onclose = () => { _dbInstance = null; _dbPromise = null }
    return db
  }).catch(() => { _dbPromise = null; return null })
  return _dbPromise
}

// ─── enqueueScan result contract (Task A1: L-01 / L-02) ─────────────────────
// enqueueScan NEVER rejects. Every path resolves a result object:
//   { ok: true,  id, owner }                row durably written (owner null
//                                          when the session was unresolvable —
//                                          the row can never auto-drain, so
//                                          callers must say so honestly)
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
  // C5: monotonic createdAt floor — a device clock that jumps BACKWARD
  // (manual change, NTP correction, jammer-adjacent skew) must not reorder
  // already-queued rows behind new ones and invert drain order. The floor is
  // persisted in localStorage; storage exceptions (private mode) fall back
  // to Date.now().
  let createdAt = Date.now()
  // Floor against live rows too: localStorage can throw (Safari private
  // mode) while IndexedDB still works — without the row-max term a backward
  // clock jump inverts drain order (OUT before IN), orphaning the pair.
  const maxRowTs = (existing || []).reduce((m, r) => Math.max(m, Number(r?.createdAt) || 0), 0)
  try {
    const LS_KEY = 'sewadar_offline_q_last_ts'
    const last = Number(localStorage.getItem(LS_KEY) || 0)
    createdAt = Math.max(Date.now(), (Number.isFinite(last) ? last : 0) + 1, maxRowTs + 1)
    localStorage.setItem(LS_KEY, String(createdAt))
  } catch {
    // Storage unavailable — the row-max floor above still holds order.
    createdAt = Math.max(Date.now(), maxRowTs + 1)
  }
  return new Promise((resolve) => {
    let tx2 = null
    // `IDBTransaction.error` THROWS (InvalidStateError) unless the transaction
    // finished with an error — an exception inside a handler would surface as
    // an unhandled error and leave this promise PENDING. Never let that escape.
    const txError = () => { try { return tx2 ? tx2.error : null } catch { return null } }
    try {
      tx2 = db.transaction(STORE, 'readwrite')
      tx2.objectStore(STORE).put({ ...scan, id, createdAt, attempts: 0, synced: false, owner: owner ?? null })
    } catch (e) {
      // A closing connection or a non-cloneable value throws synchronously.
      resolve({ ok: false, reason: 'write-failed', error: e })
      return
    }
    tx2.oncomplete = () => { notifyQueueChanged(); resolve({ ok: true, id, owner: owner ?? null }) }
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
    tx.oncomplete = () => { notifyQueueChanged(); resolve() }
    tx.onerror = () => reject(tx.error)
    // Abort (quota, versionchange-close) fires instead of error: resolve so a
    // delete failure never burns a scan attempt — the row persists and the
    // next replay dedups by nonce, which is the correct outcome for a scan
    // the server already applied.
    tx.onabort = () => resolve()
  })
}

export async function markFailed(id) {
  const db = await getDB()
  if (!db) return
  // NOTE: deliberately no notifyQueueChanged() here. A failed attempt is not
  // new work — broadcasting it would kick a ~1s retry and burn all
  // MAX_DRAIN_ATTEMPTS in seconds, quarantining rows a transient outage
  // could have cleared. Recovery cadence comes from the poll, reconnect /
  // foreground events, and genuinely new queue writes. Counts still refresh
  // via the drain's onProgress callback.
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
      // An aborted tx (quota, versionchange-close) fires abort, never error —
      // without this the promise pends forever and latches _draining.
      tx.onabort = () => resolve()
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
    tx.oncomplete = () => { notifyQueueChanged(); resolve(doomed.length) }
    tx.onerror = () => resolve(0)
    tx.onabort = () => resolve(0)
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
    tx.oncomplete = () => { notifyQueueChanged(); resolve(doomed.length) }
    tx.onerror = () => resolve(0)
    tx.onabort = () => resolve(0)
  })
}

// T10: a null-owner row that is still live (not failed, not synced) is
// STRANDED — getQueuedScans hides it while logged in, the drain skips it,
// and clearOrphanedQueue only runs while logged out — so without surfacing,
// it sits invisible forever. This is a live predicate + a read-only list:
// pages show the rows with per-row manual Clear (removeQueued). Nothing
// here auto-drains or auto-deletes; the drain keeps skipping null-owner
// rows (cross-user safety, D1a) and clearOrphanedQueue keeps its
// logged-out-only bulk-clear semantics.
/**
 * Canonical queue-row predicates. These OWN the definitions; the scanner
 * pages used to carry private copies of both (three of them, drifting).
 * A failed row carries `failed: true` (v1) or `status: 'failed'` (newer);
 * an orphaned row is a NON-failed row with a null owner that no drain will
 * ever consume (see clearOrphanedQueue).
 */
export function isFailedQueueRow(r) {
  return !!r && (r.status === 'failed' || r.failed === true)
}

export function isOrphanedQueueRow(r) {
  return !isFailedQueueRow(r) && (r.owner ?? null) === null && !r.synced
}

export function isStrandedRow(r) {
  return !!r && !isFailedRow(r) && !r.synced && (r.owner ?? null) === null
}

export async function listStrandedQueue() {
  const db = await getDB()
  if (!db) return []
  // Owner-gated: null-owner rows are surfaced ONLY while logged out, beside
  // clearOrphanedQueue. While logged in, listing them would expose another
  // operator's queued badges (shared devices) with a working per-row delete
  // via the unscoped removeQueued — a cross-user read+delete leak.
  const uid = await resolveOwnerId(null)
  if (uid !== null) return []
  return new Promise((res) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
    req.onsuccess = () => res((req.result || []).filter(isStrandedRow))
    req.onerror = () => res([])
  })
}

// Cap policy: bulk-remove the current owner's NON-failed rows only (failed
// rows stay for clearFailedQueue; other users' / null-owner rows are never
// touched — the filter mirrors getQueuedScans visibility exactly). Wired to
// the confirmed "Clear live queued scans" page action. Returns removed count.
export async function clearLiveQueue() {
  const db = await getDB()
  if (!db) return 0
  const uid = await resolveOwnerId(null)
  const rows = await new Promise((res) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
    req.onsuccess = () => res(req.result || [])
    req.onerror = () => res([])
  })
  const doomed = rows.filter(r => !isFailedRow(r) && (r.owner ?? null) === uid)
  if (doomed.length === 0) return 0
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    for (const r of doomed) store.delete(r.id)
    tx.oncomplete = () => { notifyQueueChanged(); resolve(doomed.length) }
    tx.onerror = () => resolve(0)
    tx.onabort = () => resolve(0)
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
    // Quota breaches fire `abort`, not `error` — without this the promise
    // never settles and the caller hangs (the directory write would stall
    // a scan). Reject so callers can skip the cache and continue.
    tx.onabort = () => reject(tx.error || new Error('cache write aborted'))
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
    // Abort (quota, versionchange-close) fires instead of error — never leave
    // the promise pending.
    tx.onabort = () => reject(tx.error || new Error('cache delete aborted'))
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
      // Bounded: getSession() can perform an untimed refresh_token fetch, and
      // this runs inside the cross-tab Web Lock — an unbounded wait would
      // wedge every tab's drain. Timeout reads as logged-out (clean no-op).
      const uid = await withTimeout(resolveOwnerId(supabase), 8000, 'Drain session').catch(() => null)
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
        // C5: id tiebreak — two rows sharing a createdAt (same-ms enqueue,
        // restored rows, putRaw test rows) drain deterministically.
        .sort((a, b) => (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

      if (pending.length === 0) { _consecutiveFailures = 0; return 0 }

      // T9: badge+schedule pairs whose IN was quarantined (terminally
      // failed). An OUT for one of these pairs that then fails as
      // dedup/drop ("No open session") means the IN never landed — deleting
      // the OUT would leave zero rows and lose the pair silently. Seeded
      // from the store snapshot, extended as this drain quarantines INs.
      const failedInKeys = new Set(
        queued
          .filter(r => r.action === 'IN' && isFailedRow(r) && (r.owner ?? null) === uid)
          .map(r => `${r.badge}␟${r.schedule_id}`)
      )

      let drained = 0
      // Circuit breaker for systemic failures: consecutive `permanent`
      // outcomes (an expired fleet token, a revoked RLS policy) would
      // otherwise terminally quarantine the ENTIRE remaining queue in one
      // pass. After a short run, leave the tail live for the next pass or
      // the operator — a single poison row still quarantines and continues.
      let consecutivePermanent = 0
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
          // C3 gap: a quarantined IN orphans its badge+schedule pair — seed
          // the key now so a later OUT failing as dedup/drop is quarantined
          // (visible) instead of deleted (silent pair loss).
          if (q.action === 'IN') failedInKeys.add(`${q.badge}␟${q.schedule_id}`)
          // A bad timestamp is deterministic for THIS row, not systemic —
          // it must not count toward the permanent circuit breaker.
          consecutivePermanent = 0
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
              // scan_out declares (p_badge, p_schedule, p_ts, p_open_id,
              // p_is_manual) since v67 — an extra p_nonce makes PostgREST
              // return PGRST202 and the row below is marked failed +
              // head-of-line-blocks the queue.
              // v67: queued OUTs keep their audit flag end to end (M8 covers
              // IN; the OUT half was structurally unrecoverable before).
              supabase.rpc('scan_out', { p_badge: q.badge, p_schedule: q.schedule_id, p_ts: ts, p_open_id: q.open_id || null, p_is_manual: q.is_manual || false }),
              10000,
              `Drain OUT`
            )
            if (error) throw error
          }
          await removeQueued(q.id)
          drained++
          // Decay sticky backoff on forward progress (else ~6 blips pin 60s forever).
          consecutivePermanent = 0
          _consecutiveFailures = Math.max(0, _consecutiveFailures - 1)
          onProgress?.(q, true)
        } catch (e) {
          const msg = String(e?.message || '')
          const kind = classifyScanError(msg, e)
          if (kind === 'dedup' || kind === 'drop') {
            // T9: an OUT orphaned by its quarantined IN is quarantined, NOT
            // deleted — both rows stay visible for manual recovery instead
            // of vanishing as a pair.
            // C3: dedup-delete is IN-only ('Already IN' on an IN means the
            // server holds the session — safe to drop). An OUT that fails as
            // dedup/drop ('No open session' etc.) is quarantined, never
            // deleted, so it stays visible for manual recovery.
            if (q.action === 'OUT' && failedInKeys.has(`${q.badge}␟${q.schedule_id}`)) {
              await quarantineRow(q.id, msg.slice(0, 160) || kind)
            } else if (q.action === 'OUT') {
              await quarantineRow(q.id, msg.slice(0, 160) || kind)
            } else if (q.action === 'IN' && q.uncertain && /Already IN/.test(msg)) {
              // C6: an uncertain IN answered 'Already IN' means the server
              // holds an open session this device never saw (the online IN
              // landed but its response was lost, or another device scanned
              // first) — the operator's second scan was almost certainly the
              // OUT. Attempt it now (resolve the real open session, close
              // exactly that id) and only then drop the row. Any failure
              // quarantines instead of deleting: the pair stays visible for
              // manual recovery.
              let outOk = false
              try {
                const { data: openData, error: openError } = await withTimeout(
                  supabase.rpc('get_open_session', { p_badge: q.badge, p_schedule: q.schedule_id }),
                  10000,
                  'Drain OUT'
                )
                if (openError) throw openError
                const openRow = Array.isArray(openData) ? openData[0] : openData
                if (!openRow?.id) throw new Error('No open session to close', { cause: e })
                // The escalation closes a session discovered NOW — stamp now,
                // not the queued IN's ts, which can predate the foreign
                // session's in_time and fail 'OUT time must be after IN time'.
                const { error: outError } = await withTimeout(
                  supabase.rpc('scan_out', { p_badge: q.badge, p_schedule: q.schedule_id, p_ts: new Date().toISOString(), p_open_id: openRow.id, p_is_manual: q.is_manual || false }),
                  10000,
                  'Drain OUT'
                )
                if (outError) throw outError
                outOk = true
              } catch (e2) {
                await quarantineRow(q.id, String(e2?.message || msg).slice(0, 160) || kind)
              }
              if (outOk) {
                await removeQueued(q.id)
                drained++
                consecutivePermanent = 0
                _consecutiveFailures = Math.max(0, _consecutiveFailures - 1)
                onProgress?.(q, true)
                continue
              }
            } else {
              // Dedup/drop: the row is gone (already applied server-side or
              // never retryable) — report success, not failure. The old code
              // fell through to `onProgress?.(q, false, e)` below, so every
              // cleanly-deduped replay painted the UI as a failed sync.
              await removeQueued(q.id)
              drained++
              consecutivePermanent = 0
              _consecutiveFailures = Math.max(0, _consecutiveFailures - 1)
              onProgress?.(q, true)
            }
          } else if (kind === 'permanent') {
            await quarantineRow(q.id, msg.slice(0, 160) || 'permanent')
            if (q.action === 'IN') failedInKeys.add(`${q.badge}␟${q.schedule_id}`)
            onProgress?.(q, false, e)
            consecutivePermanent++
            if (consecutivePermanent >= 3) {
              // Systemic failure, not a poison row: stop this pass with the
              // tail still live instead of quarantining hundreds of rows.
              _consecutiveFailures++
              break
            }
          } else {
            // T9: pure network/timeout failures never reached the server —
            // back off and break WITHOUT burning one of the row's
            // MAX_DRAIN_ATTEMPTS. Server-reached retries still markFailed.
            // C1: the drain's OWN withTimeout ('Drain IN/OUT timed out') is
            // the exception — withTimeout abandons the race WITHOUT
            // cancelling the in-flight request, so the server may HAVE
            // applied the scan. Treat as server-possibly-reached: burn ONE
            // attempt (bounded by MAX_DRAIN_ATTEMPTS via markFailed), then
            // break + backoff.
            // C4: PGRST202 (missing RPC = frontend shipped before the
            // migration — self-healing deploy ordering) is skipped like a
            // network error: still break + backoff, but burn no attempt, so
            // the row is retried after the deploy lands instead of counting
            // down to terminal.
            const codeStr = String(e?.code ?? '')
            if (/Drain (IN|OUT).*timed out/.test(msg)) {
              await markFailed(q.id)
            } else if (!isNetworkNotReached(msg) && !/PGRST202/i.test(msg) && !/PGRST202/i.test(codeStr)) {
              await markFailed(q.id)
            }
            _consecutiveFailures++
            onProgress?.(q, false, e)
            break // network error — stop draining, backoff
          }
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

/**
 * @deprecated Superseded by the app-level engine in `offlineSync.js`
 * (`installOfflineSync` at boot + `subscribeOfflineSync` in components),
 * which survives page navigation. Retained for its unit test and as a
 * standalone drain loop — do NOT wire it into pages again: a page-scoped
 * drainer dies on unmount and stalls the queue.
 */
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
