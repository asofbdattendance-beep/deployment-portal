import { describe, it, expect } from 'vitest'
import {
  VISIT_DAYS,
  sessionMinutes,
  formatDuration,
  expectedDays,
  attendanceRate,
  rateBand,
  toSewadarRow,
  buildSewadarRows,
  compareSewadarRows,
  attendanceStats,
  toDailyRow,
  buildDailyRows,
  dailyTotals,
  toScannerRow,
  buildScannerRows,
  searchRows,
  filterByCentre,
  filterByDept,
  centreOptions,
  deptOptions,
  hasExpectedDays,
  FULL_VISIT_DAYS,
  UNASSIGNED_CENTRE,
  buildVisitRows,
  buildCentreTree,
  rootCentreOf,
  buildTrendRows,
  anomalyCounts,
  scannerStatus,
  timeAgo,
} from './attendance'

/* ─── sessionMinutes ─── */
describe('sessionMinutes', () => {
  it('computes a same-day session', () => {
    expect(sessionMinutes('09:00', '18:30')).toBe(570)
  })
  it('accepts HH:MM:SS', () => {
    expect(sessionMinutes('09:00:00', '11:15:30')).toBe(135)
  })
  it('rolls an overnight OUT forward a day', () => {
    expect(sessionMinutes('22:00', '02:00')).toBe(240)
  })
  it('treats an OUT at the same time-of-day as a zero-length session, not 24h', () => {
    expect(sessionMinutes('09:00', '09:00')).toBe(0)
    expect(sessionMinutes('00:00', '00:00')).toBe(0)
    expect(sessionMinutes('09:00:00', '09:00:00')).toBe(0)
  })
  it('returns null for an open session (no out time)', () => {
    expect(sessionMinutes('09:00', null)).toBeNull()
    expect(sessionMinutes('09:00', undefined)).toBeNull()
    expect(sessionMinutes('09:00', '')).toBeNull()
  })
  it('returns null when either side is missing', () => {
    expect(sessionMinutes(null, '10:00')).toBeNull()
    expect(sessionMinutes('', '')).toBeNull()
  })
  it('returns null for unparseable input', () => {
    expect(sessionMinutes('noon', 'noon')).toBeNull()
    expect(sessionMinutes('09:00', 'later')).toBeNull()
  })
  it('rejects out-of-range clock values', () => {
    expect(sessionMinutes('25:00', '26:00')).toBeNull()
    expect(sessionMinutes('09:99', '10:00')).toBeNull()
  })

  // L-06: dates were discarded, so Wed 09:00 → Sun 16:00 read "7h 0m".
  // With both dates present the true multi-day span is reported.
  it('spans multiple days when the dates differ', () => {
    // Wed 09:00 → Sun 16:00 = 4d + 7h = 6180 minutes, not 420.
    expect(sessionMinutes('09:00', '16:00', '2026-09-23', '2026-09-27')).toBe(6180)
  })
  it('matches the legacy roll for an overnight pair with explicit dates', () => {
    expect(sessionMinutes('22:00', '02:00', '2026-09-24', '2026-09-25')).toBe(240)
  })
  it('counts a full day for equal times on consecutive dates', () => {
    expect(sessionMinutes('09:00', '09:00', '2026-09-24', '2026-09-25')).toBe(1440)
  })
  it('keeps legacy behaviour when the dates are equal or absent', () => {
    expect(sessionMinutes('09:00', '18:30', '2026-09-24', '2026-09-24')).toBe(570)
    expect(sessionMinutes('22:00', '02:00', null, null)).toBe(240)
    expect(sessionMinutes('22:00', '02:00')).toBe(240)
  })
  it('returns null when the OUT date precedes the IN date', () => {
    expect(sessionMinutes('09:00', '10:00', '2026-09-25', '2026-09-24')).toBeNull()
  })
  it('degrades to times-only when a date is malformed', () => {
    expect(sessionMinutes('09:00', '10:00', 'not-a-date', '2026-09-24')).toBe(60)
  })
})

/* ─── formatDuration ─── */
describe('formatDuration', () => {
  it('formats hours and minutes', () => {
    expect(formatDuration(195)).toBe('3h 15m')
  })
  it('formats whole hours without the minute part', () => {
    expect(formatDuration(120)).toBe('2h')
  })
  it('formats sub-hour durations as minutes', () => {
    expect(formatDuration(45)).toBe('45m')
    expect(formatDuration(0)).toBe('0m')
  })
  it('renders an em dash for unknown durations', () => {
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(undefined)).toBe('—')
  })
  it('never renders a negative duration', () => {
    expect(formatDuration(-30)).toBe('0m')
  })
  it('rounds fractional minutes, dropping an empty minute part', () => {
    expect(formatDuration(59.6)).toBe('1h')
    expect(formatDuration(59.4)).toBe('59m')
  })
})

/* ─── expectedDays / attendanceRate ─── */
describe('expectedDays', () => {
  it('is 5 for a normal department', () => {
    expect(expectedDays('MEDICAL')).toBe(5)
  })
  it('is 3 for OE ESCORTS (pinned by daysForDept)', () => {
    expect(expectedDays('OE ESCORTS')).toBe(3)
    expect(expectedDays('OE ESCORTS (SEWA)')).toBe(3)
  })
  it('is 0 for a sewadar with NO department — there is nothing to expect', () => {
    // daysForDept only ever returns 3 or 5, so using it as the denominator for
    // an undeployed sewadar would read 0/5 and a misleading 0%.
    expect(expectedDays('')).toBe(0)
    expect(expectedDays('   ')).toBe(0)
    expect(expectedDays(null)).toBe(0)
    expect(expectedDays(undefined)).toBe(0)
  })
})

