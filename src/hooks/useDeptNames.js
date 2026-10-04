import { useState, useEffect, useCallback } from 'react'
import { fetchAllRows } from '../lib/supabase'
import { readDeptMap, writeDeptMap } from '../lib/sewadarDirectory'

/**
 * useDeptNames — offline-first department reference data for the scanner.
 *
 * The scan popup and the recent-scans tables resolve every department id
 * through `deptNameById`. That map used to come from a live fetch only, so
 * an offline reload emptied it and every offline popup lost its Dept pill —
 * even when the cached directory knew the dept id. This hook seeds state
 * from the IndexedDB snapshot first (offline reloads name departments from
 * here alone), then `syncDepts` writes through on every successful live
 * fetch. A live fetch that returns zero rows never overwrites a good cache
 * (RLS scoping can legitimately return empty).
 *
 * @returns {[Array, function]} [depts, syncDepts] — syncDepts(rows) sets
 * state + persists only when rows is non-empty; returns true when stored.
 */
export function useDeptNames() {
  const [depts, setDepts] = useState([])

  // Instant: cached snapshot first (offline works from here alone).
  useEffect(() => {
    let alive = true
    readDeptMap()
      .then((cached) => {
        if (alive && cached.length > 0) setDepts((prev) => (prev.length > 0 ? prev : cached))
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  const syncDepts = useCallback((rows) => {
    if (!Array.isArray(rows) || rows.length === 0) return false
    setDepts(rows)
    // Persist best-effort: quota failure must never break the page.
    writeDeptMap(rows).catch(() => {})
    return true
  }, [])

  return [depts, syncDepts]
}

/**
 * Standalone refresh used by pages that fetch departments inside a larger
 * load: fetches the global list and syncs it (state + cache). Never throws —
 * a failed fetch keeps the cached names.
 *
 * @param {function} syncDepts — from useDeptNames
 * @returns {Promise<boolean>} true when live rows landed
 */
export async function refreshDeptNames(syncDepts) {
  try {
    const rows = await fetchAllRows('deployment_departments', 'id,name', (q) => q.order('name'), 'id')
    return syncDepts(rows || [])
  } catch (e) {
    console.warn('[Directory] department refresh failed — keeping cache:', e?.message)
    return false
  }
}
