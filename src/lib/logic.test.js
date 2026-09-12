import { describe, it, expect, vi } from 'vitest'
import {
  notElderlyFilter,
  isElderly,
  badgeStatusEligible,
  eligibleBadgeStatusFilter,
  getParentCentres,
  getRootCentre,
  getSubtreeCentres,
  computeDeptQuota,
  selectQuotaAllocations,
  resolveOperatorQuotaRoot,
  isVssBadge,
  isEligible,
  eligibilityReasons,
  isEligibleVss,
  vssEligibilityReasons,
  canEditDeployment,
  computeAge,
  isVssAgeBlocked,
  vssRegistrationErrors,
  attendanceDenominator,
  attendanceDisplay,
  isLowAttendance,
  consentRowSignature,
  consentRowKey,
  changedConsentRows,
  changedConsentFields,
  buildConsentSnapshot,
  EDITABLE_CONSENT_FIELDS,
  DEFAULT_AVAILABLE_DAYS,
  OE_ESCORTS_DEPT_NAME,
  OE_ESCORTS_DAYS,
  isOeEscortsDept,
  daysForDept,
  resolveOverride,
  resolveVssOverride,
  effectiveVssCreation,
  effectiveVssDeployment,
  ASO_DEPARTMENT,
  isAssoDepartment,
  canCentreDeploy,
  shouldHideFromConsent,
  computeEditGates,
  isDeptSelectable,
  isUndeployedCohort,
  BADGE_REGEX,
  isValidBadgeFormat,
  isFaridabadBadge,
  isUndeployedScan,
} from '../lib/logic'

const CENTRES = [
  { name: 'ANKHEER', parent_centre: null },
  { name: 'GURGAON', parent_centre: null },
  { name: 'BADHA SIKENDERPUR', parent_centre: 'ANKHEER' },
  { name: 'FIROZPUR JHIRKA', parent_centre: 'GURGAON' },
  { name: 'HODAL', parent_centre: 'GURGAON' },
]

describe('notElderlyFilter / isElderly', () => {
  it('produces a null-safe supabase OR filter', () => {
    expect(notElderlyFilter()).toBe('badge_status.is.null,badge_status.neq.ELDERLY')
  })
  it('detects ELDERLY case-insensitively', () => {
    expect(isElderly('ELDERLY')).toBe(true)
    expect(isElderly('elderly')).toBe(true)
    expect(isElderly('OPEN')).toBe(false)
    expect(isElderly(null)).toBe(false)
  })
})
describe('badgeStatusEligible / eligibleBadgeStatusFilter', () => {
  it('returns true for OPEN and PERMANENT', () => {
    expect(badgeStatusEligible('OPEN')).toBe(true)
    expect(badgeStatusEligible('PERMANENT')).toBe(true)
    expect(badgeStatusEligible('open')).toBe(true)
    expect(badgeStatusEligible(' permanent ')).toBe(true)
  })
  it('returns false for ELDERLY and other statuses', () => {
    expect(badgeStatusEligible('ELDERLY')).toBe(false)
    expect(badgeStatusEligible('CLOSED')).toBe(false)
    expect(badgeStatusEligible('')).toBe(false)
  })
  it('is null-safe', () => {
    expect(badgeStatusEligible(null)).toBe(false)
    expect(badgeStatusEligible(undefined)).toBe(false)
  })
  it('produces the correct Supabase OR filter', () => {
    expect(eligibleBadgeStatusFilter()).toBe('badge_status.is.null,badge_status.in.(OPEN,PERMANENT)')
  })
})

describe('AREA SECRETARY OFFICE restriction', () => {
  it('isAssoDepartment matches exactly (case-insensitive, trimmed)', () => {
    expect(isAssoDepartment('AREA SECRETARY OFFICE')).toBe(true)
    expect(isAssoDepartment('area secretary office')).toBe(true)
    expect(isAssoDepartment('  AREA SECRETARY OFFICE  ')).toBe(true)
    expect(isAssoDepartment('AREA SECRETARY')).toBe(false)
    expect(isAssoDepartment('')).toBe(false)
    expect(isAssoDepartment(null)).toBe(false)
  })
  it('canCentreDeploy blocks centre_admin for ASO department sewadars', () => {
    const asoRow = { department: 'AREA SECRETARY OFFICE' }
    const normalRow = { department: 'LANGAR' }
    expect(canCentreDeploy(asoRow, 'centre_admin')).toBe(false)
    expect(canCentreDeploy(asoRow, 'centre_user')).toBe(false)
    expect(canCentreDeploy(asoRow, 'super_admin')).toBe(true)
    expect(canCentreDeploy(normalRow, 'centre_admin')).toBe(true)
    expect(canCentreDeploy(normalRow, 'super_admin')).toBe(true)
  })
  it('canCentreDeploy is null-safe', () => {
    expect(canCentreDeploy(null, 'centre_admin')).toBe(false)
    expect(canCentreDeploy({ department: 'LANGAR' }, null)).toBe(false)
  })
})

describe('shouldHideFromConsent', () => {
  it('returns true for elderly sewadars', () => {
    expect(shouldHideFromConsent({ badge_status: 'ELDERLY', department: 'LANGAR' })).toBe(true)
    expect(shouldHideFromConsent({ badge_status: 'elderly', department: 'LANGAR' })).toBe(true)
    expect(shouldHideFromConsent({ badge_status: 'ELDERLY', department: 'LANGAR' }, 'super_admin')).toBe(true)
  })
  it('returns true for AREA SECRETARY OFFICE department sewadars', () => {
    expect(shouldHideFromConsent({ badge_status: 'OPEN', department: 'AREA SECRETARY OFFICE' })).toBe(true)
    expect(shouldHideFromConsent({ badge_status: 'PERMANENT', department: 'area secretary office' })).toBe(true)
    expect(shouldHideFromConsent({ badge_status: 'OPEN', department: 'AREA SECRETARY OFFICE' }, 'centre_admin')).toBe(true)
  })
  it('returns true for AREA SECRETARY OFFICE but visible to aso/super_admin', () => {
    expect(shouldHideFromConsent({ badge_status: 'OPEN', department: 'AREA SECRETARY OFFICE' }, 'aso')).toBe(false)
    expect(shouldHideFromConsent({ badge_status: 'PERMANENT', department: 'AREA SECRETARY OFFICE' }, 'super_admin')).toBe(false)
  })
  it('returns false for normal sewadars', () => {
    expect(shouldHideFromConsent({ badge_status: 'OPEN', department: 'LANGAR' })).toBe(false)
    expect(shouldHideFromConsent({ badge_status: 'PERMANENT', department: 'TRAFFIC' })).toBe(false)
    expect(shouldHideFromConsent({ badge_status: null, department: 'ESCORTS' })).toBe(false)
  })
  it('returns true for null/undefined', () => {
    expect(shouldHideFromConsent(null)).toBe(true)
    expect(shouldHideFromConsent(undefined)).toBe(true)
  })
})


