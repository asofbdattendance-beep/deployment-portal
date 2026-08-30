// Offline queue — IndexedDB (robust, no data loss under jammers)
const DB_NAME = 'sewadar_offline_q'
const STORE = 'scan_queue'
const CACHE = 'sewadar_cache'

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(CACHE)) db.createObjectStore(CACHE, { keyPath: 'key' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function enqueueScan(scan) {
  const db = await openDB()
  const tx = db.transaction(STORE, 'readwrite')
  const id = scan.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  tx.objectStore(STORE).put({ ...scan, id, createdAt: Date.now(), attempts: 0, synced: false })
  return id
}

export async function getQueuedScans() {
  const db = await openDB()
  return new Promise((res, rej) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
    req.onsuccess = () => res(req.result || [])
    req.onerror = () => rej(req.error)
  })
}

export async function removeQueued(id) {
  const db = await openDB()
  db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id)
}

export async function markFailed(id) {
  const db = await openDB()
  const tx = db.transaction(STORE, 'readwrite')
  const store = tx.objectStore(STORE)
  const get = store.get(id)
  get.onsuccess = () => {
    const v = get.result
    if (v) store.put({ ...v, attempts: (v.attempts || 0) + 1, failed: (v.attempts || 0) > 8 })
  }
}

export async function cacheSet(key, value) {
  const db = await openDB()
  db.transaction(CACHE, 'readwrite').objectStore(CACHE).put({ key, value, at: Date.now() })
}
export async function cacheGet(key) {
  const db = await openDB()
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
  return (await cacheGet(`deployed:${scheduleId}`)) || []
}

// drain — called on online, visibility, interval
export async function drainQueue(supabase, onProgress) {
  const queued = await getQueuedScans()
  const pending = queued.filter(q => !q.synced && !q.failed).sort((a,b)=>a.createdAt-b.createdAt)
  for (const q of pending) {
    try {
      const ts = new Date(q.ts).toISOString()
      if (q.action === 'IN') {
        const { error } = await supabase.rpc('scan_in', { p_badge: q.badge, p_schedule: q.schedule_id, p_ts: ts, p_nonce: q.id, p_centre: q.centre })
        if (error) throw error
      } else {
        const { error } = await supabase.rpc('scan_out', { p_badge: q.badge, p_schedule: q.schedule_id, p_ts: ts, p_open_id: q.open_id || null })
        if (error) throw error
      }
      await removeQueued(q.id)
      onProgress?.(q, true)
    } catch (e) {
      const msg = String(e?.message || '')
      if (msg.includes('Already IN') || msg.includes('No open session')) {
        // ladder violation from stale queue order — keep for manual resolution
        await markFailed(q.id)
      } else if (msg.includes('Invalid badge') || msg.includes('Badge not found')) {
        await removeQueued(q.id) // permanent fail, drop
      } else {
        await markFailed(q.id)
        throw e // network — stop draining, retry later
      }
      onProgress?.(q, false, e)
    }
  }
}

export function installDrainListeners(supabase, cb) {
  const fn = () => drainQueue(supabase, cb).catch(()=>{})
  window.addEventListener('online', fn)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') fn() })
  const id = setInterval(fn, 7000)
  return () => { window.removeEventListener('online', fn); clearInterval(id) }
}
