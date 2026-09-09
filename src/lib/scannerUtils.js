/**
 * Scanner shared utilities — robustness layer for BarcodeScanner, ScannerPage,
 * DeptInchargePage, and offlineQueue.
 */

// ─── Constants ────────────────────────────────────────────────────────────────
export const SCAN_RPC_TIMEOUT = 8000   // ms — scan_in / scan_out
export const SESSION_RPC_TIMEOUT = 5000 // ms — get_open_session
export const CAMERA_INIT_TIMEOUT = 10000 // ms — getUserMedia + play
export const BUSY_SAFETY_TIMEOUT = 15000 // ms — auto-reset stuck busy flag
export const CACHE_TTL = 10 * 60 * 1000 // 10 minutes for preloadDeployed cache
export const MAX_DRAIN_ATTEMPTS = 12     // after this, mark permanently failed

// ─── withTimeout ──────────────────────────────────────────────────────────────
/**
 * Wraps a promise with a timeout. Rejects with a descriptive error if the
 * promise doesn't resolve within `ms` milliseconds.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} [label] — descriptive label for the error message
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms = 8000, label = 'Operation') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return Promise.race([
    promise.catch(e => { throw e; }),
    new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(new Error(`${label} timed out after ${ms}ms`));
      });
    })
  ]).finally(() => clearTimeout(timer));
}

// ─── safeOpenDB ───────────────────────────────────────────────────────────────
/**
 * Opens IndexedDB with error handling. Returns null if IndexedDB is unavailable
 * (private browsing, storage quota, unsupported browser).
 *
 * @param {string} dbName
 * @param {number} version
 * @returns {Promise<IDBDatabase | null>}
 */
export function safeOpenDB(dbName, version) {
  return new Promise((resolve) => {
    try {
      if (!window.indexedDB) { resolve(null); return }
      const req = window.indexedDB.open(dbName, version)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('scan_queue')) db.createObjectStore('scan_queue', { keyPath: 'id' })
        if (!db.objectStoreNames.contains('sewadar_cache')) db.createObjectStore('sewadar_cache', { keyPath: 'key' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => { console.warn('[Scanner] IndexedDB open failed:', req.error); resolve(null) }
      // Some browsers fire onerror for quota/privacy — also handle blocked
      req.onblocked = () => { console.warn('[Scanner] IndexedDB blocked'); resolve(null) }
    } catch (e) {
      console.warn('[Scanner] IndexedDB unavailable:', e)
      resolve(null)
    }
  })
}

// ─── friendly ─────────────────────────────────────────────────────────────────
/**
 * Converts raw RPC / network error messages into human-readable strings.
 * Single source of truth — replaces the duplicated `friendly()` in both pages.
 *
 * @param {string} msg
 * @returns {string}
 */
export function friendly(msg) {
  const s = String(msg || '')
  if (s.includes('Invalid badge')) return 'Invalid badge format'
  if (s.includes('Badge not found')) return 'Badge not found in sewadars/VSS'
  if (s.includes('No open session')) return 'No open session to close'
  if (s.includes('Not authorized')) return 'Not authorized to scan'
  if (s.includes('Already IN')) return 'Already checked IN — please OUT first'
  if (s.includes('timed out')) return s // pass through timeout messages
  if (s.includes('Failed to fetch')) return 'Network error — will retry when online'
  return s || 'Scan failed — try again'
}

// ─── todayStrIST ──────────────────────────────────────────────────────────────
const IST_DATE_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' })

/**
 * Returns today's date as YYYY-MM-DD in IST timezone.
 * @returns {string}
 */
export function todayStrIST(d = new Date()) {
  return IST_DATE_FMT.format(d)
}
