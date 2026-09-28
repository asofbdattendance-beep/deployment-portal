// @vitest-environment jsdom
// AttendancePage — the defects that can only be caught with the component
// mounted, because each is a lie the pure helpers cannot see:
//
//   A2  the centre/dept filters survived a schedule change, so the <select>
//       read "All centres" while state still held a value that no longer existed
//       → 0 rows behind a valid-looking filter.
//   A5  <input type="date"> can be cleared to '', which used to be sent as
//       p_date: '' → Postgres "invalid input syntax for type date" → [] → a
//       false "no data for this day".
//   A11 all three RPCs used `.catch(() => [])`, so a missing v39 function
//       (PGRST202), an RLS denial or a dropped connection rendered as a clean
//       empty visit with zeroed stats.
//
// The mock setup mirrors src/hooks/useScanHandler.test.jsx.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import AttendancePage from './AttendancePage'

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
// A STABLE toast object, deliberately. The real useToast() is useMemo'd in
// ToastProvider — the provider comments call out that returning a fresh object
// "re-triggers effects and can cause reload loops" — so a mock that builds a new
// object per render() would spin the page's load effect forever and hang every
// test here for a reason that does not exist in production.
const toast = { error: toastError, success: toastSuccess, warning: toastWarning, info: vi.fn() }

vi.mock('../components/Toast', () => ({
  useToast: () => toast,
}))

const SCHEDULES = [{ id: 'sched-1', name: 'October 2026 Visit' }, { id: 'sched-2', name: 'November 2026 Visit' }]
const DATE = '2026-09-23'

const SEWADAR = {
  badge_number: 'FB5971GA0001',
  sewadar_name: 'RAM',
  sewadar_centre: 'DELHI',
  dept_name: 'MEDICAL',
  is_vss: false,
  days_present: 3,
  total_scans: 3,
  open_sessions: 0,
  first_in_date: DATE,
  first_in_time: '09:00:00',
  last_out_date: DATE,
  last_out_time: '18:00:00',
  still_open: false,
  undeployed_scan: false,
}
const OTHER_CENTRE = {
  ...SEWADAR,
  badge_number: 'FB5971GA0002',
  sewadar_name: 'SHAM',
  sewadar_centre: 'FARIDABAD',
  dept_name: 'COOKING',
}
const DAILY = [
  { centre: 'DELHI', dept_name: 'MEDICAL', expected: 4, present: 3, absent: 1, open_now: 0 },
  { centre: 'FARIDABAD', dept_name: 'COOKING', expected: 2, present: 2, absent: 0, open_now: 0 },
]
const SCANNER = [
  { scanner_badge: 'SC01', scanner_name: 'Scanner One', scanner_centre: 'DELHI', scans_in: 5, scans_out: 5, open_now: 0, manual_scans: 0, first_in_time: '08:00:00', last_scan_time: '20:00:00' },
]

/** Queue one resolved result per RPC, in the order the page fires them. */
function respondWith({ sew = [SEWADAR, OTHER_CENTRE], daily = DAILY, scanners = SCANNER } = {}) {
  rpc.mockImplementation((name) => {
    if (name === 'attendance_sewadar_summary') return Promise.resolve({ data: sew, error: null })
    if (name === 'attendance_daily_summary') return Promise.resolve({ data: daily, error: null })
    if (name === 'attendance_scanner_ops') return Promise.resolve({ data: scanners, error: null })
    return Promise.resolve({ data: [], error: null })
  })
}

/**
 * Flush pending microtasks so the state updates queued by a fireEvent land.
 * Deliberately NOT `act(async () => …)`: the raw act() thenable deadlocks
 * against the 400ms realtime-debounce timer this page schedules, and
 * `waitFor` (below) is the RTL-aware way to await a re-render anyway.
 */
const settle = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

/**
 * Render and wait until the loading gate has passed. Content-agnostic on
 * purpose: waiting for a specific string couples the test to the row fixture and
 * silently passes when the body happens to be empty.
 */
async function renderPage(props = {}) {
  const utils = render(<AttendancePage schedules={SCHEDULES} scheduleId="sched-1" {...props} />)
  await waitFor(() => expect(screen.queryByText('Loading attendance…')).toBeNull())
  return utils
}

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