describe('hasExpectedDays', () => {
  it('is false only for a row with no denominator', () => {
    expect(hasExpectedDays({ expected_days: 5 })).toBe(true)
    expect(hasExpectedDays({ expected_days: 3 })).toBe(true)
    expect(hasExpectedDays({ expected_days: 0 })).toBe(false)
    expect(hasExpectedDays({})).toBe(false)
    expect(hasExpectedDays(null)).toBe(false)
  })
})

describe('attendanceRate', () => {
  it('computes a full rate', () => {
    expect(attendanceRate(5, 'MEDICAL')).toBe(100)
  })
  it('computes a partial rate', () => {
    expect(attendanceRate(2, 'MEDICAL')).toBe(40)
  })
  it('uses the 3-day denominator for OE ESCORTS', () => {
    expect(attendanceRate(3, 'OE ESCORTS')).toBe(100)
    expect(attendanceRate(1, 'OE ESCORTS')).toBe(33)
  })
  it('caps at 100 when present exceeds expected', () => {
    expect(attendanceRate(9, 'MEDICAL')).toBe(100)
  })
  it('returns 0 for zero present', () => {
    expect(attendanceRate(0, 'MEDICAL')).toBe(0)
  })
  it('returns 0 rather than NaN for negative / junk input', () => {
    expect(attendanceRate(-2, 'MEDICAL')).toBe(0)
    expect(attendanceRate(NaN, 'MEDICAL')).toBe(0)
    expect(attendanceRate('2', 'MEDICAL')).toBe(40)
  })
  it('short-circuits on the 0 denominator of an undeployed sewadar', () => {
    // The division-by-zero guard. Days present cannot raise the rate when the
    // sewadar was never expected to attend.
    expect(attendanceRate(3, '')).toBe(0)
    expect(attendanceRate(3, null)).toBe(0)
    expect(attendanceRate(0, '')).toBe(0)
  })
})

describe('rateBand', () => {
  it('bands full attendance', () => {
    expect(rateBand(100)).toBe('full')
    expect(rateBand(120)).toBe('full')
  })
  it('bands partial attendance', () => {
    expect(rateBand(99)).toBe('partial')
    expect(rateBand(50)).toBe('partial')
  })
  it('bands low attendance', () => {
    expect(rateBand(49)).toBe('low')
    expect(rateBand(1)).toBe('low')
  })
  it('bands no attendance', () => {
    expect(rateBand(0)).toBe('none')
    expect(rateBand(-5)).toBe('none')
  })
  it('defaults junk to none', () => {
    expect(rateBand(undefined)).toBe('none')
    expect(rateBand('x')).toBe('none')
  })
})

/* ─── toSewadarRow / buildSewadarRows ─── */
const rawSewadar = {
  badge_number: 'FB5971GA0001',
  sewadar_name: 'RAM',
  sewadar_centre: 'DELHI',
  dept_name: 'MEDICAL',
  is_vss: false,
  days_present: 2,
  total_scans: 2,
  open_sessions: 1,
  first_in_date: '2026-09-23',
  first_in_time: '09:00:00',
  last_out_date: '2026-09-23',
  last_out_time: '18:00:00',
  still_open: true,
  undeployed_scan: false,
}

describe('toSewadarRow', () => {
  it('derives expected days, rate and band from the RPC row', () => {
    const r = toSewadarRow(rawSewadar)
    expect(r.expected_days).toBe(5)
    expect(r.rate).toBe(40)
    expect(r.band).toBe('low')
  })
  it('normalises a VSS row', () => {
    const r = toSewadarRow({ ...rawSewadar, is_vss: true })
    expect(r.is_vss).toBe(true)
  })
  it('tolerates a row with every field missing', () => {
    const r = toSewadarRow({})
    expect(r.badge_number).toBe('')
    expect(r.sewadar_name).toBe('')
    expect(r.days_present).toBe(0)
    expect(r.total_scans).toBe(0)
    expect(r.open_sessions).toBe(0)
    expect(r.still_open).toBe(false)
    expect(r.undeployed_scan).toBe(false)
    expect(r.expected_days).toBe(0)
    expect(hasExpectedDays(r)).toBe(false)
    expect(r.rate).toBe(0)
    expect(r.band).toBe('none')
  })
  it('tolerates a null row without throwing', () => {
    expect(() => toSewadarRow(null)).not.toThrow()
    expect(toSewadarRow(null).badge_number).toBe('')
  })
  it('applies the OE ESCORTS 3-day denominator', () => {
    const r = toSewadarRow({ ...rawSewadar, dept_name: 'OE ESCORTS', days_present: 3 })
    expect(r.expected_days).toBe(3)
    expect(r.rate).toBe(100)
    expect(r.band).toBe('full')
  })
})

