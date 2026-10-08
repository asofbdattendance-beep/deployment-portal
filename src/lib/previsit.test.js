import { describe, it, expect } from 'vitest'
import {
  previsitDates,
  previsitKpis,
  previsitByDay,
  previsitByDept,
  previsitCentreMatrix,
  previsitPresentSet,
  previsitPresentMap,
  previsitAttention,
  splitPrevisitDay,
  buildPrevisitMatrixRows,
  filterPrevisitTotal,
  previsitTotalExportRows,
  filterPrevisitRows,
  formatPrevisitDuration,
  previsitExportRow,
  previsitExportRows,
  previsitAttentionExportRows,
  previsitAbsentRows,
} from './previsit'

const SUMMARY = [
  { event_date: '2026-10-06', centre: 'A', department_id: 'd1', dept_name: 'MEDICAL', present: 3, open_now: 1 },
  { event_date: '2026-10-06', centre: 'A', department_id: 'd2', dept_name: 'TRAFFIC', present: 2, open_now: 0 },
  { event_date: '2026-10-05', centre: 'B', department_id: 'd1', dept_name: 'MEDICAL', present: 1, open_now: 0 },
  null,
]

// v64 grouped shape: one row per (day, badge) — first IN, last OUT,
// summed minutes (NULL while open), session_count, is_open.
const ROWS = [
  { event_date: '2026-10-06', badge_number: 'B1', sewadar_name: 'Asha', sewadar_centre: 'CENTRE A', department_id: 'd1', dept_name: 'MEDICAL', is_vss: false, in_time: '09:00:00', out_time: '12:00:00', duration_min: 180, is_manual: false, undeployed: false, session_count: 1, is_open: false },
  { event_date: '2026-10-06', badge_number: 'B2', sewadar_name: 'Bina', sewadar_centre: 'CENTRE B', department_id: 'd2', dept_name: 'TRAFFIC', is_vss: false, in_time: '09:05:00', out_time: null, duration_min: null, is_manual: true, undeployed: false, session_count: 1, is_open: true },
  { event_date: '2026-10-05', badge_number: 'B3', sewadar_name: 'Chand', sewadar_centre: 'CENTRE A', department_id: null, dept_name: null, is_vss: true, in_time: '10:00:00', out_time: '11:30:00', duration_min: 90, is_manual: false, undeployed: true, session_count: 2, is_open: false },
]

describe('previsitDates', () => {
  it('lists distinct dates newest first, skipping junk', () => {
    expect(previsitDates(SUMMARY)).toEqual(['2026-10-06', '2026-10-05'])
    expect(previsitDates([])).toEqual([])
    expect(previsitDates(null)).toEqual([])
  })
})

describe('previsitKpis', () => {
  it('folds sewas, present and open', () => {
    expect(previsitKpis(SUMMARY)).toEqual({ sewas: 2, present: 6, openNow: 1 })
  })

  it('is zeroed on empty input', () => {
    expect(previsitKpis([])).toEqual({ sewas: 0, present: 0, openNow: 0 })
  })
})

describe('previsitByDay', () => {
  it('folds one row per sewa day, newest first, with departments', () => {
    expect(previsitByDay(SUMMARY)).toEqual([
      {
        date: '2026-10-06',
        present: 5,
        openNow: 1,
        departments: [
          { id: 'd1', name: 'MEDICAL' },
          { id: 'd2', name: 'TRAFFIC' },
        ],
      },
      {
        date: '2026-10-05',
        present: 1,
        openNow: 0,
        departments: [{ id: 'd1', name: 'MEDICAL' }],
      },
    ])
  })

  it('is empty on empty input', () => {
    expect(previsitByDay([])).toEqual([])
  })
})

describe('previsitByDept', () => {
  it('folds sewas + present per department, bucket last', () => {
    expect(previsitByDept([
      ...SUMMARY,
      { event_date: '2026-10-05', centre: 'B', department_id: null, dept_name: null, present: 2, open_now: 0 },
    ])).toEqual([
      { id: 'd1', name: 'MEDICAL', sewas: 2, present: 4 },
      { id: 'd2', name: 'TRAFFIC', sewas: 1, present: 2 },
      { id: '__none__', name: 'No department', sewas: 1, present: 2 },
    ])
  })
})

