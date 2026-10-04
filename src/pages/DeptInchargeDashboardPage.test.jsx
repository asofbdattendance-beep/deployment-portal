// @vitest-environment jsdom
// DeptInchargeDashboardPage — smoke coverage for the dept_incharge landing tab (v51).
//
// Deliberately a SMOKE test, not a second copy of the DashboardPage defect
// suite. This page is read-only, has no filters to reset and no form inputs, so
// the failure modes worth pinning are narrow and structural:
//
//   1. It renders at all — title, LIVE pill, the four present/absent tiles.
//   2. It calls EXACTLY the four attendance RPCs it is contracted to call and
//      never reads a table directly. Scope is enforced INSIDE the RPCs (v51
//      department-scope), so a direct table read here would be both a contract
//      break and a security regression.
//   3. The two counts stay distinct: "present today" (daily) must not be
//      conflated with "ever present" (visit).
//   4. ONE failed RPC blanks ONE panel. A dashboard that refuses to render
//      because a single function is missing is indistinguishable from a broken
//      one — that is exactly what this asserts against.
//
// The mock setup mirrors src/pages/DashboardPage.test.jsx.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StrictMode } from 'react'
import { render, screen, waitFor, cleanup, within, fireEvent } from '@testing-library/react'
import DeptInchargeDashboardPage from './DeptInchargeDashboardPage'

const rpc = vi.fn()
// Delegates to `rpc` fixtures, upholding the real fetchAllRpc contract:
// a resolved `{ error }` THROWS instead of returning rows.
const fetchAllRpc = vi.fn(async (name, params) => {
  const res = await rpc(name, params)
  if (res?.error) throw res.error
  return Array.isArray(res?.data) ? res.data : []
})
const toastError = vi.fn()
const toastSuccess = vi.fn()
const toastWarning = vi.fn()

// Supabase realtime is inert here: a chainable no-op that satisfies
// channel().on(...).subscribe() and removeChannel().
const noopChannel = () => {
  const ch = { on: () => ch, subscribe: () => ch, unsubscribe: () => ch }
  return ch
}

vi.mock('../lib/supabase', () => ({
  supabase: {
    rpc: (...args) => rpc(...args),
    channel: () => noopChannel(),
    removeChannel: () => {},
  },
  fetchAllRpc: (...args) => fetchAllRpc(...args),
}))

// A STABLE toast object — a fresh object per render() would re-trigger the
// page's load effect forever and hang every test for a reason that does not
// exist in production.
const toast = { error: toastError, success: toastSuccess, warning: toastWarning, info: vi.fn() }

vi.mock('../components/Toast', () => ({
  useToast: () => toast,
}))

const exportAttendanceWorkbook = vi.fn()

vi.mock('../lib/attendanceExcel', () => ({
  exportAttendanceWorkbook: (...args) => exportAttendanceWorkbook(...args),
}))

const SCHEDULES = [{ id: 'sched-1', name: 'October 2026 Visit', status: 'open', visit_start_date: '2026-10-07', visit_end_date: '2026-10-11' }]