describe('buildSewadarRows', () => {
  it('drops rows with no badge', () => {
    const rows = buildSewadarRows([rawSewadar, { sewadar_name: 'GHOST' }, null])
    expect(rows).toHaveLength(1)
  })
  it('sorts by centre, then name, then badge', () => {
    const rows = buildSewadarRows([
      { ...rawSewadar, badge_number: 'B3', sewadar_centre: 'ZED', sewadar_name: 'A' },
      { ...rawSewadar, badge_number: 'B2', sewadar_centre: 'ALFA', sewadar_name: 'B' },
      { ...rawSewadar, badge_number: 'B1', sewadar_centre: 'ALFA', sewadar_name: 'A' },
    ])
    expect(rows.map((r) => `${r.sewadar_centre}/${r.sewadar_name}`)).toEqual([
      'ALFA/A',
      'ALFA/B',
      'ZED/A',
    ])
  })
  it('returns an empty array for non-array input', () => {
    expect(buildSewadarRows(null)).toEqual([])
    expect(buildSewadarRows(undefined)).toEqual([])
    expect(buildSewadarRows('nope')).toEqual([])
  })
  it('returns an empty array for an empty input', () => {
    expect(buildSewadarRows([])).toEqual([])
  })

  /* A1 / C2: the RPC is being changed to return one row per badge, but a badge
     scanned before deployment (sewadar_dept NULL) and again after currently
     arrives as TWO rows. Merging here makes the page correct either way. */
  it('merges two rows for the same badge into ONE row', () => {
    const rows = buildSewadarRows([
      { ...rawSewadar, dept_name: null, days_present: 2, total_scans: 2, open_sessions: 0, undeployed_scan: true },
      { ...rawSewadar, dept_name: 'MEDICAL', days_present: 3, total_scans: 3, open_sessions: 1 },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].badge_number).toBe('FB5971GA0001')
  })
  it('sums the counters and sums days_present across the merged rows', () => {
    const rows = buildSewadarRows([
      { ...rawSewadar, dept_name: null, days_present: 2, total_scans: 2, open_sessions: 0 },
      { ...rawSewadar, dept_name: 'MEDICAL', days_present: 3, total_scans: 3, open_sessions: 1 },
    ])
    expect(rows[0].days_present).toBe(5)
    expect(rows[0].total_scans).toBe(5)
    expect(rows[0].open_sessions).toBe(1)
    // 5/5 once merged, not two half-rows of 2/5 and 3/5
    expect(rows[0].expected_days).toBe(5)
    expect(rows[0].rate).toBe(100)
    expect(rows[0].band).toBe('full')
  })
  it('resolves the department to the first non-null value', () => {
    const rows = buildSewadarRows([
      { ...rawSewadar, dept_name: null },
      { ...rawSewadar, dept_name: 'OE ESCORTS' },
    ])
    expect(rows[0].dept_name).toBe('OE ESCORTS')
    expect(rows[0].expected_days).toBe(3)
  })
  it('keeps the merged row undeployed-flagged if EITHER row scanned undeployed', () => {
    const rows = buildSewadarRows([
      { ...rawSewadar, dept_name: null, undeployed_scan: true },
      { ...rawSewadar, dept_name: 'MEDICAL', undeployed_scan: false },
    ])
    expect(rows[0].undeployed_scan).toBe(true)
  })
  it('ORs the boolean flags', () => {
    const rows = buildSewadarRows([
      { ...rawSewadar, dept_name: null, is_vss: false, still_open: false },
      { ...rawSewadar, dept_name: 'MEDICAL', is_vss: true, still_open: true },
    ])
    expect(rows[0].is_vss).toBe(true)
    expect(rows[0].still_open).toBe(true)
  })
  it('takes the EARLIEST first-in and the LATEST last-out', () => {
    const rows = buildSewadarRows([
      { ...rawSewadar, dept_name: null, first_in_date: '2026-09-25', first_in_time: '14:00:00', last_out_date: '2026-09-25', last_out_time: '15:00:00' },
      { ...rawSewadar, dept_name: 'MEDICAL', first_in_date: '2026-09-23', first_in_time: '09:00:00', last_out_date: '2026-09-26', last_out_time: '20:00:00' },
    ])
    expect(rows[0].first_in_date).toBe('2026-09-23')
    expect(rows[0].first_in_time).toBe('09:00:00')
    expect(rows[0].last_out_date).toBe('2026-09-26')
    expect(rows[0].last_out_time).toBe('20:00:00')
  })
  it('prefers a dated stamp over an undated one in both directions', () => {
    const rows = buildSewadarRows([
      { ...rawSewadar, dept_name: null, first_in_date: null, first_in_time: null, last_out_date: null, last_out_time: null },
      { ...rawSewadar, dept_name: 'MEDICAL', first_in_date: '2026-09-23', first_in_time: '09:00:00', last_out_date: '2026-09-23', last_out_time: '18:00:00' },
    ])
    expect(rows[0].first_in_date).toBe('2026-09-23')
    expect(rows[0].last_out_date).toBe('2026-09-23')
  })
  it('treats absent or junk counters on a merged row as zero', () => {
    // The `|| 0` fallbacks in mergeSewadarRaw: a narrower RPC signature must not
    // produce NaN days_present or a NaN rate.
    const rows = buildSewadarRows([
      { badge_number: 'B1', sewadar_name: 'RAM', sewadar_centre: 'DELHI', dept_name: 'MEDICAL' },
      { badge_number: 'B1', days_present: '2', total_scans: undefined, open_sessions: null },
    ])
    expect(rows).toHaveLength(1)
    expect(Number.isNaN(rows[0].days_present)).toBe(false)
    expect(Number.isNaN(rows[0].total_scans)).toBe(false)
    expect(Number.isNaN(rows[0].open_sessions)).toBe(false)
    expect(rows[0].days_present).toBe(2)
    expect(rows[0].total_scans).toBe(0)
    expect(rows[0].open_sessions).toBe(0)
  })
  it('keeps a name and centre already present on the first row', () => {
    // The other side of `!acc[k] && r[k]`: nothing to overwrite.
    const rows = buildSewadarRows([
      { ...rawSewadar, sewadar_name: 'RAM', sewadar_centre: 'DELHI', dept_name: 'MEDICAL' },
      { ...rawSewadar, sewadar_name: 'OTHER', sewadar_centre: 'ZED', dept_name: 'COOKING' },
    ])
    expect(rows[0].sewadar_name).toBe('RAM')
    expect(rows[0].sewadar_centre).toBe('DELHI')
    expect(rows[0].dept_name).toBe('MEDICAL')
  })
  it('does not merge different badges', () => {
    const rows = buildSewadarRows([
      { ...rawSewadar, badge_number: 'VS001' },
      { ...rawSewadar, badge_number: 'FB5971GA0001' },
    ])
    expect(rows).toHaveLength(2)
  })
  it('does not mutate the caller\'s rows', () => {
    const input = [
      { ...rawSewadar, dept_name: null, days_present: 1 },
      { ...rawSewadar, dept_name: 'MEDICAL', days_present: 2 },
    ]
    buildSewadarRows(input)
    expect(input[0].days_present).toBe(1)
    expect(input[0].dept_name).toBeNull()
  })
})

