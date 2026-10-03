// Pure domain logic — no Supabase client, so it's unit-testable.
import { sanitizeBarcode } from './scannerUtils'

export const ELDERLY_BADGE_STATUS = 'ELDERLY'
export const ELIGIBLE_BADGE_STATUSES = ['OPEN', 'PERMANENT']

// Supabase filter fragment that excludes elderly badges (null-safe)
export function notElderlyFilter() {
  return 'badge_status.is.null,badge_status.neq.ELDERLY'
}

export function isElderly(badge_status) {
  return String(badge_status || '').toUpperCase() === ELDERLY_BADGE_STATUS
}

export function badgeStatusEligible(badge_status) {
  return ELIGIBLE_BADGE_STATUSES.includes(String(badge_status || '').trim().toUpperCase())
}

// Supabase OR filter: badge_status IS NULL OR IN ('OPEN','PERMANENT')
export function eligibleBadgeStatusFilter() {
  return 'badge_status.is.null,badge_status.in.(OPEN,PERMANENT)'
}

/* ─── AREA SECRETARY OFFICE restriction ─── */

export const ASO_DEPARTMENT = 'AREA SECRETARY OFFICE'

export function isAssoDepartment(dept) {
  return String(dept || '').trim().toUpperCase() === ASO_DEPARTMENT
}

export function canCentreDeploy(consentRow, userRole) {
  if (!consentRow || !userRole) return false
  if (userRole === 'super_admin') return true
  return !isAssoDepartment(consentRow.department)
}

/* ─── Consent-page visibility gating ─── */

export function shouldHideFromConsent(sewadar, role) {
  if (!sewadar) return true
  if (isElderly(sewadar.badge_status)) return true
  if (isAssoDepartment(sewadar.department) && !['aso', 'super_admin'].includes(role)) return true
  return false
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
  const list = centres || []
  // Unknown centre → no subtree. Returning a phantom one-element list would
  // make callers fire pointless `.in('centre', ...)` queries.
  if (!list.some(c => c.name === centreName)) return []
  const children = {}
  list.forEach(c => {
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
    const used = (savedAll && savedAll[a.department_id]) || 0
    const local = (localOwn && localOwn[a.department_id]) || 0
    const own = (savedOwn && savedOwn[a.department_id]) || 0
    const effective = used + (local - own)
    out[a.department_id] = { max: a.max_count, used, local, own, effective, rem: a.max_count - effective }
  })
  return out
}

/* ─── vss_operator quota scope ───
   The operator has no home centre: the quota root follows the centre
   filter (a picked centre resolves to its CENTRE root); 'All centres'
   (null root) unions every in-scope centre's allocations so all allocated
   departments stay offered (bars are approximate in that view). Shared by
   ConsentPage + VssPage so the two pages cannot drift. */
export function resolveOperatorQuotaRoot({ isVssOperator, filterCentre, centres }) {
  if (!isVssOperator) return null
  if (!filterCentre || filterCentre === 'all') return null
  return getRootCentre(centres, filterCentre)
}

export function selectQuotaAllocations({ allocations, quotaRoot, isVssOperator, subtree }) {
  const list = allocations || []
  if (isVssOperator && !quotaRoot) {
    const scope = subtree || []
    return list.filter(a => scope.includes(a.centre))
  }
  return list.filter(a => a.centre === quotaRoot)
}

/* ─── all-centres union aggregation ───
   The union keeps one row per centre×department, which would render one
   quota card per centre (121 cards). Aggregate to one row per department
   with summed max_count so each department shows exactly once. */
export function aggregateQuotaAllocations(allocations) {
  const byDept = new Map()
  ;(allocations || []).forEach(a => {
    if (!a || !a.department_id) return
    const cur = byDept.get(a.department_id)
    if (cur) {
      cur.max_count += (a.max_count || 0)
      if (a.centre && !cur.centres.includes(a.centre)) cur.centres.push(a.centre)
    } else {
      byDept.set(a.department_id, {
        department_id: a.department_id,
        centre: 'ALL',
        max_count: (a.max_count || 0),
        centres: a.centre ? [a.centre] : [],
      })
    }
  })
  return [...byDept.values()]
}

