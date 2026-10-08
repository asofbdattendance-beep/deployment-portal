// @vitest-environment jsdom
// DashboardPage — smoke coverage for the aso/super_admin landing tab.
//
// This is deliberately a SMOKE test, not a second copy of the AttendancePage
// defect suite. The page is read-only, has no filters to reset and no form
// inputs, so the failure modes worth pinning are narrow and structural:
//
//   1. It renders at all — title, the LIVE freshness pill, and a KPI tile.
//   2. It calls EXACTLY the four v45/v61/v74 RPCs it is contracted to call,
//      and never reads a scoped table directly. Scope is enforced inside the
//      RPCs, so a direct scoped-table read here would be both a contract
//      break and a security regression (the centres reference read is
//      unscoped reference data for the matrix rollup and degrades to a
//      flat grid when it fails).
//   3. The IST wall-clock round trip actually works: a scanner_ops row whose
//      last_scan_time is "now" in IST must count as ACTIVE. Getting the +05:30
//      combination wrong is silent — the scanner simply reads as offline.
//   4. ONE failed RPC dashes its tiles. A dashboard that refuses to render
//      because a single function is missing is indistinguishable from a broken
//      one, and that is precisely the bug this asserts against.
//
// THIN LAUNCHER (Phase 4): the page keeps KPI tiles + alerts only — every
// tile navigates to its single-owner detail page. The department snapshot,
// centre × department matrix, leaderboard, scanner feed, trend strip and
// snapshot export were deleted, so this file asserts none of them.
//
// The mock setup mirrors src/pages/AttendancePage.test.jsx.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, within, act } from '@testing-library/react'
import DashboardPage from './DashboardPage'

const rpc = vi.fn()
// Delegates to `rpc` fixtures, upholding the real fetchAllRpc contract:
// a resolved `{ error }` THROWS instead of returning rows.
const fetchAllRpc = vi.fn(async (name, params) => {
  const res = await rpc(name, params)
  if (res?.error) throw res.error
  return Array.isArray(res?.data) ? res.data : []
})
// Reference data for the centre × department matrix parent rollup
// (empty by default = flat grid; rejects only when a test asks for it).
const fetchCentres = vi.fn(async () => [])

// Supabase realtime is inert here: a chainable no-op that satisfies
// channel().on(...).on(...).subscribe() and removeChannel(). Handlers are
// captured so the max-wait tests can fire reloads on demand.
const pgHandlers = []
const noopChannel = () => {
  const ch = {
    on: (event, filter, cb) => { if (typeof cb === 'function') pgHandlers.push(cb); return ch },
    subscribe: () => ch,
    unsubscribe: () => ch,
  }
  return ch
}

vi.mock('../lib/supabase', () => ({
  supabase: {
    rpc: (...args) => rpc(...args),
    channel: () => noopChannel(),
    removeChannel: () => {},
  },
  fetchAllRpc: (...args) => fetchAllRpc(...args),
  fetchCentres: (...args) => fetchCentres(...args),
}))

const SCHEDULES = [{ id: 'sched-1', name: 'October 2026 Visit', status: 'open', visit_start_date: '2026-10-07', visit_end_date: '2026-10-11' }]
// Windowless variant for tests that need the scan day to stay on today
// (e.g. the scanner "active" verdict compares against today IST) — the
// scanner logic itself is window-independent.
const NOWINDOW_SCHEDULES = [{ id: 'sched-1', name: 'October 2026 Visit', status: 'open', visit_start_date: null, visit_end_date: null }]

// IST is a fixed +05:30 offset with no DST, so shifting by 5.5h gives the exact
// wall clock `todayStrIST()` formats — the same day key AND the same time the
// page will parse `last_scan_time` with.
const istNow = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString()
const TODAY = istNow.slice(0, 10)
const NOW_IST_TIME = istNow.slice(11, 19)

const DAILY = [
  { centre: 'DELHI', department_id: 'd1', dept_name: 'MEDICAL', expected: 10, present: 8, absent: 2, open_now: 1 },
]
const SCANNER = [
  {
    scanner_badge: 'SC01', scanner_name: 'Scanner One', scanner_centre: 'DELHI',
    scans_in: 5, scans_out: 4, open_now: 1, manual_scans: 0,
    first_in_time: '08:00:00', last_scan_time: NOW_IST_TIME,
  },
]

