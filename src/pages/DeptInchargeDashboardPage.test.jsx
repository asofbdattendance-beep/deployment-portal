// @vitest-environment jsdom
// DeptInchargeDashboardPage — smoke coverage for the dept_incharge landing tab (v51).
//
// Deliberately a SMOKE test, not a second copy of the DashboardPage defect
// suite. This page is read-only, has no filters to reset and no form inputs, so
// the failure modes worth pinning are narrow and structural:
//
//   1. It renders at all — title, LIVE pill, the four present/absent tiles.
//   2. It calls EXACTLY the two attendance RPCs it is contracted to call and
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
}))

// A STABLE toast object — a fresh object per render() would re-trigger the
// page's load effect forever and hang every test for a reason that does not
// exist in production.
const toast = { error: toastError, success: toastSuccess, warning: toastWarning, info: vi.fn() }

vi.mock('../components/Toast', () => ({
  useToast: () => toast,
}))

const SCHEDULES = [{ id: 'sched-1', name: 'October 2026 Visit', status: 'open' }]

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

/** Queue one resolved result per RPC, or an error for anything in `fail`. */
function respondWith({ daily = DAILY, visit = VISIT, fail = [] } = {}) {
  rpc.mockImplementation((name) => {
    if (fail.includes(name)) return Promise.resolve({ data: null, error: { message: `${name} does not exist`, code: 'PGRST202' } })
    if (name === 'attendance_daily_summary') return Promise.resolve({ data: daily, error: null })
    if (name === 'attendance_visit_summary') return Promise.resolve({ data: visit, error: null })
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

describe('DeptInchargeDashboardPage — by-department table (T1/T2)', () => {
  // T1: the table row for one department across two centres must SUM (16/12/4
  // like the tiles), not show the last centre row (6/4/2). Old code assigned
  // per row, so NOIDA won.
  it('sums the table row across centres instead of showing the last centre', async () => {
    await renderPage()
    const rowEl = [...document.querySelector('table').querySelectorAll('tbody tr')]
      .find((tr) => tr.textContent.includes('MEDICAL'))
    const nums = [...rowEl.querySelectorAll('td')].map((td) => td.textContent.trim())
    expect(nums[1]).toBe('16') // Deployed
    expect(nums[2]).toBe('12') // Present today
    expect(nums[3]).toBe('4') // Absent today
  })

  // T2: an explicit today 0 must render as 0, never fall back to the visit
  // number. Old code rendered `d.today.deployed || d.visit.deployed` → 5.
  it('shows an explicit 0 in the Deployed column when today is 0', async () => {
    respondWith({
      daily: [{ centre: 'C', department_id: 'd9', dept_name: 'STORE', expected: 0, present: 0, absent: 0, open_now: 0 }],
      visit: [{ centre: 'C', department_id: 'd9', dept_name: 'STORE', deployed: 5, ever_present: 4, never_present: 1, open_now: 0 }],
    })
    await renderPage()
    const rowEl = [...document.querySelector('table').querySelectorAll('tbody tr')]
      .find((tr) => tr.textContent.includes('STORE'))
    const nums = [...rowEl.querySelectorAll('td')].map((td) => td.textContent.trim())
    expect(nums[1]).toBe('0')
  })

  // T2: the tiles query the operator-picked scan day, so the subs name it
  // instead of hardcoding "today".
  it('names the selected scan day in the today subs', async () => {
    await renderPage()
    expect(kpiRow(0).getAllByText(/\d{4}-\d{2}-\d{2}/).length).toBeGreaterThan(0)
  })
})

describe('DeptInchargeDashboardPage — RPC contract', () => {
  it('calls exactly the two scope-resolved RPCs and never a table directly', async () => {
    await renderPage()
    const names = rpc.mock.calls.map((c) => c[0])
    expect(new Set(names)).toEqual(new Set(['attendance_daily_summary', 'attendance_visit_summary']))
    expect(names.every((n) => n.startsWith('attendance_'))).toBe(true)
  })

  it('passes the selected schedule and scan day through', async () => {
    await renderPage()
    const dailyCall = rpc.mock.calls.find((c) => c[0] === 'attendance_daily_summary')
    expect(dailyCall[1].p_schedule).toBe('sched-1')
    expect(dailyCall[1].p_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
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

describe('DeptInchargeDashboardPage — export needs both arms', () => {
  it('disables Export snapshot when one arm failed', async () => {
    respondWith({ fail: ['attendance_visit_summary'] })
    await renderPage()
    expect(screen.getByRole('button', { name: /Export snapshot/i }).disabled).toBe(true)
  })

  it('enables Export snapshot when both arms landed', async () => {
    await renderPage()
    expect(screen.getByRole('button', { name: /Export snapshot/i }).disabled).toBe(false)
  })
})
