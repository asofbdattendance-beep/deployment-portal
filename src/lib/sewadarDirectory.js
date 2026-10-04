/**
 * Sewadar directory — the mobile offline-first identity cache.
 *
 * The scan popup needs a name / home centre / department BEFORE anything is
 * written, but the live answer (`get_scan_state`) needs the network. On
 * phones we keep a per-schedule directory in IndexedDB (`sewadar_cache`
 * store, already provisioned — no version bump), sourced from `deployments`
 * rows the scanner role may already read (deploy_v2_read: subtree centres).
 * The directory answers IDENTITY only — never session state (open/closed)
 * and never direction. The server stays authoritative for writes and for
 * IN-vs-OUT; a stale directory can only mislabel a popup, never miswrite.
 *
 * Conflict/staleness strategy (explicit): stale-while-revalidate. Reads
 * serve the cached snapshot immediately (with `stale: true` past TTL);
 * pages refresh in the background when online. A directory updated by
 * finalization lands on the next'De online refresh — worst case the popup
 * shows the previous department until then.
 *
 * Quota handling: a QuotaExceededError (or any write failure) skips the
 * cache silently — the caller still gets the in-memory Map for the session.
 * The outbox is never touched here.
 */

import { cacheGet, cacheSet } from './offlineQueue'

/** Directory older than this is served stale (still usable, flagged). */
export const DIRECTORY_TTL = 60 * 60 * 1000 // 1 hour

const dirKey = (scheduleId) => `dir:${scheduleId}`
const dirAtKey = (scheduleId) => `dir_at:${scheduleId}`

/**
 * Normalizes one deployments row to a directory entry. Effective department
 * mirrors the server rule (v57/v65): deployed (final) beats requested.
 *
 * @param {object} row
 * @returns {{badge: string, name: string|null, centre: string|null, deptId: string|null, deptName: string|null}|null}
 */
export function toDirectoryEntry(row) {
  if (!row || typeof row !== 'object') return null
  const badge = String(row.badge_number ?? '').trim().toUpperCase()
  if (!badge) return null
  const clean = (v) => {
    if (typeof v !== 'string') return null
    const t = v.trim()
    return t === '' ? null : t
  }
  return {
    badge,
    name: clean(row.sewadar_name),
    centre: clean(row.centre),
    deptId: clean(row.deployed_department_id) ?? clean(row.department_id),
    deptName: null,
  }
}

/**
 * Normalizes one vss_sewadars roster row. VSS badges have no deployment row,
 * so they were invisible offline by construction — the roster carries the
 * department as a NAME (not an id), passed straight through as deptName.
 */
export function toVssEntry(row) {
  if (!row || typeof row !== 'object') return null
  const badge = String(row.badge_number ?? '').trim().toUpperCase()
  if (!badge) return null
  const clean = (v) => {
    if (typeof v !== 'string') return null
    const t = v.trim()
    return t === '' ? null : t
  }
  return { badge, name: clean(row.sewadar_name), centre: clean(row.centre), deptId: null, deptName: clean(row.department) }
}

/**
 * Builds the lookup Map from raw rows. One badge can hold rows under more
 * than one centre key — keep the row with a FINAL (deployed) department,
 * else the first row seen. Mirrors the server's deployed-beats-requested
 * ordering without pretending to be the server.
 *
 * VSS roster rows (second arg) fill badges with NO deployment row only — a
 * deployment entry is never overwritten by a roster one.
 *
 * @param {Array} rows — deployments rows
 * @param {Array} vssRows — vss_sewadars roster rows (raw)
 * @returns {Map<string, {badge,name,centre,deptId,deptName}>} keyed by UPPER badge
 */
export function buildDirectoryMap(rows, vssRows = []) {
  const map = new Map()
  const finalized = new Set()
  if (!Array.isArray(rows)) rows = []
  for (const row of rows) {
    const e = toDirectoryEntry(row)
    if (!e) continue
    const prev = map.get(e.badge)
    if (!prev) {
      map.set(e.badge, e)
      if (isFinalRow(row)) finalized.add(e.badge)
      continue
    }
    // Upgrade a merely-requested entry when the finalized row arrives —
    // never downgrade back.
    if (!finalized.has(e.badge) && isFinalRow(row)) {
      map.set(e.badge, e)
      finalized.add(e.badge)
    }
  }
  if (Array.isArray(vssRows)) {
    for (const row of vssRows) {
      const e = toVssEntry(row)
      if (!e || map.has(e.badge)) continue
      map.set(e.badge, e)
    }
  }
  return map
}

function isFinalRow(row) {
  const v = row?.deployed_department_id
  return typeof v === 'string' ? v.trim() !== '' : v != null
}

/**
 * Looks up one badge. Returns null (never undefined) on any miss.
 *
 * @param {Map|null|undefined} map
 * @param {string} badge
 */
export function directoryLookup(map, badge) {
  if (!map || typeof map.get !== 'function') return null
  const key = String(badge ?? '').trim().toUpperCase()
  if (!key) return null
  return map.get(key) ?? null
}

/**
 * Persists a freshly fetched directory. Quota/IDB failures resolve false
 * (cache skipped) — never throws, never touches the outbox.
 *
 * @param {string} scheduleId
 * @param {Array} rows — raw deployments rows
 * @param {Array} vssRows — raw vss_sewadars roster rows
 * @returns {Promise<boolean>} true when persisted
 */
export async function writeDirectory(scheduleId, rows, vssRows = []) {
  if (!scheduleId || !Array.isArray(rows)) return false
  try {
    await cacheSet(dirKey(scheduleId), { rows, vss: Array.isArray(vssRows) ? vssRows : [] })
    await cacheSet(dirAtKey(scheduleId), Date.now())
    return true
  } catch {
    return false
  }
}
/**
 * Reads the cached directory. Always resolves (never rejects):
 * `{ map, stale, count }` — `stale` true when missing OR past TTL.
 * A missing/expired cache is NOT an error: the caller falls back to RPC.
 *
 * @param {string} scheduleId
 * @returns {Promise<{map: Map, stale: boolean, count: number}>}
 */
export async function readDirectory(scheduleId) {
  if (!scheduleId) return { map: new Map(), stale: true, count: 0 }
  let stored
  let at
  try {
    stored = await cacheGet(dirKey(scheduleId))
    at = await cacheGet(dirAtKey(scheduleId))
  } catch {
    return { map: new Map(), stale: true, count: 0 }
  }
  // Shape evolution: v1 stored a bare rows array; v2 stores {rows, vss}.
  const rows = Array.isArray(stored) ? stored : stored?.rows
  const vss = Array.isArray(stored) ? [] : stored?.vss
  const map = buildDirectoryMap(rows, vss)
  const stale = !Array.isArray(rows) || rows.length === 0
    || typeof at !== 'number' || Date.now() - at > DIRECTORY_TTL
  return { map, stale, count: map.size }
}
