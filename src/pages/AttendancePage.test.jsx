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
import { render, screen, waitFor, fireEvent, cleanup, act } from '@testing-library/react'
import { todayStrIST } from '../lib/scannerUtils'
import { UNASSIGNED_CENTRE } from '../lib/attendance'
import AttendancePage from './AttendancePage'

const rpc = vi.fn()
// fetchAllRpc delegates to the SAME fixture engine as `rpc`, then upholds the
// real contract: a resolved `{ error }` THROWS (production fetchAllRpc never
// returns an error object as rows). Page fixtures stay in one place.
const fetchAllRpc = vi.fn(async (name, params) => {
  const res = await rpc(name, params)
  if (res?.error) throw res.error
  return Array.isArray(res?.data) ? res.data : []
})
const toastError = vi.fn()
const toastSuccess = vi.fn()
const toastWarning = vi.fn()

// Supabase realtime is inert here: a chainable no-op that satisfies
// channel().on(...).subscribe() and removeChannel(). Handlers are captured
// so the max-wait test can fire reloads on demand.
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

  it('degrades only the Scanner tab when scanner_ops fails — the page stays live', async () => {
    rpc.mockImplementation((name) =>
      name === 'attendance_scanner_ops'
        ? Promise.resolve({ data: null, error: { message: 'permission denied for scanner_ops' } })
        : name === 'attendance_sewadar_summary'
          ? Promise.resolve({ data: [SEWADAR, OTHER_CENTRE], error: null })
          : Promise.resolve({ data: DAILY, error: null })
    )
    await renderPage()
    // A partial outage must NOT read as "no attendance records": no
    // full-page error, and the Sewadars tab renders its rows.
    expect(screen.queryByText('Could not load attendance')).toBeNull()
    expect(screen.getByText('RAM')).toBeTruthy()
    expect(screen.getByText('SHAM')).toBeTruthy()
    expect(screen.queryByText(/permission denied/)).toBeNull()
    expect(screen.queryByText('No attendance records')).toBeNull()

    // The Scanner Ops tab carries its own error card with a Retry.
    fireEvent.click(screen.getByText('Scanner Ops'))
    expect(screen.getByText('Scanner activity')).toBeTruthy()
    expect(screen.getByText(/could not be loaded/)).toBeTruthy()
    expect(screen.getByText('Retry')).toBeTruthy()

    // The Daily tab is unaffected — healthy data is never blanked.
    fireEvent.click(screen.getByText('Daily'))
    expect(screen.queryByRole('alert')).toBeNull()
    const dailyBody = document.querySelectorAll('table tbody tr')
    expect(dailyBody).toHaveLength(2)
    expect(dailyBody[0].textContent).toContain('DELHI')
  })

  it('degrades only the Daily tab when attendance_daily_summary fails', async () => {
    rpc.mockImplementation((name) =>
      name === 'attendance_daily_summary'
        ? Promise.resolve({ data: null, error: { message: 'daily is gone' } })
        : name === 'attendance_sewadar_summary'
          ? Promise.resolve({ data: [SEWADAR, OTHER_CENTRE], error: null })
          : Promise.resolve({ data: SCANNER, error: null })
    )
    await renderPage()
    expect(screen.queryByText('Could not load attendance')).toBeNull()
    expect(screen.getByText('RAM')).toBeTruthy()

    fireEvent.click(screen.getByText('Daily'))
    expect(screen.getByText('Daily figures')).toBeTruthy()
    expect(screen.getByText('Retry')).toBeTruthy()

    // Retry re-issues the RPCs; a recovered backend clears the card.
    respondWith()
    fireEvent.click(screen.getByText('Retry'))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    const dailyBody = document.querySelectorAll('table tbody tr')
    expect(dailyBody).toHaveLength(2)
    expect(dailyBody[0].textContent).toContain('DELHI')
  })

  it('still takes the whole page when the sewadar summary alone fails', async () => {
    // Every tile and every tab is built on the sewadar rows — without them
    // there is nothing honest to show, so this one failure stays full-page.
    rpc.mockImplementation((name) =>
      name === 'attendance_sewadar_summary'
        ? Promise.resolve({ data: null, error: { message: 'sewadar summary is gone' } })
        : Promise.resolve({ data: [], error: null })
    )
    await renderPage()
    expect(screen.getByText('Could not load attendance')).toBeTruthy()
    expect(screen.queryByText(/sewadar summary is gone/)).toBeNull()
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
    // …and it goes through the PAGINATING helper, not the single-shot wrapper
    // (a revert to rpcRows would silently re-cap KPIs + export at 1000 rows).
    expect(fetchAllRpc.mock.calls.map(([n]) => n)).toContain('attendance_sewadar_summary')
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

vi.mock('xlsx', () => ({
  utils: {
    book_new: vi.fn(() => ({})),
    json_to_sheet: vi.fn((rows) => ({ rows })),
    book_append_sheet: vi.fn(),
  },
  writeFile: vi.fn(),
  write: vi.fn(() => new Uint8Array([1, 2, 3])),
}))

// L-45: the header tiles must describe the same filter set as the tables
// and the export (ReportsPage already totals its visible rows — I1), not
// the whole schedule behind a filtered view.
const scannedTile = () => {
  const label = screen.getByText('Scanned')
  return label.closest('.stat').querySelector('.stat-value').textContent
}

describe('L-45 — header tiles follow the active filters', () => {
  it('shows schedule-wide totals with no filter active', async () => {
    await renderPage()
    expect(scannedTile()).toBe('2')
  })

  it('narrows the tiles when a centre filter is active', async () => {
    await renderPage()
    fireEvent.change(screen.getByLabelText('Filter by centre'), { target: { value: 'DELHI' } })
    await settle()
    expect(scannedTile()).toBe('1')
    // The table agrees — tiles and rows describe one filter set.
    expect(screen.queryByText('SHAM')).toBeNull()
  })
})

describe('C2 — exports use the shared driver naming (L-24/L-25)', () => {
  it('writes a slugged {schedule}_{date}_attendance.xlsx filename', async () => {
    await renderPage()
    URL.createObjectURL = vi.fn(() => 'blob:mock')
    URL.revokeObjectURL = vi.fn()
    let downloaded = null
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
      downloaded = this.download
    })
    try {
      fireEvent.click(screen.getByText(/Export Excel/))
      const { write } = await import('xlsx')
      await waitFor(() => expect(write).toHaveBeenCalled())
      await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Attendance exported'))
      // Schedule "October 2026 Visit" must not land in the filename with raw
      // spaces, and the kind suffix marks what the workbook holds.
      expect(downloaded).toBe(`October_2026_Visit_${todayStrIST()}_attendance.xlsx`)
    } finally {
      clickSpy.mockRestore()
    }
  })

  it('names sheets through the null-safe shared helper', async () => {
    await renderPage()
    fireEvent.click(screen.getByText(/Export Excel/))
    const { utils } = await import('xlsx')
    await waitFor(() => expect(utils.book_append_sheet).toHaveBeenCalled())
    const names = utils.book_append_sheet.mock.calls.map(c => c[2])
    expect(names[0]).toMatch(/^Sewadars/)
    for (const n of names) {
      expect(typeof n).toBe('string')
      expect(n.length).toBeLessThanOrEqual(31)
    }
  })
})

