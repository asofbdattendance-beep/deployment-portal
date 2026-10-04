import { useState, useEffect, useCallback } from 'react'
import { fetchAllRows } from '../lib/supabase'
import { buildDirectoryMap, readDirectory, writeDirectory } from '../lib/sewadarDirectory'

/**
 * useSewadarDirectory — mobile offline-first identity cache for the scanner.
 *
 * Returns a Map<UPPER_BADGE, {badge,name,centre,deptId}> built from the
 * schedule's `deployments` rows (RLS already scopes to the scanner's subtree).
 * Served stale-while-revalidate: the IndexedDB snapshot renders immediately,
 * then a background refresh replaces it when online.
 *
 * Mobile-only by contract: pages pass `enabled: isMobile`. Desktop keeps an
 * empty Map (RPC-only path, zero behavior change).
 *
 * Identity ONLY — never session state. A stale directory can mislabel a
 * popup; it can never miswrite, because direction and writes stay server-side.
 */
export function useSewadarDirectory({ scheduleId, enabled }) {
  const [map, setMap] = useState(() => new Map())

  const refresh = useCallback(async () => {
    if (!enabled || !scheduleId) return
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return
    try {
      const rows = await fetchAllRows(
        'deployments',
        'badge_number,sewadar_name,centre,department_id,deployed_department_id',
        (q) => q.eq('schedule_id', scheduleId),
        'id',
      )
      // VSS badges have no deployment row — the roster fills them best-effort.
      // RLS may deny it (or the table may predate a column): a denial must
      // never fail the deployments directory, so it is caught separately.
      let vss = []
      try {
        vss = await fetchAllRows(
          'vss_sewadars',
          'badge_number,sewadar_name,centre,department',
          null,
          'badge_number',
        ) || []
      } catch (e) {
        console.warn('[Directory] VSS roster unreadable — VSS badges stay RPC-only:', e?.message)
      }
      const list = rows || []
      if (list.length === 0) {
        // Never poison a good cache with an empty fetch: RLS scoping (a
        // centre outside the subtree reads ZERO rows, no error) or a partial
        // failure would otherwise wipe names until the next good fetch.
        const cached = await readDirectory(scheduleId).catch(() => null)
        if (cached && cached.count > 0) {
          console.warn('[Directory] fetch returned 0 rows with a cached snapshot — keeping cache')
          setMap(cached.map)
          return
        }
      }
      setMap(buildDirectoryMap(list, vss))
      // Persist best-effort: quota failure resolves false, session Map stands.
      writeDirectory(scheduleId, list, vss).catch(() => {})
    } catch (e) {
      console.warn('[Directory] refresh failed — keeping cache:', e?.message)
    }
  }, [enabled, scheduleId])

  useEffect(() => {
    if (!enabled || !scheduleId) { setMap(new Map()); return }
    let alive = true
    // Instant: cached snapshot first (offline works from here alone).
    readDirectory(scheduleId)
      .then((cached) => { if (alive && cached.count > 0) setMap(cached.map) })
      .catch(() => {})
      .finally(() => { if (alive) refresh() })
    return () => { alive = false }
  }, [enabled, scheduleId, refresh])

  // Revalidate on reconnect: deployments finalized while offline land here.
  useEffect(() => {
    if (!enabled) return
    window.addEventListener('online', refresh)
    return () => window.removeEventListener('online', refresh)
  }, [enabled, refresh])

  return map
}
