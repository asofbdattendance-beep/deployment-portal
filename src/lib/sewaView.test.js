import { describe, it, expect } from 'vitest'
import { SEWA_MODE_VISIT, SEWA_MODE_PREVISIT } from './sewaMode'
import { sewaCentreMatrix, sewaViewDates, buildVisitRows, buildVisitDeployed, applyVisitFlags } from './sewaView'

const WINDOW = ['2026-10-07', '2026-10-08', '2026-10-09']

const VISIT_ROWS = [
  { event_date: '2026-10-07', centre: 'DELHI', present: 2, open_now: 1, deployed: 4 },
  { event_date: '2026-10-07', centre: 'DELHI', present: 1, open_now: 0, deployed: 4 },
  { event_date: '2026-10-08', centre: 'DELHI', present: 0, open_now: 0, deployed: 4 },
  { event_date: '2026-10-07', centre: 'MUMBAI', present: 3, open_now: 0, deployed: 3 },
]

describe('sewaCentreMatrix — visit mode', () => {
  it('uses exactly the window dates as columns, even for dates with no rows', () => {
    const m = sewaCentreMatrix({ mode: SEWA_MODE_VISIT, visitRows: VISIT_ROWS, windowDates: WINDOW })
    expect(m.columns).toEqual(WINDOW)
  })

  it('sums present per centre and day and takes deployed per centre', () => {
    const m = sewaCentreMatrix({ mode: SEWA_MODE_VISIT, visitRows: VISIT_ROWS, windowDates: WINDOW })
    const delhi = m.rows.find((r) => r.centre === 'DELHI')
    expect(delhi.byDate['2026-10-07']).toBe(3)
    expect(delhi.byDate['2026-10-08']).toBe(0)
    expect(delhi.byDate['2026-10-09']).toBe(0)
    expect(delhi.deployed).toBe(4)
    expect(m.totals.byDate['2026-10-07']).toBe(6)
  })

  it('returns empty rows (not fake centres) when the visit feed is empty', () => {
    const m = sewaCentreMatrix({ mode: SEWA_MODE_VISIT, visitRows: [], windowDates: WINDOW })
    expect(m.columns).toEqual(WINDOW)
    expect(m.rows).toEqual([])
  })

  it('folds distinct visit-wide sewadars per centre from the visit summary', () => {
    const summaryRows = [
      { centre: 'DELHI', department_id: 'd1', dept_name: 'MEDICAL', deployed: 4, ever_present: 3, never_present: 1, open_now: 0 },
      { centre: 'MUMBAI', department_id: 'd2', dept_name: 'TRAFFIC', deployed: 3, ever_present: 2, never_present: 1, open_now: 0 },
    ]
    const m = sewaCentreMatrix({ mode: SEWA_MODE_VISIT, visitRows: VISIT_ROWS, windowDates: WINDOW, visitSummaryRows: summaryRows })
    // Same badge on two days counts once here but twice in the day columns.
    expect(m.rows.find((r) => r.centre === 'DELHI')).toMatchObject({ everPresent: 3, everDeployed: 4, presentTotal: 3 })
    expect(m.rows.find((r) => r.centre === 'MUMBAI')).toMatchObject({ everPresent: 2, everDeployed: 3 })
    expect(m.totals).toMatchObject({ everPresent: 5, everDeployed: 7 })
    // The badge-day sums stay untouched beside the new fields.
    expect(m.totals).toMatchObject({ present: 6 })
  })

  it('nulls the ever fields — falling back to badge-day sums — without a summary feed', () => {
    const m = sewaCentreMatrix({ mode: SEWA_MODE_VISIT, visitRows: VISIT_ROWS, windowDates: WINDOW })
    expect(m.rows.find((r) => r.centre === 'DELHI')).toMatchObject({ everPresent: null, everDeployed: null, presentTotal: 3 })
    expect(m.totals).toMatchObject({ everPresent: null, everDeployed: null, present: 6 })
  })
})

describe('sewaCentreMatrix — previsit mode', () => {
  it('matches the previsit matrix contract', () => {
    const summaryRows = [
      { event_date: '2026-10-05', centre: 'DELHI', department_id: 'd1', dept_name: 'MEDICAL', present: 2, open_now: 0 },
    ]
    const deployedRows = [
      { badge_number: 'B1', sewadar_centre: 'DELHI' },
      { badge_number: 'B2', sewadar_centre: 'DELHI' },
    ]
    const m = sewaCentreMatrix({ mode: SEWA_MODE_PREVISIT, summaryRows, deployedRows })
    expect(m.columns).toEqual(['2026-10-05'])
    expect(m.rows[0]).toMatchObject({ centre: 'DELHI', deployed: 2 })
    expect(m.rows[0].byDate['2026-10-05']).toBe(2)
  })
})

const P_BADGE = {
  badge_number: 'B1', sewadar_name: 'RAM', sewadar_centre: 'DELHI',
  department_id: 'd1', dept_name: 'MEDICAL', is_vss: false,
}
const A_BADGE = {
  badge_number: 'B2', sewadar_name: 'SHAM', sewadar_centre: 'FARIDABAD',
  department_id: 'd2', dept_name: 'COOKING', is_vss: false,
}
// [present, absent] per window date, mirroring the hook's fetch shape.
const PAIRS = [
  [[{ ...P_BADGE }], [{ ...A_BADGE }]],
  [[{ ...P_BADGE }, { ...A_BADGE }], []],
]
const DATES = ['2026-10-07', '2026-10-08']