// Two centres for the SAME department — the v51 promise. If the page were still
// centre-scoped, only the DELHI row would come back and these fixtures would
// never both be seen.
const DAILY = [
  { centre: 'DELHI', department_id: 'd1', dept_name: 'MEDICAL', expected: 10, present: 8, absent: 2, open_now: 1 },
  { centre: 'NOIDA', department_id: 'd1', dept_name: 'MEDICAL', expected: 6, present: 4, absent: 2, open_now: 0 },
]
const VISIT = [
  { centre: 'DELHI', department_id: 'd1', dept_name: 'MEDICAL', deployed: 16, ever_present: 15, never_present: 1, open_now: 1 },
]
// Matrix arms. TREND days sit inside the confirmed visit window so the
// columns stay exactly the 5 known dates; PRESENT/ABSENT list badges per date
// (shaped exactly as attendance_day_badges returns). B1 scans day one only,
// B2 never scans, B3 is deployed-never-scanned (absent all 5 dates, present
// none), and B4 is the centre-mismatch badge (present-arm centre 'X',
// absent-arm centre 'DELHI').
const TREND = [
  { day: '2026-10-07', present: 2, absent: 2 },
  { day: '2026-10-08', present: 0, absent: 4 },
]
const arm = (badge_number, sewadar_name, sewadar_centre, dept_name = 'MEDICAL', is_vss = false) => ({
  badge_number, sewadar_name, sewadar_centre, dept_name, is_vss,
})
const PRESENT = {
  '2026-10-07': [arm('B1', 'Amit', 'DELHI'), arm('B4', 'Diya-Present', 'X', 'Wrong-Dept')],
  '2026-10-08': [],
  '2026-10-09': [],
  '2026-10-10': [],
  '2026-10-11': [],
}
const ABSENT = {
  '2026-10-07': [arm('B2', 'Bina', 'NOIDA'), arm('B3', 'Chet', 'DELHI')],
  '2026-10-08': [arm('B1', 'Amit', 'DELHI'), arm('B2', 'Bina', 'NOIDA'), arm('B3', 'Chet', 'DELHI'), arm('B4', 'Diya', 'DELHI')],
  '2026-10-09': [arm('B1', 'Amit', 'DELHI'), arm('B2', 'Bina', 'NOIDA'), arm('B3', 'Chet', 'DELHI'), arm('B4', 'Diya', 'DELHI')],
  '2026-10-10': [arm('B1', 'Amit', 'DELHI'), arm('B2', 'Bina', 'NOIDA'), arm('B3', 'Chet', 'DELHI'), arm('B4', 'Diya', 'DELHI')],
  '2026-10-11': [arm('B1', 'Amit', 'DELHI'), arm('B2', 'Bina', 'NOIDA'), arm('B3', 'Chet', 'DELHI'), arm('B4', 'Diya', 'DELHI')],
}

/** Queue one resolved result per RPC, or an error for anything in `fail`. */
function respondWith({ daily = DAILY, visit = VISIT, trend = TREND, present = PRESENT, absent = ABSENT, fail = [] } = {}) {
  rpc.mockImplementation((name, params) => {
    if (fail.includes(name)) return Promise.resolve({ data: null, error: { message: `${name} does not exist`, code: 'PGRST202' } })
    if (name === 'attendance_daily_summary') return Promise.resolve({ data: daily, error: null })
    if (name === 'attendance_visit_summary') return Promise.resolve({ data: visit, error: null })
    if (name === 'attendance_trend') return Promise.resolve({ data: trend, error: null })
    if (name === 'attendance_day_badges') {
      const map = params?.p_mode === 'absent' ? absent : present
      return Promise.resolve({ data: map[params?.p_date] || [], error: null })
    }
    return Promise.resolve({ data: [], error: null })
  })
}

/** Render and wait until the loading gate has passed. */
async function renderPage(props = {}) {
  const utils = render(<DeptInchargeDashboardPage schedules={SCHEDULES} scheduleId="sched-1" {...props} />)
  await waitFor(() => expect(screen.queryByText(/Loading your department dashboard/)).toBeNull())
  return utils
}

// The KPI tiles and the per-department breakdown share the same words
// ("Present today", a bare "4"), so numeric assertions are SCOPED to a tile
// row rather than the whole document — otherwise they match the table too and
// the test fails for a reason that has nothing to do with the page.
const kpiRow = (n = 0) => within(document.querySelectorAll('.stat-row')[n])

beforeEach(() => {
  rpc.mockReset()
  toastError.mockReset()
  toastSuccess.mockReset()
  toastWarning.mockReset()
  exportAttendanceWorkbook.mockReset()
  exportAttendanceWorkbook.mockResolvedValue(3)
  respondWith()
})

// The project does not enable vitest `globals`, so @testing-library/react's
// automatic afterEach cleanup never registers — without this the DOM from every
// previous test would still be mounted and getByText would match twice.
afterEach(() => { cleanup() })

describe('DeptInchargeDashboardPage — renders', () => {
  it('shows the title, the LIVE pill and the present/absent tiles', async () => {
    await renderPage()
    expect(screen.getByText('Dashboard')).toBeTruthy()
    expect(screen.getByText(/LIVE/)).toBeTruthy()
    expect(kpiRow(0).getByText('Total deployed')).toBeTruthy()
    expect(kpiRow(0).getByText('Present today')).toBeTruthy()
    expect(kpiRow(0).getByText('Absent today')).toBeTruthy()
  })

  it('sums the department across every centre (v51 is not centre-scoped)', async () => {
    await renderPage()
    // 10 + 6 deployed, 8 + 4 present, 2 + 2 absent
    expect(kpiRow(0).getByText('16')).toBeTruthy()
    expect(kpiRow(0).getByText('12')).toBeTruthy()
    expect(kpiRow(0).getByText('4')).toBeTruthy()
  })

  it('keeps "present today" separate from "ever present (visit)"', async () => {
    await renderPage()
    expect(kpiRow(0).getByText('Present today')).toBeTruthy()
    // visit ever-present is 15, distinct from today's 12
    expect(kpiRow(1).getByText('Ever present (visit)')).toBeTruthy()
    expect(kpiRow(1).getByText('15')).toBeTruthy()
  })
})