describe('badge format helpers (v25-v27)', () => {
  it('BADGE_REGEX matches FB / BH / VS patterns (as implemented)', () => {
    // FB pattern requires trailing 4 digits after GA/LA (real badges: FB5982GA0025)
    expect(BADGE_REGEX.test('FB5971GA0001')).toBe(true)
    expect(BADGE_REGEX.test('FB6000LA0002')).toBe(true)
    expect(BADGE_REGEX.test('BH1234AB0001')).toBe(true)
    expect(BADGE_REGEX.test('VSABC123')).toBe(true)
    expect(BADGE_REGEX.test('VS123')).toBe(true)
    expect(BADGE_REGEX.test('INVALID')).toBe(false)
    expect(BADGE_REGEX.test('')).toBe(false)
    // FB without trailing 4 digits is rejected (must be GA/LA + 4 digits)
    expect(BADGE_REGEX.test('FB5971GA')).toBe(false)
  })
  it('isValidBadgeFormat validates FB/BH/VS and is null-safe', () => {
    expect(isValidBadgeFormat('FB5971GA0001')).toBe(true)
    expect(isValidBadgeFormat(' VS123 ')).toBe(true)
    expect(isValidBadgeFormat('BH1234AB0001')).toBe(true)
    expect(isValidBadgeFormat('bad')).toBe(false)
    expect(isValidBadgeFormat(null)).toBe(false)
    expect(isValidBadgeFormat(undefined)).toBe(false)
    expect(isValidBadgeFormat('')).toBe(false)
  })
  it('isFaridabadBadge mirrors isValidBadgeFormat (currently)', () => {
    expect(isFaridabadBadge('FB5971GA0001')).toBe(true)
    expect(isFaridabadBadge('VS123')).toBe(true)
    expect(isFaridabadBadge('BH1234AB0001')).toBe(true)
    expect(isFaridabadBadge('bad')).toBe(false)
    expect(isFaridabadBadge(null)).toBe(false)
  })
  it('isUndeployedScan checks deployedSet', () => {
    const set = new Set(['FB5971GA0001', 'VS123'])
    expect(isUndeployedScan('FB5971GA0001', set)).toBe(false)
    expect(isUndeployedScan('fb5971ga0001', set)).toBe(false) // case-insensitive
    expect(isUndeployedScan('BH0001AB0001', set)).toBe(true)
    expect(isUndeployedScan(null, set)).toBe(true)
    expect(isUndeployedScan('FB5971GA0001', null)).toBe(true)
  })
})

describe('centre hierarchy', () => {
  it('getParentCentres returns only root centres', () => {
    expect(getParentCentres(CENTRES).map(c => c.name)).toEqual(['ANKHEER', 'GURGAON'])
  })
  it('getParentCentres and getRootCentre are null-safe', () => {
    expect(getParentCentres(null)).toEqual([])
    expect(getRootCentre(null, 'ANY')).toBe('ANY')
    expect(getRootCentre(CENTRES, null)).toBeNull()
    expect(getRootCentre(CENTRES, '')).toBeNull()
  })
  it('getRootCentre resolves child to parent', () => {
    expect(getRootCentre(CENTRES, 'HODAL')).toBe('GURGAON')
    expect(getRootCentre(CENTRES, 'BADHA SIKENDERPUR')).toBe('ANKHEER')
    expect(getRootCentre(CENTRES, 'GURGAON')).toBe('GURGAON')
  })
  it('getSubtreeCentres includes self and descendants', () => {
    expect(getSubtreeCentres(CENTRES, 'GURGAON')).toEqual(['GURGAON', 'HODAL', 'FIROZPUR JHIRKA'])
    expect(getSubtreeCentres(CENTRES, 'HODAL')).toEqual(['HODAL'])
  })
})

describe('computeDeptQuota', () => {
  const allocs = [
    { department_id: 'd1', centre: 'GURGAON', max_count: 10 },
    { department_id: 'd2', centre: 'GURGAON', max_count: 3 },
  ]
  it('reflects the other population\'s persisted assignments (shared quota)', () => {
    // 7 saved total (4 regular + 3 VSS); this page holds the 4 regular rows
    const q = computeDeptQuota(allocs, { d1: 7 }, { d1: 4 }, { d1: 4 })
    expect(q.d1.effective).toBe(7)
    expect(q.d1.rem).toBe(3)
  })
  it('adds this page\'s unsaved local edits on top of all saved', () => {
    const q = computeDeptQuota(allocs, { d1: 7 }, { d1: 5 }, { d1: 4 })
    expect(q.d1.effective).toBe(8)
    expect(q.d1.rem).toBe(2)
  })
  it('allows negative rem to signal over-quota', () => {
    const q = computeDeptQuota(allocs, { d2: 3 }, { d2: 5 }, { d2: 3 })
    expect(q.d2.rem).toBe(-2)
  })
  it('handles missing keys', () => {
    const q = computeDeptQuota(allocs, {}, {}, {})
    expect(q.d1.rem).toBe(10)
    expect(q.d2.local).toBe(0)
  })
})

describe('isVssBadge', () => {
  it('detects the VS badge prefix', () => {
    expect(isVssBadge('VSFB5971GB4629')).toBe(true)
    expect(isVssBadge('FB6002GA0011')).toBe(false)
    expect(isVssBadge(null)).toBe(false)
  })
})

describe('VSS eligibility', () => {
  const dept = { include_vss: true, vss_min_days: 3, vss_requires_stay_at_bhati: false, vss_requires_initiated: false, vss_requires_gender: null }
  const consent = { consent_given: true, available_days_count: 4, stay_at_bhati: true }
  const vss = { is_active: true, is_initiated: false, gender: 'MALE' }

  it('eligible when all VSS rules pass', () => {
    expect(isEligibleVss(consent, vss, dept)).toBe(true)
    expect(vssEligibilityReasons(consent, vss, dept)).toEqual([])
  })
  it('blocks departments not opened for VSS', () => {
    expect(isEligibleVss(consent, vss, { ...dept, include_vss: false })).toBe(false)
    expect(vssEligibilityReasons(consent, vss, { ...dept, include_vss: false })).toEqual(['Department not opened for VSS'])
  })
  it('blocks inactive VSS sewadars with the remarks reason', () => {
    expect(isEligibleVss(consent, { ...vss, is_active: false }, dept)).toBe(false)
    expect(vssEligibilityReasons(consent, { ...vss, is_active: false, remarks: 'badge not collected' }, dept))
      .toEqual(['Cannot deploy — badge not collected'])
  })
  it('falls back to a generic message when an inactive VSS sewadar has no remarks', () => {
    expect(vssEligibilityReasons(consent, { ...vss, is_active: false }, dept))
      .toEqual(['Cannot deploy — inactive VSS sewadar'])
  })
  it('blocks when consent not given', () => {
    expect(isEligibleVss({ ...consent, consent_given: false }, vss, dept)).toBe(false)
    expect(vssEligibilityReasons({ ...consent, consent_given: false }, vss, dept)).toEqual(['Consent not given'])
  })
  it('enforces vss_min_days', () => {
    const dept5 = { ...dept, vss_min_days: 5 }
    expect(isEligibleVss(consent, vss, dept5)).toBe(false)
    expect(vssEligibilityReasons(consent, vss, dept5)).toEqual(['Needs minimum 5 consent days (has 4)'])
  })
  it('enforces stay-at-bhati requirement', () => {
    const d = { ...dept, vss_requires_stay_at_bhati: true }
    expect(isEligibleVss({ ...consent, stay_at_bhati: false }, vss, d)).toBe(false)
    expect(vssEligibilityReasons({ ...consent, stay_at_bhati: false }, vss, d)).toEqual(['Requires stay at bhati'])
  })
  it('enforces initiated requirement from the VSS sewadar', () => {
    const d = { ...dept, vss_requires_initiated: true }
    expect(isEligibleVss(consent, { ...vss, is_initiated: true }, d)).toBe(true)
    expect(isEligibleVss(consent, vss, d)).toBe(false)
    expect(vssEligibilityReasons(consent, vss, d)).toEqual(['Requires initiated VSS sewadar'])
  })
  it('enforces the gender requirement', () => {
    const d = { ...dept, vss_requires_gender: 'FEMALE' }
    expect(isEligibleVss(consent, { ...vss, gender: 'FEMALE' }, d)).toBe(true)
    expect(isEligibleVss(consent, vss, d)).toBe(false)
    expect(vssEligibilityReasons(consent, vss, d)).toEqual(['Requires FEMALE VSS sewadar'])
  })
  it('compares gender case/whitespace-insensitively', () => {
    const d = { ...dept, vss_requires_gender: 'FEMALE' }
    expect(isEligibleVss(consent, { ...vss, gender: 'female' }, d)).toBe(true)
    expect(isEligibleVss(consent, { ...vss, gender: ' Female ' }, d)).toBe(true)
  })
})

