// @vitest-environment jsdom
// DashboardPage — smoke coverage for the aso/super_admin landing tab.
//
// This is deliberately a SMOKE test, not a second copy of the AttendancePage
// defect suite. The page is read-only, has no filters to reset and no form
// inputs, so the failure modes worth pinning are narrow and structural:
//
//   1. It renders at all — title, the LIVE freshness pill, and a KPI tile.
//   2. It calls EXACTLY the five v45 RPCs it is contracted to call, and never
//      reads a table directly. Scope is enforced inside the RPCs, so a direct
//      table read here would be both a contract break and a security regression.
//   3. The IST wall-clock round trip actually works: a scanner_ops row whose
//      last_scan_time is "now" in IST must count as ACTIVE. Getting the +05:30
//      combination wrong is silent — the scanner simply reads as offline.
//   4. ONE failed RPC blanks ONE section. A dashboard that refuses to render
//      because a single function is missing is indistinguishable from a broken
//      one, and that is precisely the bug this asserts against.
//
// The mock setup mirrors src/pages/AttendancePage.test.jsx.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, within, fireEvent, act } from '@testing-library/react'
import DashboardPage from './DashboardPage'

const rpc = vi.fn()
const toastError = vi.fn()
const toastSuccess = vi.fn()
const toastWarning = vi.fn()

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
}))

// A STABLE toast object, deliberately — the real useToast() is useMemo'd in
// ToastProvider and a fresh object per render() would re-trigger the page's
// load effect forever and hang every test here for a reason that does not exist
// in production.
const toast = { error: toastError, success: toastSuccess, warning: toastWarning, info: vi.fn() }

vi.mock('../components/Toast', () => ({
  useToast: () => toast,
}))

const SCHEDULES = [{ id: 'sched-1', name: 'October 2026 Visit', status: 'open' }]

// IST is a fixed +05:30 offset with no DST, so shifting by 5.5h gives the exact
// wall clock `todayStrIST()` formats — the same day key AND the same time the
// page will parse `last_scan_time` with.
const istNow = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString()
const TODAY = istNow.slice(0, 10)
const NOW_IST_TIME = istNow.slice(11, 19)

const DAILY = [
  { centre: 'DELHI', department_id: 'd1', dept_name: 'MEDICAL', expected: 10, present: 8, absent: 2, open_now: 1 },
]
const VISIT = [
  { centre: 'DELHI', department_id: 'd1', dept_name: 'MEDICAL', deployed: 12, ever_present: 9, never_present: 3, open_now: 1 },
]
const SCANNER = [
  {
    scanner_badge: 'SC01', scanner_name: 'Scanner One', scanner_centre: 'DELHI',
    scans_in: 5, scans_out: 4, open_now: 1, manual_scans: 0,
    first_in_time: '08:00:00', last_scan_time: NOW_IST_TIME,
  },
]
const TREND = [
  { day: '2026-09-23', present: 8, absent: 2 },
  { day: '2026-09-24', present: 5, absent: 5 },
]