describe('previsitPresentSet', () => {
  const DEPLOYED = [
    { badge_number: 'B1', sewadar_name: 'Asha', sewadar_centre: 'CENTRE A', department_id: 'd1', dept_name: 'MEDICAL', is_vss: false },
    { badge_number: 'B2', sewadar_name: 'Bina', sewadar_centre: 'CENTRE B', department_id: 'd1', dept_name: 'MEDICAL', is_vss: false },
    { badge_number: 'B9', sewadar_name: 'Zed', sewadar_centre: 'CENTRE A', department_id: null, dept_name: null, is_vss: false },
  ]

  it('collects each badge scanned on the day exactly once', () => {
    expect([...previsitPresentSet(ROWS, '2026-10-06')].sort()).toEqual(['B1', 'B2'])
    expect([...previsitPresentSet(ROWS, '2026-10-05')]).toEqual(['B3'])
  })

  it('is empty without a valid day', () => {
    expect(previsitPresentSet(ROWS, '').size).toBe(0)
    expect(previsitPresentSet(ROWS, null).size).toBe(0)
    expect(previsitPresentSet(null, '2026-10-06').size).toBe(0)
  })

  describe('filterPrevisitTotal', () => {
    it('filters the deployed list by centre and text, badge included', () => {
      expect(filterPrevisitTotal(DEPLOYED, {}).map((r) => r.badge_number)).toEqual(['B1', 'B2', 'B9'])
      expect(filterPrevisitTotal(DEPLOYED, { centre: 'CENTRE B' }).map((r) => r.badge_number)).toEqual(['B2'])
      expect(filterPrevisitTotal(DEPLOYED, { centre: 'CENTRE A' }).map((r) => r.badge_number)).toEqual(['B1', 'B9'])
      expect(filterPrevisitTotal(DEPLOYED, { query: 'b9' }).map((r) => r.badge_number)).toEqual(['B9'])
      expect(filterPrevisitTotal(DEPLOYED, { query: 'zed' }).map((r) => r.badge_number)).toEqual(['B9'])
      expect(filterPrevisitTotal(DEPLOYED, { query: 'centre b' }).map((r) => r.badge_number)).toEqual(['B2'])
      expect(filterPrevisitTotal(DEPLOYED, { centre: 'NOWHERE', query: 'asha' })).toEqual([])
    })

    it('ignores an unknown centre value only by matching nothing, never by leaking all rows', () => {
      expect(filterPrevisitTotal(DEPLOYED, { centre: 'GHOST' })).toEqual([])
    })

    it('reaches rows with no home centre through UNASSIGNED_CENTRE', () => {
      const withBlank = [...DEPLOYED, { badge_number: 'B7', sewadar_name: 'Dee', sewadar_centre: null, department_id: 'd1', dept_name: 'MEDICAL', is_vss: false }]
      expect(filterPrevisitTotal(withBlank, { centre: 'Unassigned centre' }).map((r) => r.badge_number)).toEqual(['B7'])
      expect(filterPrevisitTotal(withBlank, {}).map((r) => r.badge_number)).toEqual(['B1', 'B2', 'B9', 'B7'])
    })
  })

  describe('previsitTotalExportRows', () => {
    const DAYS = ['2026-10-06', '2026-10-05']

    it('flattens the Total tab with one Present column per sewa day', () => {
      const out = previsitTotalExportRows(DEPLOYED, previsitPresentMap(ROWS), DAYS)
      expect(out).toHaveLength(3)
      expect(out[0]).toMatchObject({
        Badge: 'B1', Name: 'Asha', Centre: 'CENTRE A', Department: 'MEDICAL',
        'Present 2026-10-06': 'Yes', 'Present 2026-10-05': '', VSS: '',
      })
      expect(out[1]['Present 2026-10-06']).toBe('Yes')
      expect(out[2]).toMatchObject({ Badge: 'B9', Department: 'No department', 'Present 2026-10-06': '' })
    })

    it('emits no day columns without sewa days', () => {
      const out = previsitTotalExportRows(DEPLOYED, previsitPresentMap(ROWS), [])
      expect(out[0]).toMatchObject({ Badge: 'B1' })
      expect(Object.keys(out[0]).some((k) => k.startsWith('Present'))).toBe(false)
    })
  })
})