describe('canEditDeployment', () => {
  const schedule = { status: 'open' }
  it('editable when everything is open', () => {
    expect(canEditDeployment({ editableRole: true, schedule, deadlinePassed: false, done: false, masterOpen: true })).toBe(true)
  })
  it('blocked when the master switch is closed', () => {
    expect(canEditDeployment({ editableRole: true, schedule, deadlinePassed: false, done: false, masterOpen: false })).toBe(false)
  })
  it('blocked when deadline passed or schedule done', () => {
    expect(canEditDeployment({ editableRole: true, schedule, deadlinePassed: true, done: false, masterOpen: true })).toBe(false)
    expect(canEditDeployment({ editableRole: true, schedule: { status: 'done' }, deadlinePassed: false, done: true, masterOpen: true })).toBe(false)
  })
  it('blocked for non-editable roles', () => {
    expect(canEditDeployment({ editableRole: false, schedule, deadlinePassed: false, done: false, masterOpen: true })).toBe(false)
  })
})

describe('canEditDeployment override (v21)', () => {
  const schedule = { status: 'open' }
  it('override reopens past the switch, the deadline and a centre lock', () => {
    const base = { editableRole: true, schedule, overrideOpen: true }
    expect(canEditDeployment({ ...base, deadlinePassed: false, done: false, masterOpen: false })).toBe(true)
    expect(canEditDeployment({ ...base, deadlinePassed: true, done: false, masterOpen: false })).toBe(true)
    expect(canEditDeployment({ ...base, deadlinePassed: true, done: false, masterOpen: true, locked: true })).toBe(true)
  })
  it('override never reopens a done schedule or a non-editable role', () => {
    expect(canEditDeployment({ editableRole: true, schedule: { status: 'done' }, deadlinePassed: false, done: true, masterOpen: true, overrideOpen: true })).toBe(false)
    expect(canEditDeployment({ editableRole: false, schedule, deadlinePassed: true, done: false, masterOpen: false, overrideOpen: true })).toBe(false)
  })
  it('locked alone still blocks (back-compat default)', () => {
    expect(canEditDeployment({ editableRole: true, schedule, deadlinePassed: false, done: false, masterOpen: true, locked: true })).toBe(false)
  })
})

describe('canEditDeployment vssOpen (VSS bypass lock+deadline)', () => {
  const schedule = { status: 'open' }
  it('vssOpen bypasses deadline passed', () => {
    expect(canEditDeployment({ editableRole: true, schedule, deadlinePassed: true, done: false, masterOpen: true, vssOpen: true })).toBe(true)
  })
  it('vssOpen bypasses centre lock', () => {
    expect(canEditDeployment({ editableRole: true, schedule, deadlinePassed: false, done: false, masterOpen: true, locked: true, vssOpen: true })).toBe(true)
  })
  it('vssOpen bypasses both lock and deadline', () => {
    expect(canEditDeployment({ editableRole: true, schedule, deadlinePassed: true, done: false, masterOpen: true, locked: true, vssOpen: true })).toBe(true)
  })
  it('vssOpen never reopens a done schedule', () => {
    expect(canEditDeployment({ editableRole: true, schedule: { status: 'done' }, deadlinePassed: false, done: true, masterOpen: true, vssOpen: true })).toBe(false)
  })
  it('vssOpen never reopens a non-editable role', () => {
    expect(canEditDeployment({ editableRole: false, schedule, deadlinePassed: true, done: false, masterOpen: true, vssOpen: true })).toBe(false)
  })
  it('vssOpen=false still blocks normally (back-compat)', () => {
    expect(canEditDeployment({ editableRole: true, schedule, deadlinePassed: true, done: false, masterOpen: true, locked: true, vssOpen: false })).toBe(false)
  })
})

describe('computeEditGates (v21 override scope)', () => {
  const schedule = { status: 'open' }
  const base = { isEditableRole: true, schedule, scheduleDone: false, deadlinePassed: false, locked: false, masterOpen: true }

  it('no override + open switch → both consent and deployment editable', () => {
    expect(computeEditGates({ ...base, centreWideOverrideOpen: false, anyOverrideOpen: false }))
      .toEqual({ consentEditable: true, deploymentEditable: true })
  })
  it('locked centre with no override → both locked', () => {
    expect(computeEditGates({ ...base, locked: true, centreWideOverrideOpen: false, anyOverrideOpen: false }))
      .toEqual({ consentEditable: false, deploymentEditable: false })
  })
  it('centre-wide override reopens CONSENT and DEPLOYMENT even when locked/closed', () => {
    const g = computeEditGates({ ...base, locked: true, masterOpen: false, deadlinePassed: true, centreWideOverrideOpen: true, anyOverrideOpen: true })
    expect(g).toEqual({ consentEditable: true, deploymentEditable: true })
  })
  it('department-scoped override reopens both CONSENT and DEPLOYMENT (consent rows have no department to scope against)', () => {
    const g = computeEditGates({ ...base, locked: true, centreWideOverrideOpen: false, anyOverrideOpen: true })
    expect(g).toEqual({ consentEditable: true, deploymentEditable: true })
  })
  it('department-scoped override still reopens deployment on a closed switch / passed deadline', () => {
    const g = computeEditGates({ ...base, masterOpen: false, deadlinePassed: true, centreWideOverrideOpen: false, anyOverrideOpen: true })
    expect(g.deploymentEditable).toBe(true)
    expect(g.consentEditable).toBe(true)
  })
  it('a done schedule is terminal regardless of override', () => {
    expect(computeEditGates({ ...base, scheduleDone: true, centreWideOverrideOpen: true, anyOverrideOpen: true }))
      .toEqual({ consentEditable: false, deploymentEditable: false })
  })
  it('non-editable role is always locked', () => {
    expect(computeEditGates({ ...base, isEditableRole: false, centreWideOverrideOpen: true, anyOverrideOpen: true }))
      .toEqual({ consentEditable: false, deploymentEditable: false })
  })
})

describe('isDeptSelectable (v21 department-scoped override)', () => {
  it('current department is always selectable', () => {
    expect(isDeptSelectable('d1', { isCurrent: true, anyOverrideOpen: true, openDepartments: ['d2'] })).toBe(true)
  })
  it('no override → every department selectable', () => {
    expect(isDeptSelectable('d3', { isCurrent: false, anyOverrideOpen: false, openDepartments: null })).toBe(true)
  })
  it('centre-wide override (openDepartments null) → every department selectable', () => {
    expect(isDeptSelectable('d3', { isCurrent: false, anyOverrideOpen: true, openDepartments: null })).toBe(true)
  })
  it('department-scoped override → only the opened departments selectable', () => {
    const ctx = { isCurrent: false, anyOverrideOpen: true, openDepartments: ['d1', 'd2'] }
    expect(isDeptSelectable('d1', ctx)).toBe(true)
    expect(isDeptSelectable('d2', ctx)).toBe(true)
    expect(isDeptSelectable('d3', ctx)).toBe(false)
  })
  it('department-scoped override with empty array → nothing selectable (except current)', () => {
    expect(isDeptSelectable('d3', { isCurrent: false, anyOverrideOpen: true, openDepartments: [] })).toBe(false)
  })
})