describe('compareSewadarRows', () => {
  const row = (over) => ({ sewadar_centre: 'A', sewadar_name: 'N', badge_number: 'B', ...over })
  it('orders by centre first', () => {
    expect(compareSewadarRows(row({ sewadar_centre: 'A' }), row({ sewadar_centre: 'B' }))).toBeLessThan(0)
  })
  it('orders by name when centres match', () => {
    expect(compareSewadarRows(row({ sewadar_name: 'A' }), row({ sewadar_name: 'B' }))).toBeLessThan(0)
  })
  it('orders by badge when centre and name match', () => {
    expect(compareSewadarRows(row({ badge_number: 'A' }), row({ badge_number: 'B' }))).toBeLessThan(0)
  })
  it('returns 0 for identical rows', () => {
    expect(compareSewadarRows(row(), row())).toBe(0)
  })
  it('tolerates missing sort keys', () => {
    expect(compareSewadarRows({ sewadar_centre: null, sewadar_name: null, badge_number: null }, { sewadar_centre: 'A', sewadar_name: 'A', badge_number: 'A' })).toBeLessThan(0)
    expect(compareSewadarRows({ sewadar_centre: 'A', sewadar_name: null, badge_number: null }, { sewadar_centre: 'A', sewadar_name: 'A', badge_number: 'A' })).toBeLessThan(0)
    expect(compareSewadarRows({ sewadar_centre: 'A', sewadar_name: 'A', badge_number: null }, { sewadar_centre: 'A', sewadar_name: 'A', badge_number: 'A' })).toBeLessThan(0)
  })
  it('resolves every key through the fallback when one side is entirely empty', () => {
    // Both `|| ''` operands on each of the three keys get exercised when one
    // side is a bare {} and the other is fully populated.
    const empty = {}
    const full = row()
    expect(compareSewadarRows(empty, full)).toBeLessThan(0)
    expect(compareSewadarRows(full, empty)).toBeGreaterThan(0)
    // centres tie, names tie, badges tie -> 0, and both sides take the fallback
    expect(compareSewadarRows({ sewadar_centre: '', sewadar_name: '', badge_number: '' }, { sewadar_centre: '', sewadar_name: '', badge_number: '' })).toBe(0)
  })
})

/* ─── attendanceStats ─── */
describe('attendanceStats', () => {
  it('rolls up centres, open sessions, flags and full attenders', () => {
    const rows = buildSewadarRows([
      { ...rawSewadar, badge_number: 'B1', sewadar_centre: 'DELHI', open_sessions: 1, days_present: 5 },
      { ...rawSewadar, badge_number: 'B2', sewadar_centre: 'DELHI', open_sessions: 0, days_present: 3, undeployed_scan: true },
      { ...rawSewadar, badge_number: 'B3', sewadar_centre: 'FARIDABAB', open_sessions: 0, days_present: 0 },
    ])
    const s = attendanceStats(rows)
    expect(s.sewadars).toBe(3)
    expect(s.centres).toBe(2)
    expect(s.presentToday).toBe(2)
    expect(s.openNow).toBe(1)
    expect(s.flagged).toBe(1)
    expect(s.full).toBe(1)
    expect(s.full5).toBe(1)
  })
  it('returns zeroed stats for an empty list', () => {
    expect(attendanceStats([])).toEqual({ sewadars: 0, centres: 0, presentToday: 0, openNow: 0, flagged: 0, full: 0, full5: 0 })
  })
  it('tolerates non-array input', () => {
    expect(attendanceStats(null).sewadars).toBe(0)
  })
  it('counts a sewadar with no centre as its own Unassigned centre bucket', () => {
    // The centre count goes through centreOptions, so the header always
    // reconciles with the centre dropdown.
    const rows = buildSewadarRows([
      { ...rawSewadar, badge_number: 'B1', sewadar_centre: '' },
      { ...rawSewadar, badge_number: 'B2', sewadar_centre: 'DELHI' },
    ])
    expect(attendanceStats(rows).centres).toBe(2)
    expect(attendanceStats(rows).sewadars).toBe(2)
  })
  it('separates the full-5-day subset from a 3-day full attender (A7)', () => {
    // An OE ESCORTS sewadar at 3/3 is band 'full' but is NOT a full 5-day visit,
    // which is why the card label can no longer say "Full 5-day".
    const rows = buildSewadarRows([
      { ...rawSewadar, badge_number: 'B1', dept_name: 'MEDICAL', days_present: 5 },
      { ...rawSewadar, badge_number: 'B2', dept_name: 'OE ESCORTS', days_present: 3 },
    ])
    const s = attendanceStats(rows)
    expect(s.full).toBe(2)
    expect(s.full5).toBe(1)
  })
})