// VSS badges are prefixed with "VS" (e.g. VSFB5971GB4629)
export function isVssBadge(badge) {
  return typeof badge === 'string' && /^VS/i.test(badge)
}

export const BADGE_REGEX = /^(FB(597[1-9]|59[89]\d|600\d|601[01])(GA|LA)\d{4}|BH\d{4}[A-Z]{1,2}\d{4}|VS[A-Z0-9]+)$/i
export function isValidBadgeFormat(badge) {
  return typeof badge === 'string' && BADGE_REGEX.test(badge.trim())
}
export function isFaridabadBadge(badge) {
  return isValidBadgeFormat(badge)
}
export function isUndeployedScan(badge, deployedSet) {
  if (!badge || !deployedSet) return true
  return !deployedSet.has(String(badge).toUpperCase())
}

/* ─── Scanned-badge sanitisation ───
   Barcode decoders hand back exactly the bytes they saw: Code 39 start/stop
   guards, stray spaces, lower case, and — the expensive kind of noise —
   character confusions (O↔0, I/l↔1, S↔5, B↔8, Z↔2) that turn a real badge
   into a string the validator rejects. `sanitizeBarcode` (scannerUtils.js)
   already fixes the mechanical noise; this function adds the badge-specific
   recovery on top, deriving every position requirement from the SAME
   BADGE_REGEX the validator enforces so a repaired value can never drift
   from what the database will accept. */

// Decoder confusions observed in badge-like alphanumeric codes. Correction is
// POSITIONAL, never global: letters are load-bearing in these badges (the
// "FB"/"BH" prefixes, the "GA"/"LA" middle), so a blind S→5 or B→8 would
// retype a valid badge as a DIFFERENT sewadar's badge — a wrong-but-valid
// scan is worse than a rejected one.
const BADGE_LETTER_TO_DIGIT = { O: '0', I: '1', L: '1', S: '5', B: '8', Z: '2' }
const BADGE_DIGIT_TO_LETTER = { 0: 'O', 1: 'I', 5: 'S', 8: 'B', 2: 'Z' }

// Per-position character-class requirements derived from BADGE_REGEX, keyed
// by LENGTH: 'D' = digit required, 'L' = letter required. Both 12-char
// families (FB + 4 digits + GA/LA + 4 digits, and BH + 4 digits + 2 letters +
// 4 digits) share one class map, so BADGE_REGEX — not the prefix — is the
// discriminator. Returns null for shapes we cannot derive positions from: VSS
// accepts anything after "VS" (nothing to repair), and any other length is
// not a noisy read of a known badge, so we must not guess.
function badgePositionClasses(value) {
  if (isVssBadge(value)) return null
  if (value.length === 12) {
    return ['L', 'L', 'D', 'D', 'D', 'D', 'L', 'L', 'D', 'D', 'D', 'D']
  }
  // The 11-char BH family: BH + 4 digits + 1 letter + 4 digits.
  if (value.length === 11) {
    return ['L', 'L', 'D', 'D', 'D', 'D', 'L', 'D', 'D', 'D', 'D']
  }
  return null
}