describe('DeptInchargeDashboardPage — attendance matrix', () => {
  it('renders the Badge × day grid instead of the old By department table', async () => {
    await renderPage()
    expect(screen.queryByText('By department')).toBeNull()
    expect(screen.getByText('Attendance matrix')).toBeTruthy()
    expect(screen.getByText(/Badge × day/)).toBeTruthy()
    // All four fixture sewadars render as rows — including the never-scanned B3.
    expect(screen.getByText('B1')).toBeTruthy()
    expect(screen.getByText('B2')).toBeTruthy()
    expect(screen.getByText('B3')).toBeTruthy()
    expect(screen.getByText('B4')).toBeTruthy()
  })

  it('marks present badges green and the rest red (P/A cells)', async () => {
    await renderPage()
    // AttendanceMatrix paints green/red cells with sr-only Present/Absent
    // labels — 4 rows × 5 confirmed dates = 20 cells; B1 and B4 scan day one.
    expect(document.querySelectorAll('td[title="Present"]').length).toBe(2)
    expect(document.querySelectorAll('td[title="Absent"]').length).toBe(18)
  })

  it('lists the deployed-never-scanned badge as a 5-red-cell row', async () => {
    await renderPage()
    // B3 is absent all 5 dates and present on none — the H1 regression read
    // this sewadar as missing entirely because the matrix was built from the
    // scanned-only summary instead of the day-badge lists.
    const b3row = [...document.querySelectorAll('tbody tr')].find((tr) => tr.textContent.includes('B3'))
    expect(b3row).toBeTruthy()
    expect(b3row.querySelectorAll('td[title="Absent"]').length).toBe(5)
    expect(b3row.querySelectorAll('td[title="Present"]').length).toBe(0)
  })

  it('keys presence by badge only — the centre-mismatch badge still reads green', async () => {
    await renderPage()
    // B4's present-arm row says centre 'X' while its absent-arm rows say
    // 'DELHI'. A centre-embedding key would paint it red; the badge-only key
    // reads green, and display fields prefer the absent (deployment-truth) arm.
    const b4row = [...document.querySelectorAll('tbody tr')].find((tr) => tr.textContent.includes('B4'))
    expect(b4row).toBeTruthy()
    expect(b4row.querySelectorAll('td[title="Present"]').length).toBe(1)
    expect(b4row.textContent).toContain('Diya')
    expect(b4row.textContent).toContain('DELHI')
    expect(b4row.textContent).not.toContain('X')
  })

  it('keeps the tiles live while the matrix arms load', async () => {
    await renderPage()
    expect(kpiRow(0).getByText('16')).toBeTruthy()
    expect(kpiRow(1).getByText('15')).toBeTruthy()
    expect(screen.getByText('Attendance matrix')).toBeTruthy()
  })

  // The tiles query the operator-picked scan day, so the subs name it
  // instead of hardcoding "today".
  it('names the selected scan day in the today subs', async () => {
    await renderPage()
    expect(kpiRow(0).getAllByText(/\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/).length).toBeGreaterThan(0)
  })
})

describe('DeptInchargeDashboardPage — visit window is the only column source', () => {
  const NOWINDOW_SCHEDULES = [{ id: 'sched-1', name: 'October 2026 Visit', status: 'open', visit_start_date: null, visit_end_date: null }]

  it('shows exactly the 5 window dates when the trend carries a previsit day', async () => {
    // The reported bug: a manual Oct 2 entry grew an Oct 2 column in
    // Bhati Visit. The window is the only source of columns now.
    respondWith({ trend: [...TREND, { day: '2026-10-02', present: 1, absent: 9 }] })
    await renderPage()
    const headers = [...document.querySelectorAll('th.att-day')].map((th) => th.getAttribute('title'))
    expect(headers).toEqual(['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'])
    expect(document.querySelector('th[title="2026-10-02"]')).toBeNull()
    // And the badge fan-out never asks for the previsit date either.
    const badgeDates = new Set(rpc.mock.calls.filter((c) => c[0] === 'attendance_day_badges').map(([, params]) => params.p_date))
    expect([...badgeDates].sort()).toEqual(['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'])
    // …and the fan-out runs through the paginating helper (complete matrix).
    expect(fetchAllRpc.mock.calls.map(([n]) => n)).toContain('attendance_day_badges')
  })

  it('shows a no-window notice and fetches no badge lists without a window', async () => {
    await renderPage({ schedules: NOWINDOW_SCHEDULES, scheduleId: 'sched-1' })
    expect(screen.getByText(/No visit dates are set for this schedule/)).toBeTruthy()
    expect(screen.queryByText('Attendance matrix')).toBeNull()
    expect(rpc.mock.calls.filter((c) => c[0] === 'attendance_day_badges')).toHaveLength(0)
    // The tiles still render — only the visit grid is withheld.
    expect(kpiRow(0).getByText('Present today')).toBeTruthy()
  })
})