describe('splitPrevisitDay', () => {
  it('splits an ISO date into a short month + day pair', () => {
    expect(splitPrevisitDay('2026-10-02')).toEqual({ mon: 'Oct', num: '2' })
    expect(splitPrevisitDay('2026-01-15')).toEqual({ mon: 'Jan', num: '15' })
  })

  it('falls back to the raw string when unparseable', () => {
    expect(splitPrevisitDay('soon')).toEqual({ mon: '', num: 'soon' })
    expect(splitPrevisitDay(null)).toEqual({ mon: '', num: '' })
  })
})

describe('buildPrevisitMatrixRows', () => {
  const DEPLOYED = [
    { badge_number: 'B1', sewadar_name: 'Asha', sewadar_centre: 'CENTRE A', department_id: 'd1', dept_name: 'MEDICAL', is_vss: false },
    { badge_number: 'B9', sewadar_name: 'Zed', sewadar_centre: 'CENTRE A', department_id: null, dept_name: null, is_vss: false },
  ]

  it('builds one row per badge with a flag per day plus the count', () => {
    const out = buildPrevisitMatrixRows(DEPLOYED, previsitPresentMap(ROWS), ['2026-10-06', '2026-10-05'])
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      badge_number: 'B1', byDate: { '2026-10-06': true, '2026-10-05': false }, presentCount: 1,
    })
    expect(out[1]).toMatchObject({
      badge_number: 'B9', dept_name: 'No department',
      byDate: { '2026-10-06': false, '2026-10-05': false }, presentCount: 0,
    })
  })
})

describe('previsitPresentMap', () => {
  it('maps each badge to its sewa days', () => {
    const m = previsitPresentMap([...ROWS,
      { ...ROWS[0], event_date: '2026-10-05' },
    ])
    expect([...m.get('B1')].sort()).toEqual(['2026-10-05', '2026-10-06'])
    expect([...m.get('B2')]).toEqual(['2026-10-06'])
    expect(m.has('B9')).toBe(false)
  })

  it('is empty on junk input', () => {
    expect(previsitPresentMap(null).size).toBe(0)
    expect(previsitPresentMap([{ badge_number: '', event_date: 'x' }]).size).toBe(0)
  })
})

describe('previsitAttention', () => {
  it('partitions open, undeployed and multi-session rows, newest first', () => {
    const att = previsitAttention(ROWS)
    expect(att.open.map((r) => r.badge_number)).toEqual(['B2'])
    expect(att.undeployed.map((r) => r.badge_number)).toEqual(['B3'])
    expect(att.multi.map((r) => r.badge_number)).toEqual(['B3'])
  })

  it('is empty on empty input', () => {
    expect(previsitAttention([])).toEqual({ open: [], undeployed: [], multi: [] })
  })
})

describe('filterPrevisitRows', () => {
  it('filters by date', () => {
    expect(filterPrevisitRows(ROWS, { date: '2026-10-06' })).toHaveLength(2)
  })

  it('filters by centre, keeping only that centre’s rows', () => {
    expect(filterPrevisitRows(ROWS, { centre: 'CENTRE B' }).map((r) => r.badge_number)).toEqual(['B2'])
    expect(filterPrevisitRows(ROWS, { centre: 'CENTRE A' }).map((r) => r.badge_number)).toEqual(['B1', 'B3'])
    expect(filterPrevisitRows(ROWS, { centre: 'GHOST' })).toEqual([])
  })

  it('keeps every row when no centre is picked', () => {
    expect(filterPrevisitRows(ROWS, {})).toHaveLength(3)
    expect(filterPrevisitRows(ROWS, { centre: 'all' })).toHaveLength(3)
  })

  it('matches badge, name or centre case-insensitively', () => {
    expect(filterPrevisitRows(ROWS, { query: 'b1' }).map((r) => r.badge_number)).toEqual(['B1'])
    expect(filterPrevisitRows(ROWS, { query: 'asha' }).map((r) => r.badge_number)).toEqual(['B1'])
    expect(filterPrevisitRows(ROWS, { query: 'centre b' }).map((r) => r.badge_number)).toEqual(['B2'])
    expect(filterPrevisitRows(ROWS, { query: 'zzz' })).toEqual([])
  })

  it('combines filters', () => {
    expect(filterPrevisitRows(ROWS, { date: '2026-10-06', query: 'bina' }).map((r) => r.badge_number)).toEqual(['B2'])
  })
})