// Repair positional confusions. A repair is accepted ONLY when the repaired
// string matches BADGE_REGEX — otherwise the original is returned untouched,
// so a failed repair can never retype a scan as a different sewadar. Fewer
// fixes are preferred over more (a value needing many fixes is more likely a
// genuinely different badge than a noisy read of this one).
function repairBadgeConfusions(value) {
  const classes = badgePositionClasses(value)
  if (!classes) return value
  // Positions whose character violates the required class AND is a known
  // confusion of the required class. Anything else is left alone — we do not
  // invent corrections the decoder-confusion model does not explain.
  const fixable = []
  for (let i = 0; i < value.length; i += 1) {
    const req = classes[i]
    const ch = value[i]
    if (req === 'D' && !/[0-9]/.test(ch) && BADGE_LETTER_TO_DIGIT[ch]) fixable.push(i)
    else if (req === 'L' && !/[A-Z]/.test(ch) && BADGE_DIGIT_TO_LETTER[ch]) fixable.push(i)
  }
  if (!fixable.length) return value
  // Try subsets of increasing size (1 fix, then 2, then 3) and accept the
  // first candidate that fully matches BADGE_REGEX. Capped at 3 fixes.
  const MAX_FIXES = 3
  for (let size = 1; size <= Math.min(MAX_FIXES, fixable.length); size += 1) {
    const combos = []
    const walk = (start, chosen) => {
      if (chosen.length === size) { combos.push(chosen); return }
      for (let i = start; i < fixable.length; i += 1) walk(i + 1, [...chosen, fixable[i]])
    }
    walk(0, [])
    for (const positions of combos) {
      const chars = value.split('')
      for (const pos of positions) {
        const req = classes[pos]
        chars[pos] = req === 'D' ? BADGE_LETTER_TO_DIGIT[value[pos]] : BADGE_DIGIT_TO_LETTER[value[pos]]
      }
      const candidate = chars.join('')
      if (BADGE_REGEX.test(candidate)) return candidate
    }
  }
  return value
}

/**
 * Recover a real badge from a noisy barcode decode, or return '' when the
 * input is not a string / is empty. Pure and total: never throws, and
 * idempotent — sanitising an already-sanitised value is a no-op.
 *
 * Pipeline (each step runs only if the previous one did not settle):
 *   1. Mechanical normalisation via `sanitizeBarcode` (trim, collapse
 *      whitespace, strip characters that can never appear in a badge, uppercase).
 *   2. A clean REGULAR badge passes through untouched.
 *   3. A leading "VS" is stripped ONLY when the remainder matches an accepted
 *      pattern AND the value does NOT already validate as a VSS badge. The
 *      guard makes the strip inert for every sanitised value — deliberately:
 *      isVssBadge() matches ANY "VS…" string, and the VSS seed data
 *      (sql/vss_sewadars_data.sql) proves legit VSS badges routinely look
 *      exactly like "VS" + a valid FB badge (e.g. VSFB5971GA2927). A syntactic
 *      strip cannot tell a spurious prefix from a real VSS badge, and
 *      stripping a real one scans the wrong sewadar, so the conservative bias
 *      wins and any value that already validates as VSS is preserved.
 *   4. Positional confusion repair (see repairBadgeConfusions).
 *
 * @param {string|null|undefined|number} raw
 * @returns {string} the recovered badge, or '' when nothing can be recovered
 */