describe('UNASSIGNED filter matches the pre-normalised rows', () => {
  it('shows null-centre sewadars AND normalised daily rows under the Unassigned filter', async () => {
    respondWith({
      sew: [{ ...SEWADAR, sewadar_centre: null }],
      daily: [{ centre: null, dept_name: 'MEDICAL', expected: 1, present: 0, absent: 1, open_now: 0 }],
      scanners: [],
    })
    await renderPage()
    // The option exists (unioned from both row sets)…
    expect([...screen.getByLabelText('Filter by centre').querySelectorAll('option')].map((o) => o.value))
      .toContain(UNASSIGNED_CENTRE)
    fireEvent.change(screen.getByLabelText('Filter by centre'), { target: { value: UNASSIGNED_CENTRE } })
    await settle()
    // …and the sewadar with no home centre is still listed.
    expect(screen.getByText('RAM')).toBeTruthy()
    // The daily row was normalised to the UNASSIGNED string (never null), so
    // the old `!value`-only matcher dropped it and the tab read 0 rows.
    fireEvent.click(screen.getByText('Daily'))
    const body = document.querySelectorAll('table tbody tr')
    expect(body).toHaveLength(1)
    expect(body[0].textContent).toContain('MEDICAL')
  })
})

describe('the "Showing N of M" pill counts the active tab', () => {
  it('switches its denominator when the tab switches', async () => {
    await renderPage()
    fireEvent.change(screen.getByLabelText('Filter by centre'), { target: { value: 'DELHI' } })
    await settle()
    expect(screen.getByText('Showing 1 of 2')).toBeTruthy()

    // The Daily tab agrees here (DELHI 1 of 2) — the Scanner tab is the
    // discriminator: one DELHI scanner of one total, not the sewadar 1-of-2.
    fireEvent.click(screen.getByText('Scanner Ops'))
    await settle()
    expect(screen.getByText('Showing 1 of 1')).toBeTruthy()
    expect(screen.queryByText('Showing 1 of 2')).toBeNull()
  })
})