describe('formatPrevisitDuration', () => {
  it('formats minutes compactly', () => {
    expect(formatPrevisitDuration(180)).toBe('3h 00m')
    expect(formatPrevisitDuration(45)).toBe('45m')
    expect(formatPrevisitDuration(0)).toBe('0m')
  })

  it('renders open or missing durations as an em dash', () => {
    expect(formatPrevisitDuration(null)).toBe('—')
    expect(formatPrevisitDuration(undefined)).toBe('—')
    expect(formatPrevisitDuration(-5)).toBe('—')
  })
})

describe('previsitExportRow(s)', () => {
  it('flattens a grouped row for the workbook', () => {
    expect(previsitExportRow(ROWS[0])).toMatchObject({
      Date: '2026-10-06', Badge: 'B1', Name: 'Asha', Centre: 'CENTRE A',
      Department: 'MEDICAL', 'First in': '09:00', 'Last out': '12:00',
      Duration: '3h 00m', Sessions: 1, VSS: '', Manual: '', Undeployed: '', Open: '',
    })
    expect(previsitExportRow(ROWS[1])).toMatchObject({ 'Last out': '', Duration: '—', Manual: 'Yes', Open: 'Yes' })
    expect(previsitExportRow(ROWS[2])).toMatchObject({ Department: '—', VSS: 'Yes', Undeployed: 'Yes', Sessions: 2 })
  })

  it('maps lists of rows', () => {
    expect(previsitExportRows(ROWS)).toHaveLength(3)
    expect(previsitExportRows(null)).toEqual([])
  })
})

describe('previsitAttentionExportRows', () => {
  it('unions the flag lists with a Flag column', () => {
    const out = previsitAttentionExportRows(previsitAttention(ROWS))
    // B2 open + B3 undeployed/multi (one row, two flags).
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ Badge: 'B2', Flag: 'Open' })
    expect(out[1]).toMatchObject({ Badge: 'B3', Flag: 'Undeployed, Multiple sessions' })
  })
})

describe('previsitCentreMatrix', () => {
  const SUMMARY = [
    { event_date: '2026-10-06', centre: 'CENTRE A', present: 2 },
    { event_date: '2026-10-05', centre: 'CENTRE A', present: 1 },
    { event_date: '2026-10-06', centre: 'CENTRE B', present: 1 },
  ]
  const DEPLOYED = [
    { badge_number: 'B1', sewadar_centre: 'CENTRE A' },
    { badge_number: 'B2', sewadar_centre: 'CENTRE A' },
    { badge_number: 'B3', sewadar_centre: 'CENTRE A' },
    { badge_number: 'B4', sewadar_centre: 'CENTRE B' },
  ]

  it('builds one row per centre with a present count per sewa day', () => {
    const m = previsitCentreMatrix(SUMMARY, DEPLOYED)
    expect(m.columns).toEqual(['2026-10-05', '2026-10-06'])
    expect(m.rows.map((r) => r.centre)).toEqual(['CENTRE A', 'CENTRE B'])
    expect(m.rows[0]).toMatchObject({
      centre: 'CENTRE A',
      deployed: 3,
      presentTotal: 3,
      possible: 6,
      byDate: { '2026-10-05': 1, '2026-10-06': 2 },
    })
    expect(m.rows[1]).toMatchObject({
      deployed: 1,
      presentTotal: 1,
      possible: 2,
      byDate: { '2026-10-05': 0, '2026-10-06': 1 },
    })
  })

  it('totals every centre per day and across the visit', () => {
    const m = previsitCentreMatrix(SUMMARY, DEPLOYED)
    expect(m.totals.byDate).toEqual({ '2026-10-05': 1, '2026-10-06': 3 })
    expect(m.totals).toMatchObject({ present: 4, deployed: 4, possible: 8 })
  })

  it('falls back to the busiest day as the denominator when no roster arrives', () => {
    const m = previsitCentreMatrix(SUMMARY, [])
    // CENTRE A peaked at 2 present → 1/2 and 2/2, never p/0.
    expect(m.rows[0].deployed).toBe(2)
    expect(m.rows[0].possible).toBe(4)
    expect(m.rows[0].byDate).toEqual({ '2026-10-05': 1, '2026-10-06': 2 })
  })

  it('keeps a deployed centre that never scanned, with zero cells', () => {
    const m = previsitCentreMatrix([], [{ badge_number: 'B9', sewadar_centre: 'GHOST' }])
    expect(m.columns).toEqual([])
    expect(m.rows[0]).toMatchObject({ centre: 'GHOST', deployed: 1, presentTotal: 0, possible: 0 })
  })

  it('buckets blank centres under UNASSIGNED_CENTRE and sorts them last', () => {
    const m = previsitCentreMatrix([
      { event_date: '2026-10-06', centre: '', present: 1 },
      { event_date: '2026-10-06', centre: '   ', present: 4 },
      { event_date: '2026-10-06', centre: 'ZED', present: 2 },
    ], [])
    expect(m.rows.map((r) => r.centre)).toEqual(['ZED', 'Unassigned centre'])
    expect(m.rows[1].presentTotal).toBe(5)
  })

  it('is empty on junk input', () => {
    expect(previsitCentreMatrix(null, undefined)).toEqual({
      columns: [],
      rows: [],
      totals: { byDate: {}, present: 0, deployed: 0, possible: 0 },
    })
  })
})

