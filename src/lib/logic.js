// Pure domain logic — no Supabase client, so it's unit-testable.

export const ELDERLY_BADGE_STATUS = 'ELDERLY'

// Supabase filter fragment that excludes elderly badges (null-safe)
export function notElderlyFilter() {
  return 'badge_status.is.null,badge_status.neq.ELDERLY'
}

export function isElderly(badge_status) {
  return String(badge_status || '').toUpperCase() === ELDERLY_BADGE_STATUS
}

/* ─── Centre hierarchy ─── */

export function getParentCentres(centres) {
  return (centres || []).filter(c => !c.parent_centre)
}

export function getRootCentre(centres, centreName) {
  if (!centreName) return null
  const byName = {}
  ;(centres || []).forEach(c => { byName[c.name] = c })
  let cur = byName[centreName]
  if (!cur) return centreName
  let guard = 0
  while (cur.parent_centre && byName[cur.parent_centre] && guard < 20) {
    cur = byName[cur.parent_centre]
    guard++
  }
  return cur.name
}

export function getSubtreeCentres(centres, centreName) {
  if (!centreName) return []
  const children = {}
  ;(centres || []).forEach(c => {
    if (!children[c.parent_centre]) children[c.parent_centre] = []
    children[c.parent_centre].push(c.name)
  })
  const result = []
  const stack = [centreName]
  let guard = 0
  while (stack.length && guard < 100) {
    const cur = stack.pop()
    result.push(cur)
    ;(children[cur] || []).forEach(ch => stack.push(ch))
    guard++
  }
  return result
}

/* ─── Quota math ───
   Given: savedCounts = { deptId: n } already persisted,
          localCounts = { deptId: n } current (incl. unsaved edits),
          allocations = [{ department_id, centre, max_count }] for caller's root
   Returns: { [deptId]: { max, used, local, rem } }
   rem = max - local (can go negative if over)                      */

export function computeDeptQuota(allocations, savedCounts, localCounts) {
  const out = {}
  ;(allocations || []).forEach(a => {
    const used = savedCounts[a.department_id] || 0
    const local = localCounts[a.department_id] || 0
    out[a.department_id] = { max: a.max_count, used, local, rem: a.max_count - local }
  })
  return out
}

/* ─── Eligibility ─── */

export function isEligible(consentRow, dept) {
  if (!consentRow || !dept) return false
  if (!consentRow.consent_given) return false
  const daysOk = (consentRow.available_days_count ?? 0) >= (dept.min_days ?? 1)
  const bhatiOk = !dept.requires_stay_at_bhati || !!consentRow.stay_at_bhati
  const initiatedOk = !dept.requires_initiated || !!consentRow.is_initiated
  return daysOk && bhatiOk && initiatedOk
}

export function eligibilityReasons(consentRow, dept) {
  if (!consentRow || !dept) return ['Department not found']
  if (!consentRow.consent_given) return ['Consent not given']
  const reasons = []
  if ((consentRow.available_days_count ?? 0) < (dept.min_days ?? 1)) {
    reasons.push(`Needs minimum ${dept.min_days} consent day${dept.min_days > 1 ? 's' : ''} (has ${consentRow.available_days_count ?? 0})`)
  }
  if (dept.requires_stay_at_bhati && !consentRow.stay_at_bhati) {
    reasons.push('Requires stay at bhati')
  }
  if (dept.requires_initiated && !consentRow.is_initiated) {
    reasons.push('Requires initiated sewadar')
  }
  return reasons
}

/* ─── Prev-year attendance ─── */

export const TRAFFIC_OUTSIDE_BHATI = 'TRAFFIC OUTSIDE BHATI'

// Attendance denominator: 3 for TRAFFIC OUTSIDE BHATI, otherwise 5
export function attendanceDenominator(prevDepartment) {
  return prevDepartment === TRAFFIC_OUTSIDE_BHATI ? 3 : 5
}

export function attendanceDisplay(prevAttendance, prevDepartment) {
  if (prevAttendance == null) return null
  const denom = attendanceDenominator(prevDepartment)
  return `${Math.min(prevAttendance, denom)} / ${denom}`
}

// Low attendance: 0,1 always; 2 only if not TRAFFIC OUTSIDE BHATI
export function isLowAttendance(prevAttendance, prevDepartment) {
  if (prevAttendance == null) return false
  if (prevAttendance <= 1) return true
  return prevAttendance === 2 && prevDepartment !== TRAFFIC_OUTSIDE_BHATI
}
