import { describe, it, expect } from 'vitest'
import {
  notElderlyFilter,
  isElderly,
  getParentCentres,
  getRootCentre,
  getSubtreeCentres,
  computeDeptQuota,
  isEligible,
  eligibilityReasons,
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
  it('computes remaining as max - local', () => {
    const q = computeDeptQuota(allocs, { d1: 4 }, { d1: 6 })
    expect(q.d1).toEqual({ max: 10, used: 4, local: 6, rem: 4 })
  })
  it('allows negative rem to signal over-quota', () => {
    const q = computeDeptQuota(allocs, { d2: 3 }, { d2: 5 })
    expect(q.d2.rem).toBe(-2)
  })
  it('handles missing keys', () => {
    const q = computeDeptQuota(allocs, {}, {})
    expect(q.d1.rem).toBe(10)
    expect(q.d2.local).toBe(0)
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