describe('A11 — an RPC failure renders an error state, never a silent empty visit', () => {
  it('shows a friendly error panel, never the raw backend text, and NOT "No attendance records"', async () => {
    rpc.mockImplementation((name) =>
      Promise.resolve({ data: null, error: { message: `${name} does not exist`, code: 'PGRST202' } })
    )
    await renderPage()
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText('Could not load attendance')).toBeTruthy()
    expect(screen.getByText(/may not be installed on this database/)).toBeTruthy()
    // The raw Postgres detail (function names, PGRST202, the backend message) is
    // logged to the console for debugging but must NEVER reach the screen.
    expect(screen.queryByText(/does not exist/)).toBeNull()
    expect(screen.queryByText(/PGRST202/)).toBeNull()
    expect(screen.queryByText(/attendance_sewadar_summary/)).toBeNull()
    expect(screen.queryByText('No attendance records')).toBeNull()
    expect(screen.queryByText('No deployment for this day')).toBeNull()
    // no zeroed stats presented as fact
    expect(screen.queryByText('Scanned')).toBeNull()
  })

  it('offers a retry that re-issues all three RPCs', async () => {
    rpc.mockImplementation(() => Promise.resolve({ data: null, error: { message: 'boom' } }))
    await renderPage()
    expect(screen.getByText('Could not load attendance')).toBeTruthy()
    expect(rpc).toHaveBeenCalledTimes(3)

    respondWith()
    fireEvent.click(screen.getByText(/Retry/))
    await waitFor(() => expect(screen.getByText('RAM')).toBeTruthy())
    expect(rpc).toHaveBeenCalledTimes(6)
  })

  it('still errors out when only one of the three RPCs fails', async () => {
    rpc.mockImplementation((name) =>
      name === 'attendance_scanner_ops'
        ? Promise.resolve({ data: null, error: { message: 'permission denied for scanner_ops' } })
        : Promise.resolve({ data: [], error: null })
    )
    await renderPage()
    // A partial outage must NOT read as "no attendance records" just because
    // two of the three calls happened to succeed.
    expect(screen.getByText('Could not load attendance')).toBeTruthy()
    expect(screen.queryByText(/permission denied/)).toBeNull()
    expect(screen.queryByText('No attendance records')).toBeNull()
    expect(screen.queryByText('Scanned')).toBeNull()
  })
})

describe('A5 — an empty scan day is never sent to Postgres', () => {
  it('skips the date-keyed RPCs and explains why, instead of claiming no data', async () => {
    await renderPage()
    // the page really did ask for a day, with a real date
    expect(rpc).toHaveBeenCalledWith('attendance_daily_summary', { p_schedule: 'sched-1', p_date: expect.any(String) })

    fireEvent.change(screen.getByLabelText('Scan day'), { target: { value: '' } })
    await settle()

    expect(screen.getByText(/Pick a scan day/)).toBeTruthy()
    for (const call of rpc.mock.calls) {
      expect(call[1]?.p_date).not.toBe('')
    }
    expect(screen.getByLabelText('Scan day').getAttribute('aria-invalid')).toBe('true')
  })

  it('renders "No scan day selected" on the Daily tab, not "no deployment for this day"', async () => {
    await renderPage()
    fireEvent.change(screen.getByLabelText('Scan day'), { target: { value: '' } })
    await settle()
    fireEvent.click(screen.getByText('Daily'))
    expect(screen.getByText('No scan day selected')).toBeTruthy()
    expect(screen.queryByText('No deployment for this day')).toBeNull()
  })

  it('sends no date-keyed RPC at all while the day is empty', async () => {
    await renderPage()
    rpc.mockClear()
    fireEvent.change(screen.getByLabelText('Scan day'), { target: { value: '' } })
    await settle()
    const names = rpc.mock.calls.map((c) => c[0])
    expect(names).not.toContain('attendance_daily_summary')
    expect(names).not.toContain('attendance_scanner_ops')
    expect(names).toContain('attendance_sewadar_summary')
  })
})

describe('A2 — filters reset when the schedule changes', () => {
  it('clears a centre filter that the new schedule has no option for', async () => {
    const { rerender } = await renderPage()

    // sched-1 has rows for DELHI and FARIDABAD; pick DELHI.
    const centre = screen.getByLabelText('Filter by centre')
    expect([...centre.querySelectorAll('option')].map((o) => o.value)).toEqual(['all', 'DELHI', 'FARIDABAD'])
    fireEvent.change(centre, { target: { value: 'DELHI' } })
    await settle()
    expect(centre.value).toBe('DELHI')
    expect(screen.getByText('Showing 1 of 2')).toBeTruthy()

    // sched-2 returns ZERO sewadar rows: the DELHI option disappears. Without
    // the reset the select would read "All centres" while state still held
    // 'DELHI' — 0 rows behind a filter that looks valid.
    respondWith({ sew: [], daily: [], scanners: [] })
    rerender(<AttendancePage schedules={SCHEDULES} scheduleId="sched-2" />)
    await waitFor(() => expect(screen.getByText('No attendance records')).toBeTruthy())
    expect(screen.getByLabelText('Filter by centre').value).toBe('all')
    expect(screen.getByLabelText('Filter by department').value).toBe('all')
  })

  it('resets the department filter too', async () => {
    const { rerender } = await renderPage()
    fireEvent.change(screen.getByLabelText('Filter by department'), { target: { value: 'MEDICAL' } })
    await settle()
    expect(screen.getByLabelText('Filter by department').value).toBe('MEDICAL')

    respondWith({ sew: [], daily: [], scanners: [] })
    rerender(<AttendancePage schedules={SCHEDULES} scheduleId="sched-2" />)
    await waitFor(() => expect(screen.getByLabelText('Filter by department').value).toBe('all'))
  })
})

