/**
 * Frontend/DB version handshake (L-07).
 *
 * The database evolves in separate deploys (sql/vNN), so the app never
 * assumes its RPCs exist. The registry lives in public.portal_version
 * (v50) with portal_app_version() as the single choke point; this module
 * is the client side: fetch once per session, compare against the floor
 * this frontend was built for, and let DbVersionBanner say so when the
 * database is behind (or unreadable).
 */

/** Oldest DB this frontend works with. Bump when the frontend starts
 *  calling RPCs/columns a migration introduces. v81: department shift
 *  cutoffs and timing tags (is_late_in, is_early_out) on
 *  dp_attendance_sessions — without it the SCAN_LOG_SESSION_COLS select
 *  fails with PGRST204. v79: the scan-log select
 *  reads dp_attendance_sessions.is_auto_out — the 21:00 IST auto-out tag —
 *  without it the shared SCAN_LOG_SESSION_COLS select fails with PGRST204
 *  and BOTH logs (Attendance Logs, Previsit Logs) go empty rather than
 *  losing one column. v82: scanner composite indexes (idx_dp_att_scanner_in,
 *  idx_dp_att_scanner_out) for 150-scanner high concurrency. */
export const MIN_SUPPORTED_DB_VERSION = 'v82'

/**
 * 'v50' → 50. Letter suffixes ('v38b') compare by their number — the
 * suffix marks a same-release fix, never a newer schema generation.
 * Anything unorderable → null (caller reports 'unknown', never 'stale').
 */
export function parseDbVersion(v) {
  const m = /^v(\d+)/i.exec(String(v || '').trim())
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

/**
 * 'ok' | 'stale' | 'unknown'. Unknown (unreadable either side) is its own
 * state: a DB that cannot answer is not proven behind, and the banner
 * copy differs ("couldn't confirm" vs "is behind").
 */
export function dbVersionStatus(dbVersion, minVersion = MIN_SUPPORTED_DB_VERSION) {
  const db = parseDbVersion(dbVersion)
  const min = parseDbVersion(minVersion)
  if (db === null || min === null) return 'unknown'
  return db >= min ? 'ok' : 'stale'
}

/**
 * Ask the database for its version. Null on every failure mode — a
 * missing function (PGRST202: DB predates the handshake), a denial, or
 * a dropped connection all mean "unconfirmed", never a throw, so boot
 * can never die on this check.
 */
export async function fetchDbVersion(supabase) {
  try {
    const { data, error } = await supabase.rpc('portal_app_version')
    if (error) return null
    const v = String(data ?? '').trim()
    return v || null
  } catch {
    return null
  }
}