describe('DeptInchargeDashboardPage — RPC contract', () => {
  it('calls the four scope-resolved RPCs and never a table directly', async () => {
    await renderPage()
    const names = rpc.mock.calls.map((c) => c[0])
    expect(new Set(names)).toEqual(new Set(['attendance_daily_summary', 'attendance_visit_summary', 'attendance_trend', 'attendance_day_badges']))
    expect(names.every((n) => n.startsWith('attendance_'))).toBe(true)
  })

  it('passes the selected schedule and scan day through', async () => {
    await renderPage()
    const dailyCall = rpc.mock.calls.find((c) => c[0] === 'attendance_daily_summary')
    expect(dailyCall[1].p_schedule).toBe('sched-1')
    expect(dailyCall[1].p_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('queries present AND absent badges once per visit column per mode', async () => {
    await renderPage()
    const badgeCalls = rpc.mock.calls.filter((c) => c[0] === 'attendance_day_badges')
    // Trend days sit inside the confirmed window, so two calls per confirmed
    // date (present + absent) — never zero, never per sewadar.
    expect(badgeCalls.length).toBe(10)
    const modes = badgeCalls.map(([, params]) => params.p_mode).sort()
    expect(modes.filter((m) => m === 'present')).toHaveLength(5)
    expect(modes.filter((m) => m === 'absent')).toHaveLength(5)
    for (const [, params] of badgeCalls) {
      expect(params.p_schedule).toBe('sched-1')
      expect(['present', 'absent']).toContain(params.p_mode)
      expect(params.p_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
})

describe('DeptInchargeDashboardPage — one failed RPC degrades one panel', () => {
  it('keeps the page and the visit tiles live when attendance_daily_summary fails', async () => {
    respondWith({ fail: ['attendance_daily_summary'] })
    await renderPage()
    expect(screen.getByText('Dashboard')).toBeTruthy()
    expect(screen.getByText(/Today’s attendance unavailable|Today's attendance unavailable/)).toBeTruthy()
    // visit panel still rendered
    expect(screen.getByText('Ever present (visit)')).toBeTruthy()
  })

  it('keeps the page and the today tiles live when attendance_visit_summary fails', async () => {
    respondWith({ fail: ['attendance_visit_summary'] })
    await renderPage()
    expect(screen.getByText('Dashboard')).toBeTruthy()
    expect(kpiRow(0).getByText('Present today')).toBeTruthy()
    expect(screen.getByText(/Whole-visit attendance unavailable/)).toBeTruthy()
  })

  it('blanks only the matrix when attendance_trend fails', async () => {
    respondWith({ fail: ['attendance_trend'] })
    await renderPage()
    expect(screen.queryByText('Attendance matrix')).toBeNull()
    expect(screen.getByText(/Attendance matrix \(trend\) unavailable/)).toBeTruthy()
    expect(kpiRow(0).getByText('Present today')).toBeTruthy()
  })

  it('blanks only the matrix when attendance_day_badges fails', async () => {
    respondWith({ fail: ['attendance_day_badges'] })
    await renderPage()
    expect(screen.queryByText('Attendance matrix')).toBeNull()
    expect(screen.getByText(/Attendance matrix \(daily presence\) unavailable/)).toBeTruthy()
    expect(kpiRow(0).getByText('Present today')).toBeTruthy()
  })
})

describe('DeptInchargeDashboardPage — no department assigned', () => {
  it('shows the "no department assigned" notice instead of misleading zero tiles', async () => {
    respondWith({ daily: [], visit: [] })
    await renderPage()
    expect(screen.getByText(/No department is assigned to this login/)).toBeTruthy()
  })
})

describe('DeptInchargeDashboardPage — StrictMode (the v51 regression)', () => {  // main.jsx wraps the app in <React.StrictMode>, which double-invokes
  // effects in dev: setup → cleanup → setup. A cleanup-only mount flag is
  // left false by the first cleanup and never restored, so `load()` bailed at
  // its `!mountedRef.current` guard BEFORE `setLoading(false)` and the page
  // spun forever on "Loading your department dashboard…".
  //
  // Every other test in this file renders WITHOUT StrictMode, which is exactly
  // why this shipped green. Rendering under StrictMode is the only way to
  // catch that whole class of bug.
  it('still loads when effects are double-invoked by StrictMode', async () => {
    const utils = render(
      <StrictMode>
        <DeptInchargeDashboardPage schedules={SCHEDULES} scheduleId="sched-1" />
      </StrictMode>
    )
    await waitFor(() => expect(screen.queryByText(/Loading your department dashboard/)).toBeNull())
    expect(kpiRow(0).getByText('Total deployed')).toBeTruthy()
    expect(kpiRow(0).getByText('16')).toBeTruthy()
    utils.unmount()
  })
})

describe('DeptInchargeDashboardPage — date currency (tiles never shown under the wrong day)', () => {
  it('shows the loading state instead of stale tiles while a new scan day loads', async () => {
    await renderPage()
    expect(kpiRow(0).getByText('16')).toBeTruthy()
    // Gate every RPC behind a deferred: the new day is loading, the old tiles
    // must already be gone.
    let release
    const gate = new Promise((res) => { release = res })
    rpc.mockImplementation(() => gate)
    fireEvent.change(document.querySelector('input[type="date"]'), { target: { value: '2026-09-24' } })
    await waitFor(() => expect(screen.queryByText(/Loading your department dashboard/)).toBeTruthy())
    expect(screen.queryByText('Ever present (visit)')).toBeNull()
    // Drain so no dangling promise outlives the test.
    release({ data: [], error: null })
    await waitFor(() => expect(screen.queryByText(/Loading your department dashboard/)).toBeNull())
  })
})

describe('DeptInchargeDashboardPage — noScope requires both arms', () => {
  it('never blames the login when the visit RPC failed', async () => {
    // Daily answered (empty), visit errored: the old check read two empty
    // arrays as "no department assigned" instead of an outage.
    respondWith({ daily: [], fail: ['attendance_visit_summary'] })
    await renderPage()
    expect(screen.queryByText(/No department is assigned to this login/)).toBeNull()
    expect(screen.getByText(/Whole-visit attendance unavailable/)).toBeTruthy()
  })

  it('never blames the login when the daily RPC failed', async () => {
    respondWith({ visit: [], fail: ['attendance_daily_summary'] })
    await renderPage()
    expect(screen.queryByText(/No department is assigned to this login/)).toBeNull()
    expect(screen.getByText(/Today’s attendance unavailable|Today's attendance unavailable/)).toBeTruthy()
  })
})

describe('DeptInchargeDashboardPage — LIVE pill clock', () => {
  it('installs a 60s tick so the updated-ago pill advances without an RPC', async () => {
    const spy = vi.spyOn(globalThis, 'setInterval')
    await renderPage()
    expect(spy).toHaveBeenCalledWith(expect.any(Function), 60000)
    spy.mockRestore()
  })

  it('renders the pill off the tick clock', async () => {
    await renderPage()
    expect(screen.getByText(/LIVE.*updated \ds ago/)).toBeTruthy()
  })
})

describe('DeptInchargeDashboardPage — export needs every arm', () => {
  it('labels the button Export Attd Matrix', async () => {
    await renderPage()
    expect(screen.getByRole('button', { name: /Export Attd Matrix/i })).toBeTruthy()
    expect(screen.queryByText('By department')).toBeNull()
  })

  it('disables Export Attd Matrix when one arm failed', async () => {
    respondWith({ fail: ['attendance_visit_summary'] })
    await renderPage()
    expect(screen.getByRole('button', { name: /Export Attd Matrix/i }).disabled).toBe(true)
  })

  it('disables Export Attd Matrix when a matrix arm failed', async () => {
    respondWith({ fail: ['attendance_day_badges'] })
    await renderPage()
    expect(screen.getByRole('button', { name: /Export Attd Matrix/i }).disabled).toBe(true)
  })

  it('enables Export Attd Matrix when all arms landed', async () => {
    await renderPage()
    expect(screen.getByRole('button', { name: /Export Attd Matrix/i }).disabled).toBe(false)
  })

  it('hands the styled exporter the schedule, kpis and matrix on click', async () => {
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: /Export Attd Matrix/i }))
    await waitFor(() => expect(exportAttendanceWorkbook).toHaveBeenCalledTimes(1))
    const [{ filename, scheduleName, date, kpis, matrix }] = exportAttendanceWorkbook.mock.calls[0]
    expect(filename).toMatch(/^October_2026_Visit_incharge_\d{4}-\d{2}-\d{2}\.xlsx$/)
    expect(scheduleName).toBe('October 2026 Visit')
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(kpis.today.deployed).toBe(16)
    // All four fixture sewadars over the 5 confirmed dates.
    expect(matrix.rows).toHaveLength(4)
    expect(matrix.columns).toHaveLength(5)
  })

  it('exports exactly the filtered rows', async () => {
    await renderPage()
    fireEvent.change(screen.getByLabelText('Filter matrix by centre'), { target: { value: 'NOIDA' } })
    fireEvent.click(screen.getByRole('button', { name: /Export Attd Matrix/i }))
    await waitFor(() => expect(exportAttendanceWorkbook).toHaveBeenCalledTimes(1))
    const [{ matrix }] = exportAttendanceWorkbook.mock.calls[0]
    expect(matrix.rows.map((r) => r.badge_number)).toEqual(['B2'])
  })

  it('toasts instead of downloading when the styled export writes nothing', async () => {
    exportAttendanceWorkbook.mockResolvedValueOnce(0)
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: /Export Attd Matrix/i }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Nothing to export for this schedule yet'))
  })

  it('toasts the failure when the styled export throws', async () => {
    exportAttendanceWorkbook.mockRejectedValueOnce(new Error('boom'))
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: /Export Attd Matrix/i }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('boom'))
  })
})

describe('DeptInchargeDashboardPage — matrix search and centre filter', () => {
  it('lists every centre in the filter with a full count by default', async () => {
    await renderPage()
    const select = screen.getByLabelText('Filter matrix by centre')
    expect(select.textContent).toContain('All centres (2)')
    expect(select.textContent).toContain('DELHI')
    expect(select.textContent).toContain('NOIDA')
    expect(screen.getByText('4 of 4 sewadars')).toBeTruthy()
  })

  it('narrows the grid by badge, name, centre or dept text', async () => {
    await renderPage()
    fireEvent.change(screen.getByLabelText('Search attendance matrix'), { target: { value: 'bina' } })
    expect(screen.getByText('B2')).toBeTruthy()
    expect(screen.queryByText('B1')).toBeNull()
    expect(screen.queryByText('B3')).toBeNull()
    expect(screen.queryByText('B4')).toBeNull()
    expect(screen.getByText('1 of 4 sewadars')).toBeTruthy()
  })

  it('matches the centre and dept columns too, case-insensitively', async () => {
    await renderPage()
    fireEvent.change(screen.getByLabelText('Search attendance matrix'), { target: { value: 'noida' } })
    expect(screen.getByText('B2')).toBeTruthy()
    expect(screen.queryByText('B1')).toBeNull()
  })

  it('filters to one centre and explains an empty result', async () => {
    await renderPage()
    fireEvent.change(screen.getByLabelText('Filter matrix by centre'), { target: { value: 'NOIDA' } })
    expect(screen.getByText('B2')).toBeTruthy()
    expect(screen.queryByText('B1')).toBeNull()
    expect(screen.getByText('1 of 4 sewadars')).toBeTruthy()
    // Search inside the centre filter: nothing matches, with guidance.
    fireEvent.change(screen.getByLabelText('Search attendance matrix'), { target: { value: 'zzz' } })
    expect(screen.getByText('No sewadars match this search or filter.')).toBeTruthy()
    expect(screen.queryByText('B2')).toBeNull()
  })

  it('clears both filters with one button', async () => {
    await renderPage()
    fireEvent.change(screen.getByLabelText('Search attendance matrix'), { target: { value: 'bina' } })
    fireEvent.change(screen.getByLabelText('Filter matrix by centre'), { target: { value: 'NOIDA' } })
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(screen.getByText('B1')).toBeTruthy()
    expect(screen.getByText('B2')).toBeTruthy()
    expect(screen.getByText('4 of 4 sewadars')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
  })
})