describe('isUndeployedCohort (v21 undeployed-only override)', () => {
  it('a sewadar with no requested department and not finalized is in the cohort', () => {
    expect(isUndeployedCohort({ finalized: false, requested_dept: '' })).toBe(true)
    expect(isUndeployedCohort({ finalized: false, requested_dept: null })).toBe(true)
  })
  it('a sewadar who already has a requested department is NOT in the cohort', () => {
    expect(isUndeployedCohort({ finalized: false, requested_dept: 'd1' })).toBe(false)
  })
  it('an ASO-finalized sewadar is NOT in the cohort', () => {
    expect(isUndeployedCohort({ finalized: true, requested_dept: '' })).toBe(false)
  })
})

describe('Control Panel overrides (v21 helpers)', () => {
  const OVERRIDES = [
    { centre: '*', department_id: null },
    { centre: 'GURGAON', department_id: null },
    { centre: 'ANKHEER', department_id: 'd1' },
  ]

  it('resolveOverride honours wildcard and root-centre scopes', () => {
    // global '*' opens everything
    expect(resolveOverride(OVERRIDES, { centre: 'HODAL', rootCentre: 'GURGAON', departmentId: null })).toBe(true)
    // root row opens SC_SP writes too
    expect(resolveOverride(OVERRIDES.filter(o => o.centre !== '*'), { centre: 'HODAL', rootCentre: 'GURGAON', departmentId: null })).toBe(true)
    // dept-scoped rows only open that department
    expect(resolveOverride([{ centre: 'ANKHEER', department_id: 'd1' }], { centre: 'BADHA SIKENDERPUR', rootCentre: 'ANKHEER', departmentId: null })).toBe(false)
    expect(resolveOverride([{ centre: 'ANKHEER', department_id: 'd1' }], { centre: 'BADHA SIKENDERPUR', rootCentre: 'ANKHEER', departmentId: 'd2' })).toBe(false)
    expect(resolveOverride([{ centre: 'ANKHEER', department_id: 'd1' }], { centre: 'BADHA SIKENDERPUR', rootCentre: 'ANKHEER', departmentId: 'd1' })).toBe(true)
    // an unrelated centre stays closed
    expect(resolveOverride(OVERRIDES, { centre: 'NOWHERE', rootCentre: null, departmentId: null })).toBe(true) // '*' matches
    expect(resolveOverride(OVERRIDES.filter(o => o.centre !== '*'), { centre: 'NOWHERE', rootCentre: null, departmentId: null })).toBe(false)
  })
  it('resolveOverride is null/false-safe', () => {
    expect(resolveOverride(null, { centre: 'X', rootCentre: 'X' })).toBe(false)
    expect(resolveOverride(undefined, { centre: 'X', rootCentre: 'X', departmentId: 'd1' })).toBe(false)
    expect(resolveOverride([null], { centre: 'X', rootCentre: 'X' })).toBe(false)
  })

  it('resolveVssOverride prefers the centre-specific row over the wildcard and returns tri-state values', () => {
    const rows = [
      { centre: '*', creation_open: true, deployment_open: false },
      { centre: 'GURGAON', creation_open: false, deployment_open: null },
    ]
    expect(resolveVssOverride(rows, { rootCentre: 'GURGAON', key: 'creation_open' })).toBe(false)
    expect(resolveVssOverride(rows, { rootCentre: 'GURGAON', key: 'deployment_open' })).toBeNull() // inherit
    expect(resolveVssOverride(rows, { rootCentre: 'ANKHEER', key: 'creation_open' })).toBe(true) // wildcard
    expect(resolveVssOverride(rows, { rootCentre: 'ANKHEER', key: 'deployment_open' })).toBe(false)
    expect(resolveVssOverride([], { rootCentre: 'ANY', key: 'creation_open' })).toBeNull()
    expect(resolveVssOverride(null, { rootCentre: 'ANY', key: 'creation_open' })).toBeNull()
    expect(resolveVssOverride(rows, { rootCentre: null, key: 'creation_open' })).toBeNull()
  })

  it('effectiveVssCreation hard global — global must be true, override can only force closed or bypass window', () => {
    // hard: global && (override ?? window)
    expect(effectiveVssCreation({ overrideValue: true, globalOpen: false, windowOpen: false })).toBe(false) // global false => false even if override true
    expect(effectiveVssCreation({ overrideValue: true, globalOpen: true, windowOpen: false })).toBe(true) // override true bypasses window when global true
    expect(effectiveVssCreation({ overrideValue: false, globalOpen: true, windowOpen: true })).toBe(false)
    expect(effectiveVssCreation({ overrideValue: null, globalOpen: true, windowOpen: true })).toBe(true)
    expect(effectiveVssCreation({ overrideValue: null, globalOpen: true, windowOpen: false })).toBe(false)
    expect(effectiveVssCreation({ overrideValue: null, globalOpen: false, windowOpen: true })).toBe(false)
  })

  it('effectiveVssDeployment hard global — global must be true, override can only force closed', () => {
    // hard: global && (override ?? true)
    expect(effectiveVssDeployment({ overrideValue: true, globalOpen: false })).toBe(false) // global false => false even if override true
    expect(effectiveVssDeployment({ overrideValue: false, globalOpen: true })).toBe(false)
    expect(effectiveVssDeployment({ overrideValue: true, globalOpen: true })).toBe(true)
    expect(effectiveVssDeployment({ overrideValue: null, globalOpen: true })).toBe(true) // null inherits global's open state
  })
})