/* ─── daily rows ─── */
describe('toDailyRow', () => {
  it('computes the present rate', () => {
    const r = toDailyRow({ centre: 'DELHI', dept_name: 'MEDICAL', expected: 4, present: 3, absent: 1, open_now: 2 })
    expect(r.rate).toBe(75)
    expect(r.band).toBe('partial')
    expect(r.open_now).toBe(2)
  })
  it('returns rate 0 when nothing is expected', () => {
    const r = toDailyRow({ centre: 'DELHI', expected: 0, present: 0, absent: 0 })
    expect(r.rate).toBe(0)
    expect(r.band).toBe('none')
  })
  it('tolerates missing fields', () => {
    const r = toDailyRow({})
    expect(r.centre).toBe('')
    expect(r.expected).toBe(0)
    expect(r.absent).toBe(0)
  })
})

describe('buildDailyRows', () => {
  it('drops rows with no centre and sorts centre → dept', () => {
    const rows = buildDailyRows([
      { centre: 'ZED', dept_name: 'B' },
      { centre: 'ALFA', dept_name: 'Z' },
      { centre: 'ALFA', dept_name: 'A' },
      { dept_name: 'GHOST' },
      null,
    ])
    expect(rows.map((r) => `${r.centre}/${r.dept_name}`)).toEqual(['ALFA/A', 'ALFA/Z', 'ZED/B'])
  })
  it('returns an empty array for non-array input', () => {
    expect(buildDailyRows(null)).toEqual([])
  })
})

describe('dailyTotals', () => {
  it('sums every row', () => {
    const rows = buildDailyRows([
      { centre: 'A', dept_name: 'X', expected: 4, present: 3, absent: 1, open_now: 2 },
      { centre: 'A', dept_name: 'Y', expected: 4, present: 4, absent: 0, open_now: 0 },
    ])
    expect(dailyTotals(rows)).toEqual({ expected: 8, present: 7, absent: 1, open_now: 2, rate: 88 })
  })
  it('returns rate 0 when nothing is expected', () => {
    expect(dailyTotals([])).toEqual({ expected: 0, present: 0, absent: 0, open_now: 0, rate: 0 })
  })
  it('tolerates non-array input', () => {
    expect(dailyTotals(null).expected).toBe(0)
  })
})

/* ─── scanner rows ─── */
describe('toScannerRow', () => {
  it('shapes a scanner row', () => {
    const r = toScannerRow({
      scanner_badge: 'SC01', scanner_name: 'Scanner One', scanner_centre: 'DELHI',
      scans_in: 5, scans_out: 4, open_now: 1, manual_scans: 2,
      first_in_time: '08:00:00', last_scan_time: '20:00:00',
    })
    expect(r.scanner_badge).toBe('SC01')
    expect(r.scans_in).toBe(5)
    expect(r.manual_scans).toBe(2)
  })
  it('tolerates missing fields', () => {
    const r = toScannerRow({})
    expect(r.scanner_badge).toBe('')
    expect(r.scans_in).toBe(0)
    expect(r.first_in_time).toBeNull()
  })
})

describe('buildScannerRows', () => {
  it('drops unattributable rows and sorts busiest first', () => {
    const rows = buildScannerRows([
      { scanner_badge: 'SC01', scans_in: 2 },
      { scanner_badge: 'SC02', scans_in: 9 },
      { scanner_badge: '', scans_in: 5 },
      null,
    ])
    expect(rows.map((r) => r.scanner_badge)).toEqual(['SC02', 'SC01'])
  })
  it('breaks a tie by badge', () => {
    const rows = buildScannerRows([
      { scanner_badge: 'SC02', scans_in: 3 },
      { scanner_badge: 'SC01', scans_in: 3 },
    ])
    expect(rows.map((r) => r.scanner_badge)).toEqual(['SC01', 'SC02'])
  })
  it('returns an empty array for non-array input', () => {
    expect(buildScannerRows(null)).toEqual([])
  })
})