describe('previsitAbsentRows', () => {
  const DEPLOYED = [
    { badge_number: 'B1', sewadar_name: 'Asha', sewadar_centre: 'CENTRE A', department_id: 'd1', dept_name: 'MEDICAL', is_vss: false },
    { badge_number: 'B2', sewadar_name: 'Bina', sewadar_centre: 'CENTRE A', department_id: 'd2', dept_name: 'TRAFFIC', is_vss: false },
    { badge_number: 'B3', sewadar_name: 'Chand', sewadar_centre: 'CENTRE A', department_id: null, dept_name: null, is_vss: false },
    { badge_number: 'B4', sewadar_name: 'Dev', sewadar_centre: 'CENTRE B', department_id: 'd1', dept_name: 'MEDICAL', is_vss: false },
  ]
  // B1 scanned 10-06, B2 scanned 10-05, B4 scanned 10-06 (CENTRE B); B3 never.
  const LIVE = [
    { event_date: '2026-10-06', badge_number: 'B1', sewadar_centre: 'CENTRE A' },
    { event_date: '2026-10-05', badge_number: 'B2', sewadar_centre: 'CENTRE A' },
    { event_date: '2026-10-06', badge_number: 'B4', sewadar_centre: 'CENTRE B' },
  ]

  it('single day: absent = deployed minus present on that day', () => {
    const out = previsitAbsentRows({ deployed: DEPLOYED, liveRows: LIVE, effDate: '2026-10-06' })
    expect(out.map((r) => r.badge_number)).toEqual(['B2', 'B3'])
  })

  it('all days: absent = deployed with presentCount === 0', () => {
    const out = previsitAbsentRows({ deployed: DEPLOYED, liveRows: LIVE, effDate: null })
    expect(out.map((r) => r.badge_number)).toEqual(['B3'])
  })

  it('respects the centre filter on both the roster and the day scans', () => {
    const outB = previsitAbsentRows({ deployed: DEPLOYED, liveRows: LIVE, effDate: '2026-10-06', centre: 'CENTRE B' })
    expect(outB.map((r) => r.badge_number)).toEqual([])
    const outA = previsitAbsentRows({ deployed: DEPLOYED, liveRows: LIVE, effDate: '2026-10-06', centre: 'CENTRE A' })
    expect(outA.map((r) => r.badge_number)).toEqual(['B2', 'B3'])
  })

  it('accepts a precomputed presentMap instead of liveRows', () => {
    const out = previsitAbsentRows({ deployed: DEPLOYED, presentMap: previsitPresentMap(LIVE), effDate: '2026-10-05' })
    expect(out.map((r) => r.badge_number)).toEqual(['B1', 'B3', 'B4'])
  })

  it('returns deployed-shaped rows compatible with the export', () => {
    const out = previsitAbsentRows({ deployed: DEPLOYED, liveRows: LIVE, effDate: '2026-10-06' })
    expect(out[0]).toMatchObject({
      badge_number: 'B2', sewadar_name: 'Bina', sewadar_centre: 'CENTRE A', dept_name: 'TRAFFIC',
    })
  })

  it('treats missing scan data as nobody present', () => {
    const out = previsitAbsentRows({ deployed: DEPLOYED, effDate: '2026-10-06' })
    expect(out.map((r) => r.badge_number)).toEqual(['B1', 'B2', 'B3', 'B4'])
  })
})