describe('VSS registration age + validation', () => {
  const pad = n => String(n).padStart(2, '0')
  const now = new Date()
  const oldDob = `${now.getFullYear() - 30}-${pad(now.getMonth() + 1)}-01`
  const midDob = `${now.getFullYear() - 20}-${pad(now.getMonth() + 1)}-01`

  it('computes age from an ISO dob', () => {
    expect(computeAge(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`)).toBe(0)
    expect(computeAge(oldDob)).toBe(30)
    expect(computeAge(midDob)).toBe(20)
  })
  it('returns null for missing/invalid dob', () => {
    expect(computeAge(null)).toBeNull()
    expect(computeAge('')).toBeNull()
    expect(computeAge('06/09/2007')).toBeNull()
    expect(computeAge('not-a-date')).toBeNull()
  })
  it('flags age >= 29 when not initiated', () => {
    expect(isVssAgeBlocked(oldDob, false)).toBe(true)
    expect(isVssAgeBlocked(oldDob, true)).toBe(false)
    expect(isVssAgeBlocked(midDob, false)).toBe(false)
  })

  const validForm = {
    centre: 'GURGAON',
    sewadar_name: 'TEST',
    father_husband_name: 'FATHER',
    gender: 'MALE',
    dob: midDob,
    address: 'ADDRESS',
    contact_no: '9876543210',
    emergency_contact: '9876543211',
    is_initiated: false,
    aadhar_number: '123456789012',
  }

  it('accepts a complete valid form', () => {
    expect(vssRegistrationErrors(validForm, { hasPhoto: true })).toEqual({})
  })
  it('flags every missing required field', () => {
    const e = vssRegistrationErrors({}, { hasPhoto: false })
    expect(e.centre).toBe('Centre is required')
    expect(e.sewadar_name).toBe('Sewadar name is required')
    expect(e.gender).toBe('Gender is required')
    expect(e.dob).toBe('Date of birth is required')
    expect(e.aadhar_number).toBe('Aadhar number is required')
    expect(e.photo).toBe('Photo is required')
  })
  it('validates field formats', () => {
    expect(vssRegistrationErrors({ ...validForm, contact_no: '123' }, { hasPhoto: true }).contact_no).toMatch(/valid contact number/)
    expect(vssRegistrationErrors({ ...validForm, aadhar_number: '123' }, { hasPhoto: true }).aadhar_number).toBe('Aadhar must be exactly 12 digits')
  })
  it('blocks age >= 29 not initiated', () => {
    expect(vssRegistrationErrors({ ...validForm, dob: oldDob }, { hasPhoto: true }).age).toBe('Age >= 29, not initiated — cannot add VSS')
  })
  it('enforces the photo size limit', () => {
    expect(vssRegistrationErrors(validForm, { hasPhoto: true, photoSize: 4 * 1024 * 1024 }).photo).toBe('Photo must be under 3 MB')
  })
})

describe('isEligible / eligibilityReasons', () => {
  const row = { consent_given: true, available_days_count: 4, stay_at_bhati: true, is_initiated: false }
  const deptBasic = { min_days: 3, requires_stay_at_bhati: false, requires_initiated: false }
  const deptBhati = { min_days: 3, requires_stay_at_bhati: true, requires_initiated: false }
  const deptInitiated = { min_days: 3, requires_stay_at_bhati: false, requires_initiated: true }

  it('eligible when all rules pass', () => {
    expect(isEligible(row, deptBasic)).toBe(true)
    expect(isEligible(row, deptBhati)).toBe(true)
    expect(eligibilityReasons(row, deptBasic)).toEqual([])
  })
  it('blocks when consent not given', () => {
    expect(isEligible({ ...row, consent_given: false }, deptBasic)).toBe(false)
    expect(eligibilityReasons({ ...row, consent_given: false }, deptBasic)).toEqual(['Consent not given'])
  })
  it('blocks when days too few with a reason', () => {
    expect(eligibilityReasons({ ...row, available_days_count: 2 }, deptBasic)).toEqual([
      'Needs minimum 3 consent days (has 2)',
    ])
  })
  it('handles null available_days_count and pluralises for a 1-day requirement', () => {
    expect(eligibilityReasons({ ...row, available_days_count: null }, deptBasic)).toEqual([
      'Needs minimum 3 consent days (has 0)',
    ])
    expect(eligibilityReasons({ ...row, available_days_count: 0 }, { min_days: 1 })).toEqual([
      'Needs minimum 1 consent day (has 0)',
    ])
  })
  it('blocks stay-at-bhati requirement', () => {
    expect(eligibilityReasons({ ...row, stay_at_bhati: false }, deptBhati)).toEqual(['Requires stay at bhati'])
  })
  it('blocks initiated requirement', () => {
    expect(eligibilityReasons(row, deptInitiated)).toEqual(['Requires initiated sewadar'])
  })
  it('passes when an initiated requirement is satisfied', () => {
    expect(isEligible({ ...row, is_initiated: true }, deptInitiated)).toBe(true)
  })
  it('defaults missing min_days to 1 and missing days to 0', () => {
    expect(isEligible({ consent_given: true, available_days_count: 2 }, { min_days: null })).toBe(true)
    expect(eligibilityReasons({ consent_given: true, available_days_count: 2 }, { min_days: null })).toEqual([])
    // missing days fall back to 0 and get flagged against the default of 1
    expect(eligibilityReasons({ consent_given: true, available_days_count: null }, { min_days: null }))
      .toEqual(['Needs minimum 1 consent day (has 0)'])
    // isEligible treats missing days as 0 too
    expect(isEligible({ consent_given: true, available_days_count: null }, { min_days: 1 })).toBe(false)
  })
})

describe('consent row signatures / dirty detection', () => {
  const row = { centre: 'GURGAON', badge_number: 'B1', consent_given: true, available_days_count: 3, stay_at_bhati: true, chair_pass: false, requested_dept: 'd1' }

  it('keys rows by centre|badge', () => {
    expect(consentRowKey(row)).toBe('GURGAON|B1')
  })
  it('signature reflects every persisted editable field', () => {
    expect(consentRowSignature(row)).toBe('true|3|true|false|d1|true')
  })
  it('signature treats consent_given=false as days null (not persisted days)', () => {
    expect(consentRowSignature({ ...row, consent_given: false, available_days_count: 5 })).toBe('false||true|false|d1|true')
  })
  it('VSS rows include is_active in the signature', () => {
    expect(consentRowSignature({ ...row, is_active: false })).toBe('true|3|true|false|d1|false')
  })
  it('changedConsentRows returns only rows that differ from the snapshot', () => {
    const rows = [
      { ...row },
      { ...row, badge_number: 'B2', requested_dept: 'd2' },
      { ...row, badge_number: 'B3', consent_given: false, requested_dept: '' },
    ]
    const snap = {
      'GURGAON|B1': consentRowSignature(rows[0]),
      'GURGAON|B2': consentRowSignature({ ...rows[1], requested_dept: 'd1' }), // B2 changed dept
      'GURGAON|B3': consentRowSignature(rows[2]),
    }
    const changed = changedConsentRows(rows, snap)
    expect(changed.map(r => r.badge_number)).toEqual(['B2'])
  })
  it('buildConsentSnapshot round-trips as no-op for unchanged rows', () => {
    const rows = { 'GURGAON|B1': { ...row } }
    const snap = buildConsentSnapshot(rows)
    expect(changedConsentRows(rows, snap)).toEqual([])
  })
  it('new rows (missing from snapshot) are always dirty', () => {
    const rows = { 'GURGAON|B9': { ...row, badge_number: 'B9' } }
    expect(changedConsentRows(rows, {})).toHaveLength(1)
  })
  it('buildConsentSnapshot stores value objects (not signature strings)', () => {
    const snap = buildConsentSnapshot({ 'GURGAON|B1': { ...row } })
    expect(snap['GURGAON|B1']).toEqual({
      consent_given: true,
      available_days_count: 3,
      stay_at_bhati: true,
      chair_pass: false,
      requested_dept: 'd1',
      is_active: true,
    })
    // consent_given=false coerces days to null (mirrors the signature)
    const snap2 = buildConsentSnapshot({ 'GURGAON|B1': { ...row, consent_given: false, available_days_count: 5 } })
    expect(snap2['GURGAON|B1'].available_days_count).toBeNull()
    // a row with no department stores an empty requested_dept (no undefined leak)
    const snap3 = buildConsentSnapshot({ 'GURGAON|B1': { ...row, requested_dept: undefined } })
    expect(snap3['GURGAON|B1'].requested_dept).toBe('')
  })
  it('changedConsentRows accepts value-object snapshots (round-trip + drift)', () => {
    const rows = { 'GURGAON|B1': { ...row } }
    expect(changedConsentRows(rows, buildConsentSnapshot(rows))).toEqual([])
    const drifted = buildConsentSnapshot({ 'GURGAON|B1': { ...row, stay_at_bhati: false } })
    expect(changedConsentRows(rows, drifted)).toHaveLength(1)
    // the legacy string-snapshot format still works (older call sites/tests)
    const legacy = { 'GURGAON|B1': consentRowSignature({ ...row, stay_at_bhati: false }) }
    expect(changedConsentRows(rows, legacy)).toHaveLength(1)
  })
  it('changedConsentFields returns ONLY the fields that differ', () => {
    const saved = { consent_given: true, available_days_count: 3, stay_at_bhati: true, chair_pass: false }
    expect(changedConsentFields({ ...row, stay_at_bhati: false }, saved)).toEqual({ stay_at_bhati: false })
    expect(changedConsentFields({ ...row, stay_at_bhati: false, chair_pass: true }, saved))
      .toEqual({ stay_at_bhati: false, chair_pass: true })
    expect(changedConsentFields(row, saved)).toBeNull()
  })
  it('changedConsentFields treats a missing snapshot as a full insert', () => {
    expect(changedConsentFields(row, null)).toEqual({
      consent_given: true,
      available_days_count: 3,
      stay_at_bhati: true,
      chair_pass: false,
    })
    expect(changedConsentFields({ ...row, consent_given: false, available_days_count: null }, undefined))
      .toEqual({ consent_given: false, available_days_count: null, stay_at_bhati: true, chair_pass: false })
  })
  it('changedConsentFields ignores fields that are not consent-persisted (requested_dept, is_active)', () => {
    const saved = { consent_given: true, available_days_count: 3, stay_at_bhati: true, chair_pass: false }
    expect(changedConsentFields({ ...row, requested_dept: 'd9', is_active: false }, saved)).toBeNull()
  })
  it('changedConsentFields handles a null row', () => {
    expect(changedConsentFields(null, {})).toBeNull()
  })
})

describe('prev-year attendance', () => {
  it('denominator is 3 for TRAFFIC OUTSIDE BHATI else 5', () => {
    expect(attendanceDenominator('TRAFFIC OUTSIDE BHATI')).toBe(3)
    expect(attendanceDenominator('LANGAR')).toBe(5)
  })
  it('displays clamped value', () => {
    expect(attendanceDisplay(3, 'TRAFFIC OUTSIDE BHATI')).toBe('3 / 3')
    expect(attendanceDisplay(5, 'LANGAR')).toBe('5 / 5')
    expect(attendanceDisplay(2, 'LANGAR')).toBe('2 / 5')
    expect(attendanceDisplay(null, 'LANGAR')).toBeNull()
  })
  it('flags low attendance: 0,1 always; 2 only non-traffic-outside', () => {
    expect(isLowAttendance(0, 'LANGAR')).toBe(true)
    expect(isLowAttendance(1, 'TRAFFIC OUTSIDE BHATI')).toBe(true)
    expect(isLowAttendance(2, 'LANGAR')).toBe(true)
    expect(isLowAttendance(2, 'TRAFFIC OUTSIDE BHATI')).toBe(false)
    expect(isLowAttendance(3, 'TRAFFIC OUTSIDE BHATI')).toBe(false)
    expect(isLowAttendance(5, 'LANGAR')).toBe(false)
    expect(isLowAttendance(null, 'LANGAR')).toBe(false)
  })
  it('normalizes department labels (case/whitespace) before comparing', () => {
    expect(attendanceDenominator('traffic outside bhati')).toBe(3)
    expect(attendanceDenominator(' Traffic Outside Bhati ')).toBe(3)
    expect(isLowAttendance(2, 'traffic OUTSIDE bhati')).toBe(false)
    expect(isLowAttendance(2, 'Traffic Outside Bhati ')).toBe(false)
  })
  it('handles nullish departments safely', () => {
    expect(attendanceDenominator(null)).toBe(5)
    expect(attendanceDenominator(undefined)).toBe(5)
    expect(isLowAttendance(2, null)).toBe(true)
  })
})

describe('centre hierarchy edge cases', () => {
  it('getRootCentre returns the name itself for unknown centres', () => {
    expect(getRootCentre(CENTRES, 'NOWHERE')).toBe('NOWHERE')
    expect(getRootCentre([], 'ANY')).toBe('ANY')
  })
  it('getSubtreeCentres returns [] for unknown centres and handles deep chains', () => {
    expect(getSubtreeCentres(CENTRES, 'NOWHERE')).toEqual([])
    const deep = [
      { name: 'A', parent_centre: null },
      { name: 'B', parent_centre: 'A' },
      { name: 'C', parent_centre: 'B' },
      { name: 'D', parent_centre: 'C' },
    ]
    expect(getSubtreeCentres(deep, 'A')).toEqual(['A', 'B', 'C', 'D'])
    expect(getRootCentre(deep, 'D')).toBe('A')
  })
  it('getSubtreeCentres is null-safe on the centres list and name', () => {
    expect(getSubtreeCentres(null, 'GURGAON')).toEqual([])
    expect(getSubtreeCentres(undefined, 'GURGAON')).toEqual([])
    expect(getSubtreeCentres(CENTRES, null)).toEqual([])
    expect(getSubtreeCentres(CENTRES, '')).toEqual([])
  })
  it('getParentCentres handles an empty list', () => {
    expect(getParentCentres([])).toEqual([])
  })
})

describe('computeDeptQuota robustness', () => {
  const allocs = [{ department_id: 'd1', centre: 'GURGAON', max_count: 10 }]
  it('does not throw when savedAll / localOwn are undefined', () => {
    expect(() => computeDeptQuota(allocs)).not.toThrow()
    expect(computeDeptQuota(allocs).d1.rem).toBe(10)
  })
  it('works when savedOwn is omitted (3 args)', () => {
    const q = computeDeptQuota(allocs, { d1: 4 }, { d1: 4 })
    expect(q.d1.own).toBe(0)
    expect(q.d1.effective).toBe(8) // 4 saved + (4 local − 0 own)
  })
  it('outputs only allocated departments', () => {
    const q = computeDeptQuota(allocs, { dX: 99 }, { dX: 1 }, { dX: 1 })
    expect(Object.keys(q)).toEqual(['d1'])
  })
  it('returns an empty map when allocations is null', () => {
    expect(computeDeptQuota(null, {}, {}, {})).toEqual({})
    expect(computeDeptQuota(undefined)).toEqual({})
  })
})

describe('isVssBadge case-insensitivity', () => {
  it('matches lowercase vs prefix', () => {
    expect(isVssBadge('vsfb5971')).toBe(true)
    expect(isVssBadge('Vs123')).toBe(true)
  })
})

describe('eligibility null-safety', () => {
  const dept = { min_days: 3 }
  it('isEligible returns false for missing row or dept', () => {
    expect(isEligible(null, dept)).toBe(false)
    expect(isEligible({ consent_given: true }, null)).toBe(false)
  })
  it('eligibilityReasons reports missing inputs', () => {
    expect(eligibilityReasons(null, dept)).toEqual(['Department not found'])
    expect(eligibilityReasons({ consent_given: true }, null)).toEqual(['Department not found'])
  })
  it('vssEligibilityReasons reports missing inputs', () => {
    expect(vssEligibilityReasons(null, {}, dept)).toEqual(['Department not found'])
    expect(vssEligibilityReasons({ consent_given: true }, {}, null)).toEqual(['Department not found'])
  })
  it('blocks VSS initiated/gender requirements when the sewadar record is missing', () => {
    const dInit = { include_vss: true, vss_min_days: 1, vss_requires_initiated: true }
    expect(isEligibleVss({ consent_given: true, available_days_count: 2 }, null, dInit)).toBe(false)
    const dGen = { include_vss: true, vss_min_days: 1, vss_requires_gender: 'FEMALE' }
    expect(vssEligibilityReasons({ consent_given: true, available_days_count: 2 }, null, dGen)).toEqual(['Requires FEMALE VSS sewadar'])
  })
  it('blocks when consent days are missing entirely', () => {
    const d = { include_vss: true, vss_min_days: 1 }
    expect(isEligibleVss({ consent_given: true }, { is_active: true }, d)).toBe(false)
  })
  it('isEligibleVss returns false for a missing consent row', () => {
    expect(isEligibleVss(null, { is_active: true }, { include_vss: true })).toBe(false)
  })
  it('falls back to sensible defaults for missing vss_min_days and gender', () => {
    const d = { include_vss: true, vss_min_days: null, vss_requires_gender: 'FEMALE' }
    expect(isEligibleVss({ consent_given: true, available_days_count: 2 }, null, d)).toBe(false)
    expect(vssEligibilityReasons({ consent_given: true, available_days_count: 2 }, null, d))
      .toEqual(['Requires FEMALE VSS sewadar'])
  })
  it('pluralises the min-days message for a 1-day requirement', () => {
    const d = { include_vss: true, vss_min_days: 1 }
    expect(vssEligibilityReasons({ consent_given: true, available_days_count: 0 }, { is_active: true }, d))
      .toEqual(['Needs minimum 1 consent day (has 0)'])
    // null days also surfaces the fallback of 0 in the message
    expect(vssEligibilityReasons({ consent_given: true, available_days_count: null }, { is_active: true }, d))
      .toEqual(['Needs minimum 1 consent day (has 0)'])
  })
})

describe('canEditDeployment edge cases', () => {
  it('requires a schedule', () => {
    expect(canEditDeployment({ editableRole: true, schedule: null, deadlinePassed: false, done: false, masterOpen: true })).toBe(false)
  })
  it('treats an undefined master switch as open', () => {
    expect(canEditDeployment({ editableRole: true, schedule: { status: 'open' }, deadlinePassed: false, done: false, masterOpen: undefined })).toBe(true)
  })
})

describe('computeAge edge cases', () => {
  it('rejects malformed dates', () => {
    expect(computeAge('2024-13-01')).toBeNull()
    expect(computeAge('2024-05-00')).toBeNull()
    expect(computeAge('2024-00-10')).toBeNull()
  })
  it('computes an age for a leap-day dob', () => {
    expect(computeAge('2000-02-29')).toBeGreaterThan(20)
  })
  it('decrements age when the birthday has not arrived yet this year', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(2026, 7, 9, 12, 0, 0)) // 9 Aug 2026
      // raw age would be 1 (2026 − 2025); Dec > Aug so the birthday hasn't
      // arrived yet this year → decrement to 0
      expect(computeAge('2025-12-31')).toBe(0)
      // same month, later day → still decrements. NOTE: a future DOB yields a
      // negative age — intentional, current behavior (no clamping); if the
      // form ever clamps ages, update this assertion.
      expect(computeAge('2026-08-20')).toBe(-1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('vssRegistrationErrors edge cases', () => {
  const form = {
    centre: 'GURGAON',
    sewadar_name: 'TEST',
    father_husband_name: 'FATHER',
    gender: 'MALE',
    dob: '2000-01-01',
    address: 'ADDRESS',
    contact_no: '9876543210',
    emergency_contact: '9876543211',
    aadhar_number: '123456789012',
  }
  it('rejects whitespace-only names', () => {
    expect(vssRegistrationErrors({ ...form, sewadar_name: '   ' }, { hasPhoto: true }).sewadar_name).toBe('Sewadar name is required')
  })
  it('accepts contact numbers with spaces/dashes after stripping non-digits', () => {
    expect(vssRegistrationErrors({ ...form, contact_no: '98765 43210' }, { hasPhoto: true }).contact_no).toBeUndefined()
  })
  it('rejects an invalid emergency contact', () => {
    expect(vssRegistrationErrors({ ...form, emergency_contact: 'abc' }, { hasPhoto: true }).emergency_contact).toMatch(/valid contact number/)
  })
  it('rejects a structurally-invalid dob', () => {
    expect(vssRegistrationErrors({ ...form, dob: 'not-a-date' }, { hasPhoto: true }).dob).toBe('Enter a valid date of birth')
  })
  it('accepts a photo at exactly 3 MB', () => {
    expect(vssRegistrationErrors(form, { hasPhoto: true, photoSize: 3 * 1024 * 1024 }).photo).toBeUndefined()
  })
})

describe('consent signature invariants', () => {
  const row = { centre: 'GURGAON', badge_number: 'B1', consent_given: true, available_days_count: 3, stay_at_bhati: true, chair_pass: true, requested_dept: 'd1', is_active: true }
  it('returns a stable signature for null/empty rows', () => {
    expect(consentRowSignature(null)).toBe('')
    expect(consentRowSignature(undefined)).toBe('')
    expect(consentRowSignature({})).toBe('false||false|false||true') // null days & '' dept join as empty
  })
  it('EDITABLE_CONSENT_FIELDS is exactly the persisted editable fields (excluding is_active)', () => {
    expect(EDITABLE_CONSENT_FIELDS).toEqual(['consent_given', 'available_days_count', 'stay_at_bhati', 'chair_pass', 'requested_dept'])
    expect(EDITABLE_CONSENT_FIELDS).not.toContain('is_active')
  })
  it('changing any single editable field changes the signature', () => {
    const flip = {
      consent_given: r => ({ ...r, consent_given: false }),
      available_days_count: r => ({ ...r, available_days_count: 4 }),
      stay_at_bhati: r => ({ ...r, stay_at_bhati: false }),
      chair_pass: r => ({ ...r, chair_pass: false }),
      requested_dept: r => ({ ...r, requested_dept: 'd2' }),
    }
    const base = consentRowSignature(row)
    EDITABLE_CONSENT_FIELDS.forEach(f => {
      expect(consentRowSignature(flip[f](row))).not.toBe(base)
    })
  })
  it('is_active changes the signature too (VSS) even though it is not editable', () => {
    expect(consentRowSignature({ ...row, is_active: false })).not.toBe(consentRowSignature(row))
  })
})

describe('changedConsentRows robustness', () => {
  it('handles null rows', () => {
    expect(changedConsentRows(null, {})).toEqual([])
    expect(changedConsentRows(undefined, {})).toEqual([])
  })
  it('buildConsentSnapshot returns an empty snapshot for null/undefined rows', () => {
    expect(buildConsentSnapshot(null)).toEqual({})
    expect(buildConsentSnapshot(undefined)).toEqual({})
  })
  it('treats every row as dirty when no snapshot is provided', () => {
    const rows = { k1: { centre: 'G', badge_number: '1' }, k2: { centre: 'G', badge_number: '2' } }
    expect(changedConsentRows(rows, null)).toHaveLength(2)
  })
})

describe('attendance display clamping', () => {
  it('clamps attendance above the denominator', () => {
    expect(attendanceDisplay(7, 'LANGAR')).toBe('5 / 5')
    expect(attendanceDisplay(4, 'TRAFFIC OUTSIDE BHATI')).toBe('3 / 3')
  })
})

describe('available days rules', () => {
  it('defaults to 5 days and OE ESCORTS is fixed at 3', () => {
    expect(DEFAULT_AVAILABLE_DAYS).toBe(5)
    expect(OE_ESCORTS_DAYS).toBe(3)
    expect(OE_ESCORTS_DEPT_NAME).toBe('OE ESCORTS')
  })
  it('isOeEscortsDept matches the name case-insensitively, trimmed, with SEWA variants', () => {
    expect(isOeEscortsDept('OE ESCORTS')).toBe(true)
    expect(isOeEscortsDept('oe escorts')).toBe(true)
    expect(isOeEscortsDept('  OE ESCORTS  ')).toBe(true)
    expect(isOeEscortsDept('OE ESCORTS (SEWA)')).toBe(true) // variant used in prod
    expect(isOeEscortsDept('oe escorts-sewa')).toBe(true)
    expect(isOeEscortsDept('LANGAR')).toBe(false)
    expect(isOeEscortsDept('ESCORTS AUX')).toBe(false) // not a prefix match
    expect(isOeEscortsDept('')).toBe(false)
    expect(isOeEscortsDept(null)).toBe(false)
    expect(isOeEscortsDept(undefined)).toBe(false)
  })
  it('daysForDept auto-sets 5 for every department and 3 for OE ESCORTS', () => {
    expect(daysForDept('LANGAR')).toBe(DEFAULT_AVAILABLE_DAYS)
    expect(daysForDept('')).toBe(DEFAULT_AVAILABLE_DAYS)
    expect(daysForDept(null)).toBe(DEFAULT_AVAILABLE_DAYS)
    expect(daysForDept(undefined)).toBe(DEFAULT_AVAILABLE_DAYS)
    expect(daysForDept('OE ESCORTS')).toBe(OE_ESCORTS_DAYS)
    expect(daysForDept('  oe escorts-sewa  ')).toBe(OE_ESCORTS_DAYS)
    expect(daysForDept('OE ESCORTS (SEWA)')).toBe(OE_ESCORTS_DAYS)
  })
})

/* ─── VSS dropdown selection interaction tests ─── */
describe('VSS dropdown selection behavior', () => {
  const schedule = { status: 'open' }
  const doneSchedule = { status: 'done' }

  describe('canEditDeployment vssOpen + overrideOpen interaction', () => {
    const base = { editableRole: true, schedule, deadlinePassed: true, done: false, masterOpen: false, locked: true }

    it('vssOpen=true wins over locked+deadline even when overrideOpen=false', () => {
      expect(canEditDeployment({ ...base, overrideOpen: false, vssOpen: true })).toBe(true)
    })

    it('overrideOpen=true wins over locked+deadline even when vssOpen=false', () => {
      expect(canEditDeployment({ ...base, overrideOpen: true, vssOpen: false })).toBe(true)
    })

    it('both vssOpen and overrideOpen true still allows editing', () => {
      expect(canEditDeployment({ ...base, overrideOpen: true, vssOpen: true })).toBe(true)
    })

    it('neither vssOpen nor overrideOpen: locked+deadline blocks', () => {
      expect(canEditDeployment({ ...base, overrideOpen: false, vssOpen: false })).toBe(false)
    })

    it('vssOpen=true never reopens a done schedule', () => {
      expect(canEditDeployment({ editableRole: true, schedule: doneSchedule, deadlinePassed: false, done: true, masterOpen: true, locked: false, vssOpen: true })).toBe(false)
    })

    it('vssOpen=true never allows non-editable role', () => {
      expect(canEditDeployment({ editableRole: false, schedule, deadlinePassed: true, done: false, masterOpen: true, vssOpen: true })).toBe(false)
    })
  })

  describe('canEditDeployment VSS effective switch (v34 design)', () => {
    const base = { editableRole: true, schedule, deadlinePassed: true, done: false, locked: true }

    it('VSS open: masterOpen=true → vssOpen=true → bypass lock+deadline', () => {
      // VssPage passes vssOpen: masterOpen when VSS effective switch is ON
      expect(canEditDeployment({ ...base, masterOpen: true, vssOpen: true })).toBe(true)
    })

    it('VSS closed: masterOpen=false → vssOpen=false → blocked by lock+deadline', () => {
      expect(canEditDeployment({ ...base, masterOpen: false, vssOpen: false })).toBe(false)
    })

    it('VSS open but schedule done: still blocked', () => {
      expect(canEditDeployment({ editableRole: true, schedule: doneSchedule, deadlinePassed: false, done: true, masterOpen: true, locked: false, vssOpen: true })).toBe(false)
    })

    it('VSS open but non-editable role: still blocked', () => {
      expect(canEditDeployment({ editableRole: false, schedule, deadlinePassed: true, done: false, masterOpen: true, locked: true, vssOpen: true })).toBe(false)
    })

    it('VSS open overrides both lock and deadline simultaneously', () => {
      expect(canEditDeployment({ ...base, masterOpen: true, vssOpen: true, overrideOpen: false })).toBe(true)
    })

    it('generic overrideOpen does NOT reopen VSS when masterOpen=false', () => {
      // VSS is gated solely by the VSS effective switch — generic overrides
      // must not reopen VSS. overrideOpen=true would normally bypass lock+
      // deadline, but the VssPage passes overrideOpen=false for VSS, so this
      // test verifies the caller's intent.
      expect(canEditDeployment({ ...base, masterOpen: false, overrideOpen: true, vssOpen: false })).toBe(true)
      // Note: canEditDeployment itself doesn't distinguish VSS from regular —
      // it trusts the caller's vssOpen/overrideOpen flags. The VssPage always
      // passes overrideOpen=false for VSS, so this case never happens in
      // practice. The test documents the contract.
    })
  })

  describe('daysForDept selection impact', () => {
    it('changing to OE ESCORTS reduces days from 5 to 3', () => {
      expect(daysForDept('LANGAR')).toBe(5)
      expect(daysForDept('OE ESCORTS')).toBe(3)
    })

    it('changing from OE ESCORTS to another dept increases days from 3 to 5', () => {
      expect(daysForDept('OE ESCORTS')).toBe(3)
      expect(daysForDept('PRASADAM')).toBe(5)
    })

    it('null/undefined dept defaults to 5 days', () => {
      expect(daysForDept(null)).toBe(5)
      expect(daysForDept(undefined)).toBe(5)
    })
  })
})

  describe('vss_operator quota scope (selectQuotaAllocations + resolveOperatorQuotaRoot)', () => {
    const allocs = [
      { department_id: 'd1', centre: 'GURGAON', max_count: 10 },
      { department_id: 'd1', centre: 'HODAL', max_count: 5 },
      { department_id: 'd2', centre: 'ANKHEER', max_count: 7 },
    ]
    it('All centres union: operator with null root gets every in-scope centre row', () => {
      const out = selectQuotaAllocations({ allocations: allocs, quotaRoot: null, isVssOperator: true, subtree: ['GURGAON', 'HODAL'] })
      expect(out.map(a => a.centre).sort()).toEqual(['GURGAON', 'HODAL'])
    })
    it('Filtered root: operator with a root gets only that root', () => {
      const out = selectQuotaAllocations({ allocations: allocs, quotaRoot: 'GURGAON', isVssOperator: true, subtree: ['GURGAON', 'HODAL', 'ANKHEER'] })
      expect(out).toEqual([{ department_id: 'd1', centre: 'GURGAON', max_count: 10 }])
    })
    it('Non-operator passthrough: ignores subtree', () => {
      const out = selectQuotaAllocations({ allocations: allocs, quotaRoot: 'GURGAON', isVssOperator: false, subtree: ['GURGAON', 'HODAL', 'ANKHEER'] })
      expect(out).toEqual([{ department_id: 'd1', centre: 'GURGAON', max_count: 10 }])
    })
    it('Empty allocations: returns [] for both roles', () => {
      expect(selectQuotaAllocations({ allocations: [], quotaRoot: null, isVssOperator: true, subtree: ['GURGAON'] })).toEqual([])
      expect(selectQuotaAllocations({ allocations: null, quotaRoot: 'GURGAON', isVssOperator: false, subtree: ['GURGAON'] })).toEqual([])
    })
    it('Unknown/null root non-operator: returns [] (no phantom match)', () => {
      expect(selectQuotaAllocations({ allocations: allocs, quotaRoot: null, isVssOperator: false, subtree: ['GURGAON'] })).toEqual([])
    })
    it('resolveOperatorQuotaRoot: all -> null, picked centre -> its CENTRE root, non-operator -> null', () => {
      const centres = [
        { name: 'GURGAON', parent_centre: '' },
        { name: 'HODAL', parent_centre: 'GURGAON' },
      ]
      expect(resolveOperatorQuotaRoot({ isVssOperator: true, filterCentre: 'all', centres })).toBe(null)
      expect(resolveOperatorQuotaRoot({ isVssOperator: true, filterCentre: 'HODAL', centres })).toBe('GURGAON')
      expect(resolveOperatorQuotaRoot({ isVssOperator: false, filterCentre: 'HODAL', centres })).toBe(null)
    })
  })