export function sanitizeScannedBadge(raw) {
  if (typeof raw !== 'string') return ''
  const value = sanitizeBarcode(raw)
  if (!value) return ''
  // Clean regular badge — nothing to recover.
  if (isValidBadgeFormat(value) && !isVssBadge(value)) return value
  // Spurious-"VS" recovery. Condition (b) — the value must NOT already
  // validate as a VSS badge — is what protects legit VSS badges; see the
  // note above for why it keeps this strip inert on sanitised values.
  const vsRest = isVssBadge(value) ? value.slice(2) : ''
  if (vsRest && isValidBadgeFormat(vsRest) && !isVssBadge(value)) return vsRest
  if (isValidBadgeFormat(value)) return value
  return repairBadgeConfusions(value)
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
  const minDays = dept.min_days ?? 1
  if ((consentRow.available_days_count ?? 0) < minDays) {
    reasons.push(`Needs minimum ${minDays} consent day${minDays > 1 ? 's' : ''} (has ${consentRow.available_days_count ?? 0})`)
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

// gender values are stored uppercase ('MALE'/'FEMALE'); compare normalized so
// a stray 'Male' in the data doesn't silently fail the requirement
const normGender = (g) => String(g ?? '').trim().toUpperCase()

export function isEligibleVss(consentRow, vssSewadar, dept) {
  if (!consentRow || !dept) return false
  if (!dept.include_vss) return false
  if (!consentRow.consent_given) return false
  if (vssSewadar && !vssSewadar.is_active) return false
  const daysOk = (consentRow.available_days_count ?? 0) >= (dept.vss_min_days ?? 1)
  const bhatiOk = !dept.vss_requires_stay_at_bhati || !!consentRow.stay_at_bhati
  const initiatedOk = !dept.vss_requires_initiated || !!vssSewadar?.is_initiated
  const genderOk = !dept.vss_requires_gender || normGender(vssSewadar?.gender) === normGender(dept.vss_requires_gender)
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
  const vssMinDays = dept.vss_min_days ?? 1
  if ((consentRow.available_days_count ?? 0) < vssMinDays) {
    reasons.push(`Needs minimum ${vssMinDays} consent day${vssMinDays > 1 ? 's' : ''} (has ${consentRow.available_days_count ?? 0})`)
  }
  if (dept.vss_requires_stay_at_bhati && !consentRow.stay_at_bhati) {
    reasons.push('Requires stay at bhati')
  }
  if (dept.vss_requires_initiated && !vssSewadar?.is_initiated) {
    reasons.push('Requires initiated VSS sewadar')
  }
  if (dept.vss_requires_gender && normGender(vssSewadar?.gender) !== normGender(dept.vss_requires_gender)) {
    reasons.push(`Requires ${dept.vss_requires_gender} VSS sewadar`)
  }
  return reasons
}

/* ─── Editing gating ─── */

export function canEditDeployment({ editableRole, schedule, deadlinePassed, done, masterOpen, locked = false, overrideOpen = false, vssOpen = false }) {
  if (!editableRole || !schedule) return false
  if (schedule.status !== 'open' || done) return false
  // v21: the super_admin's Control Panel can reopen a centre even while the
  // switch is off / deadline passed / centre locked ('done' stays terminal)
  if (overrideOpen) return true
  // VSS: the DB trigger block_after_deadline (v30) bypasses lock + deadline
  // for VSS rows when vss_deploy_open_for_centre() is true (global switch ON
  // with override applied). The frontend must match — otherwise the UI shows
  // "locked" / "deadline passed" while the DB would allow the write.
  if (vssOpen) return true
  if (deadlinePassed || locked) return false
  return masterOpen !== false
}

/* ─── v21 Control Panel edit gates ───
   A Control Panel override reopens editing past the switch / deadline / centre
   lock — never past a 'done' schedule. The scope of what reopens depends on the
   override:
     • CONSENT rows (consent / stay-at-bhati / chair-pass) reopen ONLY via a
       CENTRE-WIDE (department_id IS NULL) or global override — a department-
       scoped unlock leaves consent frozen.
     • DEPLOYMENT (the requested-department assignment) reopens via ANY
       override (centre-wide OR department-scoped). Under a department-scoped
       unlock the consent-given requirement also relaxes, so a sewadar whose
       consent is No may still be deployed to that department (the DB trigger
       enforces this; see check_deployment in v21).
   `centreWideOverrideOpen` and `anyOverrideOpen` come from the
   get_my_effective_gates RPC; `masterOpen` is the effective master switch. */

export function computeEditGates({
  isEditableRole,
  schedule,
  scheduleDone,
  deadlinePassed,
  locked,
  masterOpen,
  centreWideOverrideOpen = false,
  anyOverrideOpen = false,
}) {
  const open = !!isEditableRole && !!schedule && schedule.status === 'open' && !scheduleDone
  if (!open) return { consentEditable: false, deploymentEditable: false }
  const normal = !deadlinePassed && !locked && masterOpen !== false
  return {
    // Consent rows carry no department, so ONLY a centre-wide/global override
    // reopens consent editing — a department-scoped unlock leaves consent
    // frozen while still reopening deployment (see below).
    consentEditable: centreWideOverrideOpen || normal,
    // Deployment (the requested-department assignment) reopens via ANY
    // override (centre-wide OR department-scoped).
    deploymentEditable: anyOverrideOpen || normal,
  }
}

/* Is a department selectable in the deployment dropdown under a Control Panel
   override? When no override is active the normal gate governs and every
   allocated department stays selectable. A centre-wide/global override opens
   everything; a department-scoped override opens only the listed departments
   (the row's CURRENT department always stays selectable). */
export function isDeptSelectable(deptId, { isCurrent, anyOverrideOpen, openDepartments }) {
  if (isCurrent) return true
  if (!anyOverrideOpen) return true
  if (openDepartments == null) return true
  return openDepartments.includes(deptId)
}

/* A sewadar is in the "undeployed" cohort (eligible to be deployed under a
   Control Panel UNDEPLOYED-ONLY override) when they have NOT yet been assigned
   a requested department and are not ASO-finalized. Already-deployed sewadars
   (a deployment row with a requested department) must stay frozen at both the
   UI and the DB. Mirrors the SQL cohort check in block_after_deadline /
   check_deployment. */
export function isUndeployedCohort(row) {
  return !row.finalized && !row.requested_dept
}

/* ─── Control Panel overrides (v21) ───
   A presence of a centre_overrides row OPENS deployment writing for its
   scope: centre '*' = all centres, otherwise the ROOT CENTRE (SC_SPs
   inherit); department_id null = centre-wide, otherwise just that
   department. Mirrors the SQL helper is_centre_override_open(). */

export const OVERRIDE_ALL_CENTRES = '*'

export function resolveOverride(overrides, { rootCentre, departmentId = null }) {
  if (!Array.isArray(overrides)) return false
  return overrides.some(o =>
    o &&
    (o.centre === OVERRIDE_ALL_CENTRES || (rootCentre != null && o.centre === rootCentre)) &&
    (departmentId == null
      ? o.department_id == null
      : (o.department_id == null || o.department_id === departmentId))
  )
}

// Tri-state VSS knob lookup: null = inherit the global value. A
// centre-specific row wins over the '*' wildcard row.
export function resolveVssOverride(vssOverrides, { rootCentre, key }) {
  if (!Array.isArray(vssOverrides)) return null
  if (rootCentre == null) return null
  const specific = vssOverrides.find(o => o?.centre === rootCentre)
  const wildcard = vssOverrides.find(o => o?.centre === OVERRIDE_ALL_CENTRES)
  const row = specific || wildcard
  return row ? (row[key] ?? null) : null
}

// Effective VSS CREATION gate — HARD global close.
// Before v31 this was `override ?? (global && window)` which let a per-centre
// `true` reopen creation even after the super_admin globally closed it.
// User requirement: "disable everything in VSS until its open" — global
// must be the master. Hard gate: global must be true AND (override ?? window).
// i.e. a per-centre `true` can only keep it open when global is already open
// (and can bypass the deadline window), but can never reopen after global closed.
export function effectiveVssCreation({ overrideValue, globalOpen, windowOpen }) {
  if (!globalOpen) return false
  if (overrideValue != null) return !!overrideValue
  return !!windowOpen
}

// Effective VSS DEPLOYMENT gate — HARD global close.
// Same principle: per-centre `true` cannot reopen after global closed.
// Hard gate: global && (override ?? true) — override `false` forces closed
// even when global open, `true` keeps global's value, `null` inherits.
export function effectiveVssDeployment({ overrideValue, globalOpen }) {
  if (!globalOpen) return false
  if (overrideValue != null) return !!overrideValue
  return true
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

/* ─── Available days rules ───
   All sewadars (regular + VSS) default to 5 days. The OE ESCORTS sewa
   department is FIXED at 3 days: the days input is disabled for those rows
   and selecting that department auto-sets 3.                              */

export const DEFAULT_AVAILABLE_DAYS = 5
export const OE_ESCORTS_DEPT_NAME = 'OE ESCORTS'
export const OE_ESCORTS_DAYS = 3

// Matches the exact name or variants like "OE ESCORTS (SEWA)" / "OE ESCORTS-SEWA".
export function isOeEscortsDept(deptName) {
  return typeof deptName === 'string' && deptName.trim().toUpperCase().startsWith(OE_ESCORTS_DEPT_NAME)
}

// The available-days value a row gets once assigned to `deptName`. Days are
// NOT user-editable: every department defaults to 5, except OE ESCORTS which
// is fixed at 3. Used on load, on department change, at save time, and to
// judge eligibility when switching departments.
export function daysForDept(deptName) {
  return isOeEscortsDept(deptName) ? OE_ESCORTS_DAYS : DEFAULT_AVAILABLE_DAYS
}

/* ─── Prev-year attendance ─── */

export const TRAFFIC_OUTSIDE_BHATI = 'TRAFFIC OUTSIDE BHATI'

// normalize a department label for comparison — imported Excel data may vary
// in case/whitespace and silently flipping the attendance denominator would
// misstate every row for that department
const normDept = (s) => String(s ?? '').trim().toUpperCase()

// Attendance denominator: 3 for TRAFFIC OUTSIDE BHATI, otherwise 5
export function attendanceDenominator(prevDepartment) {
  return normDept(prevDepartment) === TRAFFIC_OUTSIDE_BHATI ? 3 : 5
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
  return prevAttendance === 2 && normDept(prevDepartment) !== TRAFFIC_OUTSIDE_BHATI
}

/* ─── Dirty-row detection for auto-save ───
   The consent pages upsert ALL rows on every debounced save. With big
   centres that means re-writing every row each keystroke. Instead we
   persist a snapshot of the last-saved signatures ({key → signature})
   and only upsert rows whose current signature differs.           */

// Stable signature of the editable consent/deploy fields that get persisted.
// `is_active` is only meaningful for VSS rows (undefined for regular ones).
export function consentRowSignature(row) {
  if (!row) return ''
  return [
    !!row.consent_given,
    row.consent_given ? row.available_days_count : null,
    !!row.stay_at_bhati,
    !!row.chair_pass,
    row.requested_dept || '',
    row.is_active !== false, // VSS-only; regular rows keep it true
  ].join('|')
}

export function consentRowKey(row) {
  return `${row.centre}|${row.badge_number}`
}

// Fields a centre user can actually edit. loadData's reload-merge overlays ONLY
// these onto freshly-fetched rows — read-only data (is_active, is_initiated,
// gender, remarks, prev_* attendance) must always come fresh from the server.
export const EDITABLE_CONSENT_FIELDS = ['consent_given', 'available_days_count', 'stay_at_bhati', 'chair_pass', 'requested_dept']

// Rows that differ from the last-saved snapshot. `snapshot` is a map built by
// buildConsentSnapshot() ({ key → value object }), but older call sites/tests
// may still pass signature STRINGS — both forms compare exactly, so either is
// safe.
export function changedConsentRows(rows, snapshot) {
  if (!rows) return []
  const snap = snapshot || {}
  return Object.values(rows).filter(row => {
    const key = consentRowKey(row)
    const saved = snap[key]
    const savedSig = typeof saved === 'string' ? saved : (saved ? consentRowSignature(saved) : '')
    return consentRowSignature(row) !== savedSig
  })
}

// Snapshot entry for one row: the persisted editable fields as raw VALUES
// (mirrors consentRowSignature field-for-field) so callers can diff per-field
// instead of only knowing "the row changed".
function consentSnapshotValue(row) {
  return {
    consent_given: !!row.consent_given,
    available_days_count: row.consent_given ? row.available_days_count : null,
    stay_at_bhati: !!row.stay_at_bhati,
    chair_pass: !!row.chair_pass,
    requested_dept: row.requested_dept || '',
    is_active: row.is_active !== false, // VSS-only; regular rows keep it true
  }
}

// Build the snapshot map from the current rows (call after load/save).
export function buildConsentSnapshot(rows) {
  const snap = {}
  if (!rows) return snap
  Object.values(rows).forEach(row => {
    snap[consentRowKey(row)] = consentSnapshotValue(row)
  })
  return snap
}

// Fields written to a consent row on a partial (UPDATE) save. Per-field
// diffing means a parallel session's edits to OTHER fields of the same row
// survive this save — whole-row upserts used to clobber them (the "my work
// disappeared" bug with two open tabs).
export const CONSENT_PERSIST_FIELDS = ['consent_given', 'available_days_count', 'stay_at_bhati', 'chair_pass']

// Per-field consent diff of a row against its last-saved snapshot entry.
// Returns an object with ONLY the fields that differ, or null when nothing
// does. `saved` missing/null means the row has never been saved — every
// persisted field is then returned so callers can do a full insert.
// Non-consent fields (requested_dept, is_active) are intentionally ignored:
// department changes travel through the deployments table, not the consent row.
export function changedConsentFields(row, saved) {
  if (!row) return null
  const diff = {}
  CONSENT_PERSIST_FIELDS.forEach(f => {
    if (!saved || row[f] !== saved[f]) diff[f] = row[f]
  })
  return Object.keys(diff).length > 0 ? diff : null
}

// Group per-row consent PATCHes so one PostgREST UPDATE never writes row A's
// values into row B. Groups split on field-set AND values: rows sharing only
// the field names (e.g. two bhati toggles with opposite values in one debounce
// window) must travel in separate UPDATEs. Items are { fields, ref }; refs are
// opaque to the grouping and returned per group for the caller's or-filter.
export function groupConsentPatches(items) {
  const groups = new Map()
  for (const { fields, ref } of items || []) {
    const groupKey = Object.keys(fields)
      .sort()
      .map(k => `${k}=${JSON.stringify(fields[k] ?? null)}`)
      .join(',')
    let g = groups.get(groupKey)
    if (!g) { g = { fields, refs: [] }; groups.set(groupKey, g) }
    g.refs.push(ref)
  }
  return [...groups.values()]
}

// UUID check for the link-auth-account form (v48): the superadmin pastes the
// auth.users id from the Supabase dashboard.
export function isUuid(value) {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(String(value || '').trim())
}

// ─── v48 user management ─────────────────────────────────────────────
// Roles whose login must be scoped to a centre, and roles that must carry a
// badge_number (the join key into the sewadar domain for scanner/incharge
// enforcement). Mirrored server-side by claim_portal_invite — keep in sync.
export const INVITE_ROLES = ['centre_user', 'centre_admin', 'aso', 'super_admin', 'dept_incharge', 'scanner', 'vss_operator']
export const INVITE_CENTRE_ROLES = ['centre_user', 'centre_admin']
export const INVITE_BADGE_ROLES = ['dept_incharge', 'scanner']
// v51: a dept_incharge is scoped by DEPARTMENT (across every centre), so the
// grant itself is required — a login with a badge but no department would come
// up with an empty dashboard and an empty scan list, which reads as a broken
// app rather than an unassigned one. Mirrored by claim_portal_invite's trigger
// (trg_grant_incharge_on_claim) and by the Users-page picker.
export const INVITE_DEPARTMENT_ROLES = ['dept_incharge']

/**
 * Pure validation for superadmin-issued invites. Returns [] when valid.
 * The claim_portal_invite RPC enforces the same rules server-side.
 *
 * `deptIds` is the v51 department grant: a dept_incharge must name at least one
 * department for the chosen schedule.
 */
export function invitationErrors({ email = '', name = '', role = '', centre = '', badge = '', deptIds = [] } = {}) {
  const errors = []
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) errors.push('Enter a valid email address')
  if (!String(name).trim()) errors.push('Enter the person’s name')
  if (!INVITE_ROLES.includes(role)) errors.push('Pick a valid role')
  if (INVITE_CENTRE_ROLES.includes(role) && !String(centre).trim()) errors.push('Pick a centre for this role')
  if (INVITE_BADGE_ROLES.includes(role) && !String(badge).trim()) errors.push('Enter a badge number for this role')
  if (INVITE_DEPARTMENT_ROLES.includes(role) && !(Array.isArray(deptIds) && deptIds.length)) {
    errors.push('Pick at least one department for this role')
  }
  return errors
}
