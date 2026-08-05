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

/* ─── Quota math (shared across regular + VSS) ───
   Regular and VSS sewadars both write to the same `deployments` table and
   share each department's max_count. Each page only holds one population's
   rows locally, so the "effective" count must add the OTHER population's
   persisted assignments:
       effective = savedAll + (localOwn − savedOwn)
   Given: savedAll = { deptId: n } all persisted deployments (regular + VSS),
          localOwn = { deptId: n } this page's current rows (incl. unsaved edits),
          savedOwn = { deptId: n } this page's persisted deployments,
          allocations = [{ department_id, centre, max_count }] for caller's root
   Returns: { [deptId]: { max, used, local, own, effective, rem } }
   rem = max - effective (can go negative if over)                  */

export function computeDeptQuota(allocations, savedAll, localOwn, savedOwn) {
  const out = {}
  ;(allocations || []).forEach(a => {
    const used = savedAll[a.department_id] || 0
    const local = localOwn[a.department_id] || 0
    const own = (savedOwn && savedOwn[a.department_id]) || 0
    const effective = used + (local - own)
    out[a.department_id] = { max: a.max_count, used, local, own, effective, rem: a.max_count - effective }
  })
  return out
}

// VSS badges are prefixed with "VS" (e.g. VSFB5971GB4629)
export function isVssBadge(badge) {
  return typeof badge === 'string' && /^VS/i.test(badge)
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

/* ─── VSS eligibility (only for departments with include_vss = true) ─── */

export function isEligibleVss(consentRow, vssSewadar, dept) {
  if (!consentRow || !dept) return false
  if (!dept.include_vss) return false
  if (!consentRow.consent_given) return false
  if (vssSewadar && !vssSewadar.is_active) return false
  const daysOk = (consentRow.available_days_count ?? 0) >= (dept.vss_min_days ?? 1)
  const bhatiOk = !dept.vss_requires_stay_at_bhati || !!consentRow.stay_at_bhati
  const initiatedOk = !dept.vss_requires_initiated || !!vssSewadar?.is_initiated
  const genderOk = !dept.vss_requires_gender || (vssSewadar?.gender || '') === dept.vss_requires_gender
  return daysOk && bhatiOk && initiatedOk && genderOk
}

export function vssEligibilityReasons(consentRow, vssSewadar, dept) {
  if (!consentRow || !dept) return ['Department not found']
  if (!dept.include_vss) return ['Department not opened for VSS']
  if (!consentRow.consent_given) return ['Consent not given']
  if (vssSewadar && !vssSewadar.is_active) {
    return [`Cannot deploy — ${vssSewadar.remarks || 'inactive VSS sewadar'}`]
  }
  const reasons = []
  if ((consentRow.available_days_count ?? 0) < (dept.vss_min_days ?? 1)) {
    reasons.push(`Needs minimum ${dept.vss_min_days} consent day${dept.vss_min_days > 1 ? 's' : ''} (has ${consentRow.available_days_count ?? 0})`)
  }
  if (dept.vss_requires_stay_at_bhati && !consentRow.stay_at_bhati) {
    reasons.push('Requires stay at bhati')
  }
  if (dept.vss_requires_initiated && !vssSewadar?.is_initiated) {
    reasons.push('Requires initiated VSS sewadar')
  }
  if (dept.vss_requires_gender && (vssSewadar?.gender || '') !== dept.vss_requires_gender) {
    reasons.push(`Requires ${dept.vss_requires_gender} VSS sewadar`)
  }
  return reasons
}

/* ─── Editing gating ─── */

export function canEditDeployment({ editableRole, schedule, deadlinePassed, done, masterOpen }) {
  if (!editableRole || !schedule) return false
  if (schedule.status !== 'open' || done || deadlinePassed) return false
  return masterOpen !== false
}

/* ─── VSS registration (new creation) ─── */

// Age in years from an ISO date (YYYY-MM-DD, as sent by <input type=date>).
// Returns null for missing/unparseable values (no timezone pitfalls).
export function computeAge(dob) {
  if (!dob) return null
  const m = String(dob).match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  const today = new Date()
  let age = today.getFullYear() - y
  if (today.getMonth() + 1 < mo || (today.getMonth() + 1 === mo && today.getDate() < d)) age--
  return age
}

// The "Age >= 29, not initiated" rule for new VSS registrations
export function isVssAgeBlocked(dob, isInitiated) {
  const age = computeAge(dob)
  return age !== null && age >= 29 && !isInitiated
}

// Pure validation for the VSS registration form. Returns { field: message }.
// hasPhoto/photoSize cover the required-photo + 3MB rules.
export function vssRegistrationErrors(form, { hasPhoto = false, photoSize = 0 } = {}) {
  const e = {}
  if (!form?.centre) e.centre = 'Centre is required'
  if (!form?.sewadar_name || !String(form.sewadar_name).trim()) e.sewadar_name = 'Sewadar name is required'
  if (!form?.father_husband_name || !String(form.father_husband_name).trim()) e.father_husband_name = 'Father / Husband name is required'
  if (!form?.gender) e.gender = 'Gender is required'
  if (!form?.dob) e.dob = 'Date of birth is required'
  else if (computeAge(form.dob) === null) e.dob = 'Enter a valid date of birth'
  if (!form?.address || !String(form.address).trim()) e.address = 'Address is required'
  if (!form?.contact_no || !String(form.contact_no).trim()) e.contact_no = 'Contact number is required'
  else if (!/^\d{10,12}$/.test(String(form.contact_no).replace(/\D/g, ''))) e.contact_no = 'Enter a valid contact number (10–12 digits)'
  if (!form?.emergency_contact || !String(form.emergency_contact).trim()) e.emergency_contact = 'Emergency contact is required'
  else if (!/^\d{10,12}$/.test(String(form.emergency_contact).replace(/\D/g, ''))) e.emergency_contact = 'Enter a valid contact number (10–12 digits)'
  if (!form?.aadhar_number || !String(form.aadhar_number).trim()) e.aadhar_number = 'Aadhar number is required'
  else if (!/^\d{12}$/.test(String(form.aadhar_number).replace(/\s/g, ''))) e.aadhar_number = 'Aadhar must be exactly 12 digits'
  if (!hasPhoto) e.photo = 'Photo is required'
  if (hasPhoto && photoSize > 3 * 1024 * 1024) e.photo = 'Photo must be under 3 MB'
  if (isVssAgeBlocked(form?.dob, !!form?.is_initiated)) e.age = 'Age >= 29, not initiated — cannot add VSS'
  return e
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