/* ─── filtering ─── */
describe('searchRows', () => {
  const rows = buildSewadarRows([
    { ...rawSewadar, badge_number: 'FB5971GA0001', sewadar_name: 'RAM', sewadar_centre: 'DELHI', dept_name: 'MEDICAL' },
    { ...rawSewadar, badge_number: 'VS001', sewadar_name: 'SHAM', sewadar_centre: 'FARIDABAB', dept_name: 'COOKING' },
  ])
  it('returns everything for an empty term', () => {
    expect(searchRows(rows, '')).toHaveLength(2)
    expect(searchRows(rows, '   ')).toHaveLength(2)
    expect(searchRows(rows, null)).toHaveLength(2)
  })
  it('matches badge, name, centre and department', () => {
    expect(searchRows(rows, 'ram')).toHaveLength(1)
    expect(searchRows(rows, 'FB5971')).toHaveLength(1)
    expect(searchRows(rows, 'faridabab')).toHaveLength(1)
    expect(searchRows(rows, 'cooking')).toHaveLength(1)
  })
  it('does not match a near-miss spelling', () => {
    expect(searchRows(rows, 'faridabad')).toEqual([])
  })
  it('is case insensitive', () => {
    expect(searchRows(rows, 'COOKING')).toHaveLength(1)
  })
  it('returns nothing when there is no match', () => {
    expect(searchRows(rows, 'zzz')).toEqual([])
  })
  it('tolerates non-array input', () => {
    expect(searchRows(null, 'x')).toEqual([])
  })
  it('tolerates rows with null searchable fields', () => {
    const rows = [{ badge_number: null, sewadar_name: null, sewadar_centre: null, dept_name: null }]
    expect(searchRows(rows, 'x')).toEqual([])
  })
})

describe('filterByCentre', () => {
  const rows = buildSewadarRows([
    { ...rawSewadar, badge_number: 'B1', sewadar_centre: 'DELHI' },
    { ...rawSewadar, badge_number: 'B2', sewadar_centre: 'FARIDABAB' },
  ])
  it('keeps everything for all / empty', () => {
    expect(filterByCentre(rows, 'all')).toHaveLength(2)
    expect(filterByCentre(rows, '')).toHaveLength(2)
    expect(filterByCentre(rows, null)).toHaveLength(2)
  })
  it('restricts to one centre', () => {
    expect(filterByCentre(rows, 'DELHI')).toHaveLength(1)
  })
  it('reaches the centre-less rows through the Unassigned centre bucket (A14)', () => {
    const mixed = buildSewadarRows([
      { ...rawSewadar, badge_number: 'B1', sewadar_centre: '' },
      { ...rawSewadar, badge_number: 'B2', sewadar_centre: 'DELHI' },
    ])
    expect(filterByCentre(mixed, UNASSIGNED_CENTRE)).toHaveLength(1)
    expect(filterByCentre(mixed, UNASSIGNED_CENTRE)[0].sewadar_centre).toBe('')
    // and the label the dropdown shows is actually in the option list
    expect(centreOptions(mixed)).toContain(UNASSIGNED_CENTRE)
  })
  it('tolerates non-array input', () => {
    expect(filterByCentre(null, 'DELHI')).toEqual([])
    expect(filterByCentre(null, UNASSIGNED_CENTRE)).toEqual([])
  })
  it('tolerates rows with a null centre', () => {
    expect(filterByCentre([{ sewadar_centre: null }], 'DELHI')).toEqual([])
  })
})

describe('filterByDept', () => {
  const rows = buildSewadarRows([
    { ...rawSewadar, badge_number: 'B1', dept_name: 'MEDICAL' },
    { ...rawSewadar, badge_number: 'B2', dept_name: 'COOKING' },
  ])
  it('keeps everything for all / empty', () => {
    expect(filterByDept(rows, 'all')).toHaveLength(2)
    expect(filterByDept(rows, '')).toHaveLength(2)
  })
  it('restricts to one department', () => {
    expect(filterByDept(rows, 'COOKING')).toHaveLength(1)
  })
  it('tolerates non-array input', () => {
    expect(filterByDept(null, 'MEDICAL')).toEqual([])
  })
})

describe('centreOptions / deptOptions', () => {
  it('lists distinct sorted options', () => {
    const rows = buildSewadarRows([
      { ...rawSewadar, badge_number: 'B1', sewadar_centre: 'ZED', dept_name: 'B' },
      { ...rawSewadar, badge_number: 'B2', sewadar_centre: 'ALFA', dept_name: 'A' },
      { ...rawSewadar, badge_number: 'B3', sewadar_centre: 'ALFA', dept_name: 'A' },
    ])
    expect(centreOptions(rows)).toEqual(['ALFA', 'ZED'])
    expect(deptOptions(rows)).toEqual(['A', 'B'])
  })
  it('surfaces centre-less rows as an explicit Unassigned centre bucket (A14)', () => {
    expect(centreOptions([{ sewadar_centre: '' }, { sewadar_centre: 'A' }])).toEqual(['A', UNASSIGNED_CENTRE])
    expect(centreOptions([{ sewadar_centre: null }, { sewadar_centre: 'A' }])).toEqual(['A', UNASSIGNED_CENTRE])
  })
  it('still skips blank departments', () => {
    expect(deptOptions([{ dept_name: '' }])).toEqual([])
    expect(deptOptions([{ dept_name: null }, { dept_name: 'X' }])).toEqual(['X'])
  })
  it('tolerates non-array input', () => {
    expect(centreOptions(null)).toEqual([])
    expect(deptOptions(undefined)).toEqual([])
  })
})

/* ─── constants ─── */
describe('VISIT_DAYS', () => {
  it('is the fixed 5-day WED–SUN visit', () => {
    expect(VISIT_DAYS).toEqual(['WED', 'THU', 'FRI', 'SAT', 'SUN'])
  })
})

describe('FULL_VISIT_DAYS', () => {
  it('is 5 — the non-OE-ESCORTS denominator', () => {
    expect(FULL_VISIT_DAYS).toBe(5)
  })
})

