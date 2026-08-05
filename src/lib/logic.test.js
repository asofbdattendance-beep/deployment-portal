import { describe, it, expect } from 'vitest'
import {
  notElderlyFilter,
  isElderly,
  getParentCentres,
  getRootCentre,
  getSubtreeCentres,
  computeDeptQuota,
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

describe('centre hierarchy', () => {
  it('getParentCentres returns only root centres', () => {
    expect(getParentCentres(CENTRES).map(c => c.name)).toEqual(['ANKHEER', 'GURGAON'])
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
  it('blocks stay-at-bhati requirement', () => {
    expect(eligibilityReasons({ ...row, stay_at_bhati: false }, deptBhati)).toEqual(['Requires stay at bhati'])
  })
  it('blocks initiated requirement', () => {
    expect(eligibilityReasons(row, deptInitiated)).toEqual(['Requires initiated sewadar'])
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
})