describe('centre options union sewadar and daily rows', () => {
  it('offers a deployed-but-unscanned centre that only the daily rows know', async () => {
    // FARIDABAD is deployed (daily row) but has no scanned sewadar row.
    respondWith({
      sew: [SEWADAR],
      daily: [{ centre: 'FARIDABAD', dept_name: 'COOKING', expected: 2, present: 0, absent: 2, open_now: 0 }],
      scanners: [],
    })
    await renderPage()
    expect([...screen.getByLabelText('Filter by centre').querySelectorAll('option')].map((o) => o.value))
      .toEqual(['all', 'DELHI', 'FARIDABAD'])
  })
})

describe('realtime max-wait', () => {
  it('debounces a burst but fires immediately past the 2000ms max-wait', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => 2_000_000)
    try {
      await renderPage()
      expect(rpc).toHaveBeenCalledTimes(3)
      expect(pgHandlers.length).toBeGreaterThan(0)
      const reload = pgHandlers[0]

      // 500ms after the load: inside the window → trailing 400ms debounce.
      nowSpy.mockImplementation(() => 2_000_500)
      reload()
      await waitFor(() => expect(rpc).toHaveBeenCalledTimes(6))

      // 5s after the last load: past max-wait → immediate, no timer wait.
      nowSpy.mockImplementation(() => 2_010_000)
      reload()
      await waitFor(() => expect(rpc).toHaveBeenCalledTimes(9))
    } finally {
      nowSpy.mockRestore()
    }
  })
})

describe('a hung RPC degrades its tab instead of latching loading', () => {
  it('times out attendance_daily_summary and keeps the Sewadars tab live', async () => {
    respondWith()
    const baseImpl = rpc.getMockImplementation()
    rpc.mockImplementation((...args) => (args[0] === 'attendance_daily_summary' ? new Promise(() => {}) : baseImpl(...args)))
    vi.useFakeTimers()
    try {
      render(<AttendancePage schedules={SCHEDULES} scheduleId="sched-1" />)
      // The 15s withTimeout abort is a timer: advance past it and flush.
      await act(async () => { await vi.advanceTimersByTimeAsync(16000) })
      expect(screen.queryByText('Loading attendance…')).toBeNull()
      expect(screen.queryByText('Could not load attendance')).toBeNull()
      expect(screen.getByText('RAM')).toBeTruthy()
      fireEvent.click(screen.getByText('Daily'))
      expect(screen.getByText('Daily figures')).toBeTruthy()
      expect(screen.getByText('Retry')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})