/* ─── v45 report shaping ─── */
describe('buildVisitRows', () => {
  it('normalizes rows and sums totals', () => {
    const { rows, totals } = buildVisitRows([
      { centre: 'DELHI-1', department_id: 'd1', dept_name: 'Traffic', deployed: 10, ever_present: 7, never_present: 3, open_now: 1 },
      { centre: null, department_id: null, dept_name: null, deployed: 2, ever_present: 0, never_present: 2, open_now: 0 },
    ])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ centre: 'DELHI-1', deptName: 'Traffic', deployed: 10, everPresent: 7 })
    expect(rows[1].centre).toBe(UNASSIGNED_CENTRE)
    expect(totals).toEqual({ deployed: 12, everPresent: 7, neverPresent: 5, openNow: 1 })
  })
  it('tolerates null input', () => {
    expect(buildVisitRows(null).totals).toEqual({ deployed: 0, everPresent: 0, neverPresent: 0, openNow: 0 })
  })
})

describe('buildTrendRows', () => {
  it('adds per-day rates, guarding empty days', () => {
    const rows = buildTrendRows([
      { day: '2026-08-05', present: 80, absent: 20 },
      { day: '2026-08-06', present: 0, absent: 0 },
    ])
    expect(rows[0].rate).toBe(80)
    expect(rows[1].rate).toBe(0)
  })
})

describe('anomalyCounts', () => {
  it('counts per rule and passes unknown rules through', () => {
    expect(anomalyCounts([
      { rule: 'STALE_OPEN' }, { rule: 'STALE_OPEN' }, { rule: 'SOMETHING_NEW' }, {},
    ])).toEqual({ STALE_OPEN: 2, SOMETHING_NEW: 1, UNKNOWN: 1 })
  })
})

describe('scannerStatus', () => {
  const NOW = Date.parse('2026-08-06T12:00:00+05:30')
  it('is active within the window', () => {
    expect(scannerStatus('11:50:00', '2026-08-06', NOW)).toBe('active')
  })
  it('is idle for older scans the same date', () => {
    expect(scannerStatus('08:00:00', '2026-08-06', NOW)).toBe('idle')
  })
  it('is offline without a scan time', () => {
    expect(scannerStatus(null, '2026-08-06', NOW)).toBe('offline')
    expect(scannerStatus('garbage', '2026-08-06', NOW)).toBe('offline')
  })
  it('honours a custom window', () => {
    expect(scannerStatus('11:00:00', '2026-08-06', NOW, 120)).toBe('active')
    expect(scannerStatus('11:00:00', '2026-08-06', NOW, 30)).toBe('idle')
  })
})

describe('timeAgo', () => {
  const NOW = 1_757_000_000_000
  it('formats s/m/h/d and floors the future at 0s', () => {
    expect(timeAgo(NOW - 5_000, NOW)).toBe('5s ago')
    expect(timeAgo(NOW - 180_000, NOW)).toBe('3m ago')
    expect(timeAgo(NOW - 3_600_000, NOW)).toBe('1h ago')
    expect(timeAgo(NOW - 3 * 86_400_000, NOW)).toBe('3d ago')
    expect(timeAgo(NOW + 60_000, NOW)).toBe('0s ago')
    expect(timeAgo(NaN, NOW)).toBe('—')
  })
})

/* ─── centre tree (Reports matrix) ─── */
const TREE_CENTRES = [
  { name: 'DELHI', parent_centre: '' },
  { name: 'DELHI-1', parent_centre: 'DELHI' },
  { name: 'DELHI-2', parent_centre: 'DELHI' },
  { name: 'MUMBAI', parent_centre: '' },
]
const TREE_ROWS = [
  { centre: 'DELHI', deptName: 'MEDICAL', deployed: 4, present: 3, absent: 1, openNow: 0 },
  { centre: 'DELHI-1', deptName: 'MEDICAL', deployed: 6, present: 5, absent: 1, openNow: 1 },
  { centre: 'DELHI-1', deptName: 'COOKING', deployed: 2, present: 2, absent: 0, openNow: 0 },
  { centre: 'DELHI-2', deptName: 'MEDICAL', deployed: 3, present: 0, absent: 3, openNow: 0 },
  { centre: 'MUMBAI', deptName: 'MEDICAL', deployed: 5, present: 5, absent: 0, openNow: 0 },
]

describe('rootCentreOf', () => {
  it('walks children to their top-level parent', () => {
    expect(rootCentreOf(TREE_CENTRES, 'DELHI-1')).toBe('DELHI')
    expect(rootCentreOf(TREE_CENTRES, 'DELHI')).toBe('DELHI')
  })
  it('leaves unknown centres and the unassigned bucket as their own roots', () => {
    expect(rootCentreOf(TREE_CENTRES, 'NOWHERE')).toBe('NOWHERE')
    expect(rootCentreOf(TREE_CENTRES, null)).toBe(UNASSIGNED_CENTRE)
    expect(rootCentreOf([], 'DELHI-1')).toBe('DELHI-1')
  })
})

