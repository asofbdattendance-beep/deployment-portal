// Offline queue — IndexedDB (robust, no data loss under jammers)
import { safeOpenDB, CACHE_TTL, MAX_DRAIN_ATTEMPTS, withTimeout } from './scannerUtils'

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
  // Check queue size
  const tx = db.transaction(STORE, 'readonly')
  const count = await new Promise((resolve, reject) => {
    const req = tx.objectStore(STORE).count()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  if (count >= MAX_QUEUE_SIZE) {
    console.warn('[OfflineQueue] Queue full, rejecting scan')
    return null
  }
  const id = scan.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return new Promise((resolve, reject) => {
    const tx2 = db.transaction(STORE, 'readwrite')
    tx2.objectStore(STORE).put({ ...scan, id, createdAt: Date.now(), attempts: 0, synced: false })
    tx2.oncomplete = () => resolve(id)
    tx2.onerror = () => reject(tx2.error)
  })
}

export async function getQueuedScans() {
  const db = await getDB()
  if (!db) return []
  return new Promise((res, rej) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
    req.onsuccess = () => res(req.result || [])
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
        store.put({ ...v, attempts, failed })
      }
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve() // don't throw — best-effort
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

// drain — called on online, visibility, interval
export async function drainQueue(supabase, onProgress) {
  if (_draining) return // mutex — prevent re-entrant drains
  _draining = true
  try {
    const db = await getDB()
    if (!db) return
    const queued = await new Promise((res) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).getAll()
      req.onsuccess = () => res(req.result || [])
      req.onerror = () => res([])
    })
    const pending = queued.filter(q => !q.synced && !q.failed).sort((a, b) => a.createdAt - b.createdAt)

    if (pending.length === 0) { _consecutiveFailures = 0; return }

    for (const q of pending) {
      try {
        const ts = new Date(q.ts).toISOString()
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
  } finally {
    _draining = false
  }
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