const VISIT_DAILY = [
  { event_date: '2026-10-07', centre: 'DELHI', present: 6, open_now: 1, deployed: 10 },
  { event_date: '2026-10-08', centre: 'DELHI', present: 4, open_now: 0, deployed: 10 },
  { event_date: '2026-10-07', centre: 'MUMBAI', present: 3, open_now: 0, deployed: 5 },
]
/** Queue one resolved result per RPC, or an error for anything in `fail`. */
function respondWith({ daily = DAILY, ops = SCANNER, anomalies = [], visitDaily = VISIT_DAILY, fail = [] } = {}) {
  rpc.mockImplementation((name) => {
    if (fail.includes(name)) return Promise.resolve({ data: null, error: { message: `${name} does not exist`, code: 'PGRST202' } })
    if (name === 'attendance_daily_summary') return Promise.resolve({ data: daily, error: null })
    if (name === 'attendance_scanner_ops') return Promise.resolve({ data: ops, error: null })
    if (name === 'attendance_anomalies') return Promise.resolve({ data: anomalies, error: null })
    if (name === 'attendance_centre_daily') return Promise.resolve({ data: visitDaily, error: null })
    return Promise.resolve({ data: [], error: null })
  })
}

/**
 * Render and wait until the loading gate has passed. Content-agnostic on
 * purpose — waiting for a specific string couples the test to the row fixtures.
 */
async function renderPage(props = {}) {
  const utils = render(<DashboardPage schedules={SCHEDULES} scheduleId="sched-1" {...props} />)
  await waitFor(() => expect(screen.queryByText('Loading dashboard…')).toBeNull())
  return utils
}

beforeEach(() => {
  rpc.mockReset()
  fetchCentres.mockReset()
  fetchCentres.mockResolvedValue([])
  pgHandlers.length = 0
  respondWith()
})

// The project does not enable vitest `globals`, so @testing-library/react's
// automatic afterEach cleanup never registers — without this the DOM from every
// previous test would still be mounted and getByText would match twice.
afterEach(() => { cleanup() })

describe('DashboardPage — renders', () => {
  it('shows the title, the LIVE freshness pill and the KPI row', async () => {
    await renderPage()
    expect(screen.getByText('Home')).toBeTruthy()
    // Anchored both ends: the pill's own text is exactly this, while every
    // ancestor's textContent carries the title and buttons as well.
    expect(screen.getByText(/^LIVE · updated \d+s ago$/)).toBeTruthy()
    expect(screen.getByText('Present today')).toBeTruthy()
  })

  it('links every KPI tile out to its owner page', async () => {
    const onNavigate = vi.fn()
    await renderPage({ onNavigate })
    const kpiRow = within(document.querySelector('.stat-row'))
    // Present / % / Absent / Open → Reports; Scanners → Attendance; Anomalies → Anomalies.
    kpiRow.getByText('Present today').closest('button').click()
    kpiRow.getByText('Scanners active').closest('button').click()
    kpiRow.getByText('Anomalies').closest('button').click()
    expect(onNavigate).toHaveBeenNthCalledWith(1, 'reports', undefined)
    expect(onNavigate).toHaveBeenNthCalledWith(2, 'attendance', undefined)
    expect(onNavigate).toHaveBeenNthCalledWith(3, 'anomalies', undefined)
  })

  it('counts a scanner whose last scan is now in IST as active', async () => {
    await renderPage({ schedules: NOWINDOW_SCHEDULES })
    // 1/1 — the +05:30 combination with todayStrIST() has to line up, or the
    // scanner silently reads as offline.
    expect(screen.getByText('1/1')).toBeTruthy()
  })
})

describe('DashboardPage — RPC contract', () => {
  it('calls exactly the four documented RPCs, all against this schedule', async () => {
    await renderPage()
    const names = rpc.mock.calls.map((c) => c[0])
    expect(names.slice().sort()).toEqual([
      'attendance_anomalies',
      'attendance_centre_daily',
      'attendance_daily_summary',
      'attendance_scanner_ops',
    ])
    for (const [, params] of rpc.mock.calls) {
      expect(params.p_schedule).toBe('sched-1')
    }
    // attendance_day_badges is export-only — it must never fire on page load.
    expect(names).not.toContain('attendance_day_badges')
  })

  it('never reaches for a table directly — scope stays server-side', async () => {
    await renderPage()
    expect(rpc.mock.calls.every((c) => c[0].startsWith('attendance_'))).toBe(true)
  })
})