describe('sewaViewDates', () => {
  it('visit: window dates newest-first, ignoring the summary entirely', () => {
    const summary = [{ event_date: '2026-10-01' }, { event_date: '2026-10-08' }]
    expect(sewaViewDates(SEWA_MODE_VISIT, summary, DATES)).toEqual(['2026-10-08', '2026-10-07'])
  })

  it('visit: drops invalid dates and dedupes, never inventing a column', () => {
    expect(sewaViewDates(SEWA_MODE_VISIT, [], ['2026-10-08', '', '2026-10-08', 'nope']))
      .toEqual(['2026-10-08'])
    expect(sewaViewDates(SEWA_MODE_VISIT, [{ event_date: '2026-10-01' }], [])).toEqual([])
  })

  it('previsit: delegates to the summary event dates', () => {
    const summary = [{ event_date: '2026-10-05' }, { event_date: '2026-10-06' }]
    expect(sewaViewDates(SEWA_MODE_PREVISIT, summary, DATES)).toEqual(['2026-10-06', '2026-10-05'])
  })
})

describe('buildVisitRows', () => {
  it('stamps each present badge with its day and register defaults', () => {
    const rows = buildVisitRows(PAIRS, DATES)
    expect(rows).toHaveLength(3)
    for (const r of rows) {
      expect(r.in_time).toBeNull()
      expect(r.out_time).toBeNull()
      expect(r.duration_min).toBeNull()
      expect(r.session_count).toBe(1)
      expect(r.is_open).toBe(false)
      expect(r.undeployed).toBe(false)
      expect(r.is_manual).toBe(false)
    }
    expect(rows.filter((r) => r.event_date === '2026-10-07')).toHaveLength(1)
    expect(rows.filter((r) => r.event_date === '2026-10-08')).toHaveLength(2)
  })

  it('orders newest day first, badge A–Z within a day', () => {
    const rows = buildVisitRows(PAIRS, DATES)
    expect(rows.map((r) => `${r.event_date}|${r.badge_number}`)).toEqual([
      '2026-10-08|B1',
      '2026-10-08|B2',
      '2026-10-07|B1',
    ])
  })
})

describe('buildVisitDeployed', () => {
  it('unions present and absent badges across every window date', () => {
    const dep = buildVisitDeployed(PAIRS)
    expect(dep.map((r) => r.badge_number).sort()).toEqual(['B1', 'B2'])
    expect(dep.find((r) => r.badge_number === 'B2')).toMatchObject({ dept_name: 'COOKING' })
  })

  it('sorts centre A–Z with the unassigned bucket last', () => {
    const pairs = [[[{ ...P_BADGE, sewadar_centre: '' }], [{ ...A_BADGE }]]]
    const dep = buildVisitDeployed(pairs)
    expect(dep.map((r) => r.badge_number)).toEqual(['B2', 'B1'])
  })
})

describe('applyVisitFlags', () => {
  const SUMMARY = [
    {
      badge_number: 'B1', sewadar_name: 'RAM', sewadar_centre: 'DELHI',
      dept_name: 'MEDICAL', is_vss: false, days_present: 2, total_scans: 3,
      open_sessions: 1, first_in_date: '2026-10-07', first_in_time: '09:00:00',
      last_out_date: '2026-10-08', last_out_time: null, still_open: true, undeployed_scan: false,
    },
    {
      badge_number: 'B9', sewadar_name: 'UN', sewadar_centre: 'DELHI',
      dept_name: 'MEDICAL', is_vss: false, days_present: 1, total_scans: 1,
      open_sessions: 0, first_in_date: '2026-10-07', first_in_time: '10:00:00',
      last_out_date: '2026-10-07', last_out_time: '11:00:00', still_open: false, undeployed_scan: true,
    },
  ]

  it('marks the still-open badge on its first-scan day', () => {
    const rows = applyVisitFlags(buildVisitRows(PAIRS, DATES), SUMMARY, '2026-10-08')
    expect(rows.find((r) => r.badge_number === 'B1' && r.event_date === '2026-10-07').is_open).toBe(true)
    expect(rows.find((r) => r.badge_number === 'B1' && r.event_date === '2026-10-08').is_open).toBe(false)
  })

  it('appends a synthetic row for an undeployed badge the day feeds exclude', () => {
    const rows = applyVisitFlags(buildVisitRows(PAIRS, DATES), SUMMARY, '2026-10-08')
    const extra = rows.find((r) => r.badge_number === 'B9')
    expect(extra).toMatchObject({ event_date: '2026-10-07', undeployed: true })
  })

  it('never invents session counts: repeat-scan day grain stays unavailable', () => {
    const rows = applyVisitFlags(buildVisitRows(PAIRS, DATES), SUMMARY, '2026-10-08')
    for (const r of rows) expect(r.session_count).toBe(1)
  })
})
