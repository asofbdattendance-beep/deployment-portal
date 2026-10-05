import { describe, it, expect } from 'vitest'
import {
  SEWA_MODE_VISIT,
  SEWA_MODE_PREVISIT,
  PREVISIT_ROLES,
  canUsePrevisitMode,
  toISODate,
  scheduleWindow,
  expandDateRange,
  previsitCutoff,
  isPrevisitAvailable,
  resolveSewaMode,
  clampDateToWindow,
  isTestLogin,
} from './sewaMode'

describe('canUsePrevisitMode', () => {
  it('admits dept_incharge, scanner, aso and super_admin only', () => {
    expect(PREVISIT_ROLES).toEqual(['dept_incharge', 'scanner', 'aso', 'super_admin'])
    for (const role of PREVISIT_ROLES) expect(canUsePrevisitMode(role)).toBe(true)
  })

  it('denies centre roles, vss_operator and unknown roles', () => {
    expect(canUsePrevisitMode('centre_user')).toBe(false)
    expect(canUsePrevisitMode('centre_admin')).toBe(false)
    expect(canUsePrevisitMode('vss_operator')).toBe(false)
    expect(canUsePrevisitMode(undefined)).toBe(false)
    expect(canUsePrevisitMode('')).toBe(false)
  })
})

describe('toISODate', () => {
  it('passes plain dates through and trims datetimes', () => {
    expect(toISODate('2026-10-07')).toBe('2026-10-07')
    expect(toISODate('2026-10-07T00:00:00+05:30')).toBe('2026-10-07')
  })

  it('returns empty for anything else, never throws', () => {
    expect(toISODate(null)).toBe('')
    expect(toISODate(undefined)).toBe('')
    expect(toISODate(20261007)).toBe('')
    expect(toISODate('2026-10-7')).toBe('')
    expect(toISODate('not-a-date')).toBe('')
  })
})

describe('scheduleWindow', () => {
  it('reads the window off a schedule row', () => {
    expect(scheduleWindow({ visit_start_date: '2026-10-07', visit_end_date: '2026-10-11' }))
      .toEqual({ start: '2026-10-07', end: '2026-10-11' })
  })

  it('returns empty strings when unset', () => {
    expect(scheduleWindow({})).toEqual({ start: '', end: '' })
    expect(scheduleWindow(null)).toEqual({ start: '', end: '' })
  })
})

describe('expandDateRange', () => {
  it('expands an inclusive window in order', () => {
    expect(expandDateRange('2026-10-07', '2026-10-11')).toEqual([
      '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11',
    ])
  })

  it('a single-day window yields one date', () => {
    expect(expandDateRange('2026-10-07', '2026-10-07')).toEqual(['2026-10-07'])
  })

  it('is empty for any unusable window', () => {
    expect(expandDateRange('', '')).toEqual([])
    expect(expandDateRange('2026-10-11', '2026-10-07')).toEqual([])
    expect(expandDateRange('nope', '2026-10-07')).toEqual([])
  })

  it('caps pathological ranges', () => {
    expect(expandDateRange('2026-01-01', '2027-12-31', 5)).toHaveLength(5)
  })
})

describe('resolveSewaMode', () => {
  const START = '2026-10-07'
  const END = '2026-10-11'

  it('cuts previsit off one day before the visit window', () => {
    expect(previsitCutoff(START)).toBe('2026-10-06')
    expect(resolveSewaMode(START, END, '2026-10-06')).toBe(SEWA_MODE_VISIT)
    expect(resolveSewaMode(START, END, '2026-10-05')).toBe(SEWA_MODE_PREVISIT)
  })

  it('stays on the visit view through and after the window', () => {
    expect(resolveSewaMode(START, END, '2026-10-07')).toBe(SEWA_MODE_VISIT)
    expect(resolveSewaMode(START, END, '2026-10-09')).toBe(SEWA_MODE_VISIT)
    expect(resolveSewaMode(START, END, '2026-10-11')).toBe(SEWA_MODE_VISIT)
    expect(resolveSewaMode(START, END, '2026-10-12')).toBe(SEWA_MODE_VISIT)
  })

  it('is visit from the cutoff through the window and after it', () => {
    expect(resolveSewaMode(START, END, '2026-10-06')).toBe(SEWA_MODE_VISIT)
    expect(resolveSewaMode(START, END, '2026-10-07')).toBe(SEWA_MODE_VISIT)
    expect(resolveSewaMode(START, END, '2026-10-09')).toBe(SEWA_MODE_VISIT)
    expect(resolveSewaMode(START, END, '2026-10-11')).toBe(SEWA_MODE_VISIT)
    expect(resolveSewaMode(START, END, '2026-10-12')).toBe(SEWA_MODE_VISIT)
    expect(resolveSewaMode(START, END, '2026-10-05')).toBe(SEWA_MODE_PREVISIT)
  })

  it('fails toward previsit when the window is unusable', () => {
    expect(resolveSewaMode('', '', '2026-10-06')).toBe(SEWA_MODE_PREVISIT)
    expect(resolveSewaMode(START, '', '2026-10-08')).toBe(SEWA_MODE_PREVISIT)
    expect(resolveSewaMode('', END, '2026-10-08')).toBe(SEWA_MODE_PREVISIT)
    expect(resolveSewaMode(END, START, '2026-10-09')).toBe(SEWA_MODE_PREVISIT)
    expect(resolveSewaMode(START, END, '')).toBe(SEWA_MODE_PREVISIT)
  })
})

describe('isPrevisitAvailable', () => {
  it('is true only strictly before the cutoff day', () => {
    expect(isPrevisitAvailable('2026-10-07', '2026-10-05')).toBe(true)
    expect(isPrevisitAvailable('2026-10-07', '2026-10-06')).toBe(false)
    expect(isPrevisitAvailable('2026-10-07', '2026-10-12')).toBe(false)
  })

  it('is false when the window or today is unusable', () => {
    expect(isPrevisitAvailable('', '2026-10-05')).toBe(false)
    expect(isPrevisitAvailable('2026-10-07', '')).toBe(false)
  })
})

describe('clampDateToWindow', () => {
  const WIN = { start: '2026-10-07', end: '2026-10-11' }

  it('snaps outside dates to the nearest window edge', () => {
    expect(clampDateToWindow('2026-10-02', WIN)).toBe('2026-10-07')
    expect(clampDateToWindow('2026-10-20', WIN)).toBe('2026-10-11')
  })

  it('leaves inside dates alone', () => {
    expect(clampDateToWindow('2026-10-07', WIN)).toBe('2026-10-07')
    expect(clampDateToWindow('2026-10-09', WIN)).toBe('2026-10-09')
    expect(clampDateToWindow('2026-10-11', WIN)).toBe('2026-10-11')
  })

  it('passes empty and windowless schedules through untouched', () => {
    expect(clampDateToWindow('', WIN)).toBe('')
    expect(clampDateToWindow('2026-10-02', { start: '', end: '' })).toBe('2026-10-02')
    expect(clampDateToWindow('2026-10-02', null)).toBe('2026-10-02')
  })
})

describe('isTestLogin', () => {
  it('flags any email containing "test", case-insensitively', () => {
    expect(isTestLogin({ email: 'aso@test.com' })).toBe(true)
    expect(isTestLogin({ email: 'Test.ASO@Example.in' })).toBe(true)
    expect(isTestLogin({ email: 'aso@real.org' })).toBe(false)
  })

  it('fails closed without an email', () => {
    expect(isTestLogin({})).toBe(true)
    expect(isTestLogin(null)).toBe(true)
  })
})