describe('buildCentreTree', () => {
  it('rolls children into the parent aggregate and counts expandable rows', () => {
    const tree = buildCentreTree(TREE_ROWS, TREE_CENTRES)
    expect(tree.map((g) => g.label)).toEqual(['DELHI', 'MUMBAI'])
    const delhi = tree[0]
    expect(delhi.isParent).toBe(true)
    expect(delhi.childCount).toBe(2)
    // Aggregate: parent's own 4 + DELHI-1's 6+2 + DELHI-2's 3 = 15 deployed.
    expect(delhi.total).toMatchObject({ deployed: 15, present: 10, absent: 5, openNow: 1 })
    // Per-dept cells split correctly: MEDICAL 4+6+3, COOKING 2.
    expect(delhi.byDept.get('MEDICAL')).toMatchObject({ deployed: 13, present: 8 })
    expect(delhi.byDept.get('COOKING')).toMatchObject({ deployed: 2, present: 2 })
    // Own vs children.
    expect(delhi.own.label).toBe('DELHI')
    expect(delhi.own.total).toMatchObject({ deployed: 4, present: 3 })
    expect(delhi.children.map((c) => c.label)).toEqual(['DELHI-1', 'DELHI-2'])
    expect(delhi.children[0].total).toMatchObject({ deployed: 8, present: 7 })
    // Aggregate always equals own + children (the split adds up).
    const split = { deployed: 0, present: 0, absent: 0, openNow: 0 }
    for (const m of [delhi.own, ...delhi.children]) {
      split.deployed += m.total.deployed
      split.present += m.total.present
      split.absent += m.total.absent
      split.openNow += m.total.openNow
    }
    expect(split).toEqual(delhi.total)
  })

  it('renders childless and standalone centres as plain rows', () => {
    const tree = buildCentreTree(TREE_ROWS, TREE_CENTRES)
    const mum = tree.find((g) => g.label === 'MUMBAI')
    expect(mum.isParent).toBe(false)
    expect(mum.childCount).toBe(0)
    expect(mum.own.label).toBe('MUMBAI')
  })

  it('keeps unknown centres as standalone groups and degrades flat without a centres list', () => {
    const tree = buildCentreTree(
      [...TREE_ROWS, { centre: 'NOWHERE', deptName: 'MEDICAL', deployed: 1, present: 1, absent: 0, openNow: 0 }],
      TREE_CENTRES
    )
    const ghost = tree.find((g) => g.label === 'NOWHERE')
    expect(ghost.isParent).toBe(false)
    expect(ghost.total.deployed).toBe(1)
    const flat = buildCentreTree(TREE_ROWS, [])
    expect(flat.every((g) => g.isParent === false)).toBe(true)
    expect(flat).toHaveLength(4)
  })
})

describe('filterByCentre with a subtree resolver', () => {
  const rows = [
    { sewadar_centre: 'DELHI' },
    { sewadar_centre: 'DELHI-1' },
    { sewadar_centre: 'MUMBAI' },
  ]
  const rootOf = (n) => rootCentreOf(TREE_CENTRES, n)
  it('matches exact centres without a resolver (unchanged behaviour)', () => {
    expect(filterByCentre(rows, 'DELHI-1')).toHaveLength(1)
  })
  it('matches the whole subtree with a resolver', () => {
    expect(filterByCentre(rows, 'DELHI', rootOf).map((r) => r.sewadar_centre).sort())
      .toEqual(['DELHI', 'DELHI-1'])
  })
})

describe('sparse and empty inputs (robustness + branch coverage)', () => {
  it('buildVisitRows tolerates rows with missing fields', () => {
    const { rows, totals } = buildVisitRows([{}])
    expect(rows[0]).toMatchObject({
      centre: UNASSIGNED_CENTRE, deptName: '—',
      deployed: 0, everPresent: 0, neverPresent: 0, openNow: 0,
    })
    expect(totals).toEqual({ deployed: 0, everPresent: 0, neverPresent: 0, openNow: 0 })
  })
  it('buildTrendRows tolerates null input and missing days', () => {
    expect(buildTrendRows(null)).toEqual([])
    expect(buildTrendRows([{ present: 2, absent: 2 }])[0]).toMatchObject({ day: '', rate: 50 })
  })
  it('anomalyCounts tolerates null input', () => {
    expect(anomalyCounts(null)).toEqual({})
  })
  it('buildCentreTree merges duplicate cells and buckets null centres', () => {
    const tree = buildCentreTree(
      [
        { centre: 'DELHI-1', deptName: 'MEDICAL', deployed: 2, present: 1, absent: 1, openNow: 0 },
        { centre: 'DELHI-1', deptName: 'MEDICAL', deployed: 3, present: 3, absent: 0, openNow: 0 },
        { centre: null, deployed: 1 },
      ],
      TREE_CENTRES
    )
    const delhi = tree.find((g) => g.label === 'DELHI')
    // No DELHI-own rows here: the expanded view shows children only.
    expect(delhi.own).toBeNull()
    expect(delhi.children[0].byDept.get('MEDICAL')).toMatchObject({ deployed: 5, present: 4 })
    expect(tree.find((g) => g.label === UNASSIGNED_CENTRE).total.deployed).toBe(1)
  })
  it('buildCentreTree degrades flat without a centres list', () => {
    const flat = buildCentreTree(TREE_ROWS.slice(0, 1), null)
    expect(flat).toHaveLength(1)
    expect(flat[0].isParent).toBe(false)
    expect(flat[0].total.deployed).toBe(4)
  })
  it('rootCentreOf tolerates a missing centres list', () => {
    expect(rootCentreOf(null, 'DELHI-1')).toBe('DELHI-1')
    expect(rootCentreOf(undefined, null)).toBe(UNASSIGNED_CENTRE)
  })
})