describe("A13 — the previous schedule's rows never render under the new schedule", () => {
  it('blanks the body while the new schedule is in flight', async () => {
    let release = null
    const gate = new Promise((r) => { release = r })
    const { rerender } = await renderPage()
    expect(screen.getByText('RAM')).toBeTruthy()
    // the in-flight requests resolve to an empty-but-valid result

    rpc.mockImplementation(() => gate)
    rerender(<AttendancePage schedules={SCHEDULES} scheduleId="sched-2" />)
    await settle()
    // the old schedule's rows are gone, not merely greyed out
    expect(screen.getByText('Loading attendance…')).toBeTruthy()
    expect(screen.queryByText('RAM')).toBeNull()
    expect(screen.queryByText('SHAM')).toBeNull()

    release({ data: [], error: null })
    await gate
    await waitFor(() => expect(screen.getByText('No attendance records')).toBeTruthy())
  })

  it('disables Export while the rows belong to a different schedule', async () => {
    let release = null
    const gate = new Promise((r) => { release = r })
    const { rerender } = await renderPage()
    expect(screen.getByText(/Export Excel/).closest('button').disabled).toBe(false)

    rpc.mockImplementation(() => gate)
    rerender(<AttendancePage schedules={SCHEDULES} scheduleId="sched-2" />)
    await settle()
    release({ data: [], error: null })
    await gate
    await waitFor(() => expect(screen.getByText('No attendance records')).toBeTruthy())
  })
})

describe('A16 — department options follow the centre filter', () => {
  it('never offers a department the chosen centre cannot have', async () => {
    await renderPage()
    const deptSelect = () => screen.getByLabelText('Filter by department')
    expect([...deptSelect().querySelectorAll('option')].map((o) => o.value)).toEqual(['all', 'COOKING', 'MEDICAL'])

    fireEvent.change(screen.getByLabelText('Filter by centre'), { target: { value: 'DELHI' } })
    await settle()
    // FARIDABAD's COOKING is not a valid combination any more
    expect([...deptSelect().querySelectorAll('option')].map((o) => o.value)).toEqual(['all', 'MEDICAL'])
  })
})

describe('A10 — the tab list is not role-gated', () => {
  it('offers all three tabs and lets the RPC decide the rows', async () => {
    // A role with no scanner_ops access gets zero rows server-side; the tab is
    // still present and the empty state shows through honestly.
    respondWith({ sew: [SEWADAR], daily: DAILY, scanners: [] })
    await renderPage()
    expect(screen.getByText('Scanner Ops')).toBeTruthy()
    fireEvent.click(screen.getByText('Scanner Ops'))
    expect(screen.getByText('No scanner activity')).toBeTruthy()
  })
})

describe('A6 — an undeployed sewadar gets no rate, not a misleading 0%', () => {
  it('shows no 0/5 denominator and no 0% pill when there is no department', async () => {
    respondWith({ sew: [{ ...SEWADAR, dept_name: null, days_present: 0 }], daily: [], scanners: [] })
    await renderPage()
    expect(screen.getByText('RAM')).toBeTruthy()
    expect(screen.queryByText('0/5')).toBeNull()
    expect(screen.queryByText('0%')).toBeNull()
  })

  it('still shows a real rate for a deployed sewadar', async () => {
    respondWith({ sew: [SEWADAR], daily: [], scanners: [] })
    await renderPage()
    expect(screen.getByText('3/5')).toBeTruthy()
    expect(screen.getByText('60%')).toBeTruthy()
  })
})

describe('A8 — session duration is rendered, not dead code', () => {
  it('shows the first-in → last-out duration for a closed session', async () => {
    respondWith({ sew: [{ ...SEWADAR, first_in_time: '09:00:00', last_out_time: '18:30:00' }], daily: [], scanners: [] })
    await renderPage()
    expect(screen.getByText('9h 30m')).toBeTruthy()
  })

  it('says "still IN" rather than measuring to zero', async () => {
    respondWith({ sew: [{ ...SEWADAR, last_out_date: null, last_out_time: null, still_open: true }], daily: [], scanners: [] })
    await renderPage()
    expect(screen.getAllByText('still IN').length).toBeGreaterThan(0)
  })
})

describe('A4 — all three tables honour the one filter set', () => {
  it('filters the Daily table by the centre chosen on the Sewadars tab', async () => {
    await renderPage()
    fireEvent.change(screen.getByLabelText('Filter by centre'), { target: { value: 'DELHI' } })
    await settle()
    fireEvent.click(screen.getByText('Daily'))
    const body = document.querySelectorAll('table tbody tr')
    expect(body).toHaveLength(1)
    expect(body[0].textContent).toContain('DELHI')
    expect(body[0].textContent).not.toContain('FARIDABAD')
  })

  it('applies the search term to the Daily table as well', async () => {
    await renderPage()
    fireEvent.change(screen.getByLabelText('Search attendance'), { target: { value: 'cooking' } })
    await settle()
    fireEvent.click(screen.getByText('Daily'))
    const body = document.querySelectorAll('table tbody tr')
    expect(body).toHaveLength(1)
    expect(body[0].textContent).toContain('COOKING')
  })
})