describe('DashboardPage — one failed RPC dashes its tiles', () => {
  it('keeps the page live when a feed fails and never shows raw backend text', async () => {
    respondWith({ fail: ['attendance_anomalies'] })
    await renderPage()
    // The page and the sections that DID load are still on screen.
    expect(screen.getByText('Home')).toBeTruthy()
    expect(screen.getByText('Present today')).toBeTruthy()
    expect(screen.queryByText(/PGRST202/)).toBeNull()
    expect(screen.queryByText(/attendance_anomalies/)).toBeNull()
    expect(screen.queryByText(/does not exist/)).toBeNull()
  })
})

describe('DashboardPage — a failed section renders "—", never a healthy 0', () => {
  it('dashes the four daily-backed tiles when attendance_daily_summary fails', async () => {
    respondWith({ fail: ['attendance_daily_summary'] })
    await renderPage({ schedules: NOWINDOW_SCHEDULES })
    // "—" says unknown; a 0 here would claim nobody came. Scoped to the KPI row.
    const kpiRow = within(document.querySelector('.stat-row'))
    for (const label of ['Present today', 'Attendance %', 'Absent today', 'Open now']) {
      const tile = kpiRow.getByText(label).closest('button')
      expect(tile.textContent).toContain('—')
    }
    expect(screen.getByTitle('Present today could not be loaded')).toBeTruthy()
    // Untouched sections still show numbers: the scanner tile reads 1/1.
    expect(screen.getByText('1/1')).toBeTruthy()
  })

  it('dashes Scanners active when attendance_scanner_ops fails', async () => {
    respondWith({ fail: ['attendance_scanner_ops'] })
    await renderPage()
    const tile = screen.getByText('Scanners active').closest('button')
    expect(tile.textContent).toContain('—')
    expect(screen.queryByText('1/1')).toBeNull()
    // The daily tiles still carry the fixture's numbers (8 present of 10).
    expect(screen.getByText('Present today').closest('button').textContent).toContain('8')
  })

  it('dashes Anomalies when attendance_anomalies fails', async () => {
    respondWith({ fail: ['attendance_anomalies'] })
    await renderPage()
    const tile = within(document.querySelector('.stat-row')).getByText('Anomalies').closest('button')
    expect(tile.textContent).toContain('—')
    expect(screen.getByTitle('Anomalies could not be loaded')).toBeTruthy()
  })
})

describe('DashboardPage — freshness accounting', () => {
  it('leaves the LIVE pill un-advanced when every source fails', async () => {
    respondWith({ fail: ['attendance_daily_summary', 'attendance_scanner_ops', 'attendance_anomalies', 'attendance_centre_daily'] })
    fetchCentres.mockRejectedValueOnce(new Error('dp_centres: boom'))
    await renderPage()
    // timeAgo(null) is '—': no successful reload ever happened, so the pill
    // must not present a fresh timestamp.
    const pill = screen.getByText(/LIVE · updated —/)
    expect(pill.closest('span').title).toBe('Not loaded yet')
  })

  it('counts failed sources in the LIVE pill tooltip on partial failure', async () => {
    respondWith({ fail: ['attendance_daily_summary', 'attendance_anomalies'] })
    await renderPage()
    const pill = screen.getByText(/LIVE · updated \d+s ago/)
    expect(pill.closest('span').title).toMatch(/2 of 5 sources failed/)
  })

  it('reports no failures in the tooltip when everything loaded', async () => {
    await renderPage()
    const pill = screen.getByText(/LIVE · updated \d+s ago/)
    expect(pill.closest('span').title).not.toMatch(/failed/)
  })
})

