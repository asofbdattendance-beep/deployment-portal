// Previous-session reference for the Consent & Deployment page.
//
// "Prev. Dept" / "Attendance Reported" come from the schedule that came
// immediately before the selected one (RPC prev_session_reference, v84).
// When there is no earlier schedule in the portal — or the RPC is not
// deployed yet — the page keeps using the one-off prev_year_deployments
// import, so the first portal schedule renders exactly as before.

const toEntry = (row) => ({
  prev_department: row.prev_department ?? null,
  attendance_reported: row.attendance_reported ?? null,
})

const rank = (entry) => entry.attendance_reported ?? -1

function indexByBadge(rows) {
  const map = {}
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !row.badge_number) continue
    const entry = toEntry(row)
    const existing = map[row.badge_number]
    // a badge listed under two centres: keep the stronger record
    if (!existing || rank(entry) > rank(existing)) map[row.badge_number] = entry
  }
  return map
}

/**
 * @param {{prev_schedule_id?: string|null, prev_schedule_name?: string|null, rows?: object[]}|null|undefined} rpcData
 * @param {object[]|null|undefined} legacyRows prev_year_deployments rows
 * @returns {{source: 'session'|'legacy', prevScheduleName: string|null, map: Record<string, {prev_department: string|null, attendance_reported: number|null}>}}
 */
export function buildPrevReference(rpcData, legacyRows) {
  if (rpcData && rpcData.prev_schedule_id) {
    return {
      source: 'session',
      prevScheduleName: rpcData.prev_schedule_name ?? null,
      map: indexByBadge(rpcData.rows),
    }
  }
  return { source: 'legacy', prevScheduleName: null, map: indexByBadge(legacyRows) }
}

/** Deployed in the previous session but scanned in on zero visit days. */
export function isNotReported(prevAttendance, prevDepartment) {
  return !!prevDepartment && prevAttendance === 0
}