/** Queue one resolved result per RPC, or an error for anything in `fail`. */
function respondWith({ daily = DAILY, visit = VISIT, ops = SCANNER, anomalies = [], trend = TREND, fail = [] } = {}) {
  rpc.mockImplementation((name) => {
    if (fail.includes(name)) return Promise.resolve({ data: null, error: { message: `${name} does not exist`, code: 'PGRST202' } })
    if (name === 'attendance_daily_summary') return Promise.resolve({ data: daily, error: null })
    if (name === 'attendance_visit_summary') return Promise.resolve({ data: visit, error: null })
    if (name === 'attendance_scanner_ops') return Promise.resolve({ data: ops, error: null })
    if (name === 'attendance_anomalies') return Promise.resolve({ data: anomalies, error: null })
    if (name === 'attendance_trend') return Promise.resolve({ data: trend, error: null })
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
  pgHandlers.length = 0
  toastError.mockReset()
  toastSuccess.mockReset()
  toastWarning.mockReset()
  respondWith()
})

// The project does not enable vitest `globals`, so @testing-library/react's
// automatic afterEach cleanup never registers — without this the DOM from every
// previous test would still be mounted and getByText would match twice.
afterEach(() => { cleanup() })

describe('DashboardPage — renders', () => {
  it('shows the title, the LIVE freshness pill and the KPI row', async () => {
    await renderPage()
    expect(screen.getByText('Dashboard')).toBeTruthy()
    // Anchored both ends: the pill's own text is exactly this, while every
    // ancestor's textContent carries the title and buttons as well.
    expect(screen.getByText(/^LIVE · updated \d+s ago$/)).toBeTruthy()
    expect(screen.getByText('Present today')).toBeTruthy()
  })

  it('puts the department-wise table above the centre leaderboard', async () => {
    await renderPage()
    const dept = screen.getByText('Department snapshot')
    const centre = screen.getByText('Centre leaderboard')
    // strict document order: the department block precedes the centre block
    expect(dept.compareDocumentPosition(centre) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // the department block is a real table carrying the visit fixture's row
    const card = dept.closest('.card')
    expect(within(card).getByText('MEDICAL')).toBeTruthy()
    expect(within(card).getAllByRole('row')).toHaveLength(3) // header + MEDICAL + TOTAL
  })

  it('counts a scanner whose last scan is now in IST as active', async () => {
    await renderPage()
    // 1/1 — the +05:30 combination with todayStrIST() has to line up, or the
    // scanner silently reads as offline.
    expect(screen.getByText('1/1')).toBeTruthy()
  })

  it('renders both trend days from attendance_trend', async () => {
    await renderPage()
    // Scoped to the trend card: 80% also appears as the DELHI leaderboard rate
    // (8 of 10 expected), and the two agreeing is the point — asserting the
    // bare string would match both and hide which one broke.
    const trendCard = screen.getByText('5-day trend').closest('.card')
    // buildTrendRows maps 8/10 → 80% and 5/10 → 50%.
    expect(within(trendCard).getByText('80%')).toBeTruthy()
    expect(within(trendCard).getByText('50%')).toBeTruthy()
  })
})

describe('DashboardPage — RPC contract', () => {
  it('calls exactly the five documented RPCs, all against this schedule', async () => {
    await renderPage()
    const names = rpc.mock.calls.map((c) => c[0])
    expect(names.slice().sort()).toEqual([
      'attendance_anomalies',
      'attendance_daily_summary',
      'attendance_scanner_ops',
      'attendance_trend',
      'attendance_visit_summary',
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

describe('DashboardPage — one failed RPC degrades one section', () => {
  it('keeps the page and the other sections live when attendance_visit_summary fails', async () => {
    respondWith({ fail: ['attendance_visit_summary'] })
    await renderPage()

    // The page and the sections that DID load are still on screen.
    expect(screen.getByText('Dashboard')).toBeTruthy()
    expect(screen.getByText('Present today')).toBeTruthy()
    expect(screen.getByText('Centre leaderboard')).toBeTruthy()
    expect(screen.getByText('DELHI')).toBeTruthy()

    // Only the department snapshot is blanked, and it offers its own retry.
    const alerts = screen.getAllByRole('alert')
    expect(alerts).toHaveLength(1)
    expect(alerts[0].textContent).toMatch(/department snapshot/i)
    expect(screen.getByText('Retry')).toBeTruthy()
  })

  it('never shows the raw backend text to the operator', async () => {
    respondWith({ fail: ['attendance_trend'] })
    await renderPage()
    expect(screen.queryByText(/PGRST202/)).toBeNull()
    expect(screen.queryByText(/attendance_trend/)).toBeNull()
    expect(screen.queryByText(/does not exist/)).toBeNull()
  })
})

describe('DashboardPage — a failed section renders "—", never a healthy 0', () => {
  it('dashes the four daily-backed tiles when attendance_daily_summary fails', async () => {
    respondWith({ fail: ['attendance_daily_summary'] })
    await renderPage()
    // "—" says unknown; a 0 here would claim nobody came. Scoped per tile:
    // the em-dash also appears in empty states elsewhere on the page.
    for (const label of ['Present today', 'Attendance %', 'Absent today', 'Open now']) {
      const tile = screen.getByText(label).closest('button')
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
    // 'Anomalies' also heads the feed card below — scope to the KPI row.
    const tile = within(document.querySelector('.stat-row')).getByText('Anomalies').closest('button')
    expect(tile.textContent).toContain('—')
    expect(screen.getByTitle('Anomalies could not be loaded')).toBeTruthy()
  })
})

describe('DashboardPage — freshness accounting', () => {
  it('leaves the LIVE pill un-advanced when all five RPCs fail', async () => {
    respondWith({ fail: ['attendance_daily_summary', 'attendance_visit_summary', 'attendance_scanner_ops', 'attendance_anomalies', 'attendance_trend'] })
    await renderPage()
    // timeAgo(null) is '—': no successful reload ever happened, so the pill
    // must not present a fresh timestamp.
    const pill = screen.getByText(/LIVE · updated —/)
    expect(pill.closest('span').title).toBe('Not loaded yet')
  })

  it('counts failed sources in the LIVE pill tooltip on partial failure', async () => {
    respondWith({ fail: ['attendance_daily_summary', 'attendance_trend'] })
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
      expect(rpc).toHaveBeenCalledTimes(5)
      expect(pgHandlers.length).toBeGreaterThan(0)
      const reload = pgHandlers[0]

      // 500ms after the load: inside the window → trailing 400ms debounce.
      nowSpy.mockImplementation(() => 1_000_500)
      reload()
      await waitFor(() => expect(rpc).toHaveBeenCalledTimes(10))

      // 5s after the last load: past max-wait → immediate, no timer wait.
      nowSpy.mockImplementation(() => 1_010_000)
      reload()
      await waitFor(() => expect(rpc).toHaveBeenCalledTimes(15))
    } finally {
      nowSpy.mockRestore()
    }
  })
})

describe('DashboardPage — a hung RPC degrades its section instead of latching loading', () => {
  it('times out attendance_trend and keeps the other sections live', async () => {
    respondWith()
    const baseImpl = rpc.getMockImplementation()
    rpc.mockImplementation((...args) => (args[0] === 'attendance_trend' ? new Promise(() => {}) : baseImpl(...args)))
    vi.useFakeTimers()
    try {
      render(<DashboardPage schedules={SCHEDULES} scheduleId="sched-1" />)
      // The 15s withTimeout abort is a timer: advance past it and flush.
      await act(async () => { await vi.advanceTimersByTimeAsync(16000) })
      expect(screen.queryByText('Loading dashboard…')).toBeNull()
      expect(screen.getByText('Dashboard')).toBeTruthy()
      expect(screen.getByText('Present today')).toBeTruthy()
      expect(screen.getByText('DELHI')).toBeTruthy()
      const alerts = screen.getAllByRole('alert')
      expect(alerts).toHaveLength(1)
      expect(alerts[0].textContent).toMatch(/5-day trend/i)
    } finally {
      vi.useRealTimers()
    }
  })
})

vi.mock('xlsx', () => ({
  utils: {
    book_new: vi.fn(() => ({})),
    json_to_sheet: vi.fn((rows) => ({ rows })),
    book_append_sheet: vi.fn(),
  },
  writeFile: vi.fn(),
}))

describe('DashboardPage — export snapshot accounting', () => {
  const PRESENT_BADGE = [{ sewadar_centre: 'DELHI', badge_number: 'B1', sewadar_name: 'RAM', is_vss: false, dept_name: 'MEDICAL' }]

  /** The five page-load RPCs succeed; attendance_day_badges answers per mode. */
  function respondBadges({ present = PRESENT_BADGE, absent = [] } = {}) {
    respondWith()
    const base = rpc.getMockImplementation()
    rpc.mockImplementation((name, params) => (
      name === 'attendance_day_badges'
        ? Promise.resolve({ data: params?.p_mode === 'present' ? present : absent, error: null })
        : base(name, params)
    ))
  }

  it('toasts success per written workbook and never warns on a half-success', async () => {
    respondBadges({ present: PRESENT_BADGE, absent: [] })
    await renderPage()
    fireEvent.click(screen.getByText(/Export snapshot/))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Present list exported'))
    expect(toastSuccess).toHaveBeenCalledTimes(1)
    // The absent workbook wrote nothing, but present DID — "nothing exported"
    // would be a lie over a workbook that just downloaded.
    expect(toastWarning).not.toHaveBeenCalled()
  })

  it('warns "nothing exported" only when neither workbook was written', async () => {
    respondBadges({ present: [], absent: [] })
    await renderPage()
    fireEvent.click(screen.getByText(/Export snapshot/))
    await waitFor(() => expect(toastWarning).toHaveBeenCalledWith(expect.stringMatching(/nothing exported/)))
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('toasts both workbooks when both have rows', async () => {
    respondBadges({ present: PRESENT_BADGE, absent: PRESENT_BADGE })
    await renderPage()
    fireEvent.click(screen.getByText(/Export snapshot/))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(2))
    expect(toastWarning).not.toHaveBeenCalled()
  })
})