describe('DashboardPage — realtime max-wait', () => {
  it('debounces a burst but fires immediately past the 2000ms max-wait', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => 1_000_000)
    try {
      await renderPage()
      expect(rpc).toHaveBeenCalledTimes(4)
      expect(pgHandlers.length).toBeGreaterThan(0)
      const reload = pgHandlers[0]

      // 500ms after the load: inside the window → trailing 400ms debounce.
      nowSpy.mockImplementation(() => 1_000_500)
      reload()
      await waitFor(() => expect(rpc).toHaveBeenCalledTimes(8))

      // 5s after the last load: past max-wait → immediate, no timer wait.
      nowSpy.mockImplementation(() => 1_010_000)
      reload()
      await waitFor(() => expect(rpc).toHaveBeenCalledTimes(12))
    } finally {
      nowSpy.mockRestore()
    }
  })
})

describe('DashboardPage — Bhati Visit heatmap', () => {
  it('renders the present-by-day strip and the centre heatmap from attendance_centre_daily', async () => {
    await renderPage()
    expect(screen.getByText('Present by visit day')).toBeTruthy()
    // Day strip carries the fixture's visit-date totals (6 + 3 on 7 Oct).
    expect(screen.getByText(/9 present/)).toBeTruthy()
    // Heatmap caption + a present/deployed cell from the fixture.
    expect(screen.getByText('Present by centre and sewa day')).toBeTruthy()
    expect(screen.getByTitle('6 of 10 present')).toBeTruthy()
    // End totals count DISTINCT sewadars scanned TODAY from the day-mapped
    // feed (DELHI fixture: 8 of 10) — the same unit as the department strip,
    // so the two surfaces agree on today's scope. The DELHI row and the
    // All-centres grand total carry it together.
    expect(screen.getAllByTitle('8 of 10 scanned today')).toHaveLength(2)
  })

  it('drives the department matrix from the same today feed, never the visit summary', async () => {
    await renderPage()
    expect(screen.getByText('Centre × department matrix')).toBeTruthy()
    // Strip header + card sub both say today (DELHI fixture: 8 of 10).
    expect(screen.getByText('1 department · 8 of 10 scanned today')).toBeTruthy()
    expect(screen.getByText(/Today \(.*\): scanned today, per centre and department/)).toBeTruthy()
    // DELHI row Total and the TOTAL row share one title — the same unit as
    // the tiles, so a today tile and a matrix cell stop looking comparable
    // when they are not.
    const matrix = screen.getByTestId('matrix-table')
    expect(within(matrix).getAllByTitle('8 of 10 scanned (today)')).toHaveLength(2)
  })

  it('shows an alert — never fake zeros — when attendance_centre_daily fails', async () => {
    respondWith({ fail: ['attendance_centre_daily'] })
    await renderPage()
    expect(screen.getByRole('alert')).toBeTruthy()
    // The KPI tiles still carry the fixture's numbers (8 present of 10).
    expect(screen.getByText('Present today').closest('button').textContent).toContain('8')
  })

  it('stays empty-worded for Bhati Visit, never previsit, on a windowless schedule', async () => {
    await renderPage({ schedules: NOWINDOW_SCHEDULES })
    expect(screen.queryByText(/previsit/i)).toBeNull()
  })
})

describe('DashboardPage — a hung RPC degrades its tiles instead of latching loading', () => {
  it('times out attendance_scanner_ops and keeps the other tiles live', async () => {
    respondWith()
    const baseImpl = rpc.getMockImplementation()
    rpc.mockImplementation((...args) => (args[0] === 'attendance_scanner_ops' ? new Promise(() => {}) : baseImpl(...args)))
    vi.useFakeTimers()
    try {
      render(<DashboardPage schedules={SCHEDULES} scheduleId="sched-1" />)
      // The 15s withTimeout abort is a timer: advance past it and flush.
      await act(async () => { await vi.advanceTimersByTimeAsync(16000) })
      expect(screen.queryByText('Loading dashboard…')).toBeNull()
      expect(screen.getByText('Home')).toBeTruthy()
      expect(screen.getByText('Present today')).toBeTruthy()
      // The scanner tile dashed; the daily tiles still carry the fixture.
      expect(screen.getByText('Scanners active').closest('button').textContent).toContain('—')
      expect(screen.getByText('Present today').closest('button').textContent).toContain('8')
      // The DAILY fixture has one open session, so exactly one alert fires.
      const alerts = screen.getAllByRole('status')
      expect(alerts).toHaveLength(1)
      expect(alerts[0].textContent).toMatch(/stale open sessions/i)
    } finally {
      vi.useRealTimers()
    }
  })
})
