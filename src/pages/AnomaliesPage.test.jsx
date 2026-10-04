// @vitest-environment jsdom
// AnomaliesPage — the read-only anomaly feed over `attendance_anomalies`
// (sql/v45_attendance_reports.sql, §6).
//
// This suite covers the three ways a "no anomalies" claim can be a LIE, plus
// the one date contract that decides how much of the visit is even asked for:
//
//   1. Smoke — a mixed-rule result must surface one row per rule, each with
//      the right severity pill. A page that rendered every rule in the neutral
//      grey would look fine and be useless.
//   2. Scope — the RPC resolves the caller's own scope and returns [] for a
//      role it does not cover, so an empty array is the SAME payload as a
//      broken database. supabase-js RESOLVES { error }; without an explicit
//      throw a missing function (PGRST202) renders as a clean, wrong visit.
//   3. p_date — NULL is the whole visit, a date is that event-date. Getting
//      this backwards silently reports "no anomalies" for a busy day.
//
// The mock setup mirrors src/pages/AttendancePage.test.jsx.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import AnomaliesPage from './AnomaliesPage'

const rpc = vi.fn()
const toastError = vi.fn()
const toastSuccess = vi.fn()
const toastWarning = vi.fn()

// Supabase realtime is inert here: a chainable no-op that satisfies
// channel().on(...).subscribe() and removeChannel(). The name is captured so a
// test can assert the channel this page actually opens.
let channelName = null
let subscribed = false
const noopChannel = () => {
  const ch = {
    on: () => ch,
    subscribe: () => { subscribed = true; return ch },
    unsubscribe: () => ch,
  }
  return ch
}

vi.mock('../lib/supabase', () => ({
  supabase: {
    rpc: (...args) => rpc(...args),
    channel: (name) => { channelName = name; return noopChannel() },
    removeChannel: () => {},
  },
}))

// A STABLE toast object, deliberately — see the note in AttendancePage.test.jsx:
// the real useToast() is useMemo'd in ToastProvider, so a per-render mock object
// would re-trigger this page's load effect forever and hang every test.
const toast = { error: toastError, success: toastSuccess, warning: toastWarning, info: vi.fn() }

vi.mock('../components/Toast', () => ({
  useToast: () => toast,
}))

// `xlsx` is lazy-imported inside exportWorkbook, so a module mock is the only
// way to assert the workbook without a real file write. json_to_sheet is
// captured verbatim so the test can read back exactly what the page sent.
const writeFile = vi.fn()
const bookAppendSheet = vi.fn()
vi.mock('xlsx', () => ({
  utils: {
    book_new: () => ({}),
    book_append_sheet: (...a) => bookAppendSheet(...a),
    json_to_sheet: (rows) => ({ rows }),
  },
  writeFile: (...a) => writeFile(...a),
  write: vi.fn(() => new Uint8Array([1, 2, 3])),
}))

// The export now downloads via an anchor Blob URL (not xlsx.writeFile), so
// filename assertions read the anchor's download attribute.
async function clickExportAndGetFilename() {
  URL.createObjectURL = vi.fn(() => 'blob:mock')
  URL.revokeObjectURL = vi.fn()
  let downloaded = null
  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
    downloaded = this.download
  })
  try {
    fireEvent.click(screen.getByText('Export Excel'))
    const { write } = await import('xlsx')
    await waitFor(() => expect(write).toHaveBeenCalled())
    return downloaded
  } finally {
    clickSpy.mockRestore()
  }
}

const SCHEDULES = [
  { id: 'sched-1', name: 'October 2026 Visit' },
  { id: 'sched-2', name: 'November 2026 Visit' },
]

// One row per rule family, so the smoke test can prove BOTH severities render:
// UNDEPLOYED_SCAN is pill-red, STALE_OPEN is pill-amber.
const ANOMALIES = [
  {
    rule: 'UNDEPLOYED_SCAN',
    badge_number: 'FB5971GA0001',
    sewadar_name: 'RAM',
    sewadar_centre: 'DELHI',
    dept_name: null,
    detail: 'Scanned 2026-09-23 09:00 with no deployment for this schedule',
    event_date: '2026-09-23',
  },
  {
    rule: 'STALE_OPEN',
    badge_number: 'FB5971GA0002',
    sewadar_name: 'SHAM',
    sewadar_centre: 'FARIDABAD',
    dept_name: 'COOKING',
    detail: 'OPEN since 2026-09-22 18:00 — likely a missed OUT',
    event_date: '2026-09-22',
  },
]

/** Queue the RPC result the page will ask for. */
function respondWith({ rows = ANOMALIES } = {}) {
  rpc.mockImplementation((name) => {
    if (name === 'attendance_anomalies') return Promise.resolve({ data: rows, error: null })
    return Promise.resolve({ data: [], error: null })
  })
}

/**
 * Flush pending microtasks so the state updates queued by a fireEvent land.
 * Deliberately NOT `act(async () => …)`: the raw act() thenable deadlocks
 * against the 400ms realtime-debounce timer this page schedules.
 */
const settle = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

/**
 * Render and wait until the feed has settled. Content-agnostic on purpose —
 * waiting for a specific string couples the test to the fixture. Loading now
 * renders skeleton rows (never a spinner), so readiness means table rows, the
 * empty state, or the error panel — whichever the fixture produces.
 */
async function renderPage(props = {}) {
  const utils = render(<AnomaliesPage schedules={SCHEDULES} scheduleId="sched-1" {...props} />)
  await waitFor(() => {
    const ready = document.querySelector('table tbody tr')
      || screen.queryByRole('alert')
      || screen.queryByText('No anomalies')
      || screen.queryByText('No anomalies for this filter')
    expect(ready).toBeTruthy()
  })
  return utils
}

beforeEach(() => {
  rpc.mockReset()
  toastError.mockReset()
  toastSuccess.mockReset()
  toastWarning.mockReset()
  writeFile.mockReset()
  bookAppendSheet.mockReset()
  channelName = null
  subscribed = false
  respondWith()
})

// The project does not enable vitest `globals`, so @testing-library/react's
// automatic afterEach cleanup never registers — without this the DOM from every
// previous test would still be mounted and getByText would match twice.
afterEach(() => { cleanup() })

describe('smoke — a mixed-rule result renders one row per rule, at its real severity', () => {
  it('shows the page title and a pill for each rule the server returned', async () => {
    await renderPage()

    expect(screen.getByRole('heading', { name: /Anomalies/ })).toBeTruthy()

    const rows = document.querySelectorAll('table tbody tr')
    expect(rows).toHaveLength(2)

    // Severity is the whole point of the feed: a badge scanned with no
    // deployment is red, a stale OPEN is amber. Asserted on the pill class, not
    // the string, because both strings are also on the filter chips.
    const redPill = document.querySelector('.pill-red')
    expect(redPill).toBeTruthy()
    expect(redPill.textContent).toContain('Undeployed scan')
    expect(redPill.closest('tr').textContent).toContain('FB5971GA0001')

    const amberPill = document.querySelector('.pill-amber')
    expect(amberPill).toBeTruthy()
    expect(amberPill.textContent).toContain('Stale OPEN')
    expect(amberPill.closest('tr').textContent).toContain('FB5971GA0002')
  })

  it('says the page is read-only and offers no resolve action', async () => {
    await renderPage()
    expect(screen.getByText(/Read-only/)).toBeTruthy()
    expect(screen.getByText('View-only')).toBeTruthy()
  })

  it('counts each rule on its filter chip', async () => {
    await renderPage()
    // Two rules, one row each.
    expect(screen.getByText('Undeployed scan (1)')).toBeTruthy()
    expect(screen.getByText('Stale OPEN (1)')).toBeTruthy()
  })
})

describe('scope — an RPC failure is never rendered as a clean visit', () => {
  it('shows a friendly error panel and NOT "No anomalies"', async () => {
    rpc.mockImplementation(() =>
      Promise.resolve({ data: null, error: { message: 'attendance_anomalies does not exist', code: 'PGRST202' } })
    )
    await renderPage()

    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText('Could not load anomalies')).toBeTruthy()
    // The raw backend text is logged for debugging, never shown.
    expect(screen.queryByText(/PGRST202/)).toBeNull()
    expect(screen.queryByText(/does not exist/)).toBeNull()
    expect(screen.queryByText('No anomalies')).toBeNull()
  })

  it('genuinely empty scope renders the empty state, not an error', async () => {
    respondWith({ rows: [] })
    await renderPage()
    expect(screen.getByText('No anomalies')).toBeTruthy()
    expect(toastError).not.toHaveBeenCalled()
  })
})

describe('p_date — NULL is the whole visit, a date is that event-date', () => {
  it('asks for the whole visit by default', async () => {
    await renderPage()
    expect(rpc).toHaveBeenCalledWith('attendance_anomalies', {
      p_schedule: 'sched-1',
      p_date: null,
    })
  })

  it('sends the chosen date, and All dates returns it to null', async () => {
    await renderPage()
    rpc.mockClear()

    fireEvent.change(screen.getByLabelText('Anomaly date'), { target: { value: '2026-09-24' } })
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('attendance_anomalies', {
        p_schedule: 'sched-1',
        p_date: '2026-09-24',
      })
    )

    fireEvent.click(screen.getByText('All dates (visit)'))
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('attendance_anomalies', {
        p_schedule: 'sched-1',
        p_date: null,
      })
    )
  })
})

describe('realtime — a mid-visit anomaly shows up without a manual refresh', () => {
  it('subscribes to a schedule-scoped channel', async () => {
    await renderPage()
    expect(subscribed).toBe(true)
    expect(channelName).toBe('anomalies-sched-1')
  })
})

describe('filtering — chips and search narrow the table, not the counts', () => {
  it('clicking a rule chip keeps only that rule', async () => {
    await renderPage()
    fireEvent.click(screen.getByText('Undeployed scan (1)'))
    await settle()
    const rows = document.querySelectorAll('table tbody tr')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('FB5971GA0001')
    expect(rows[0].textContent).not.toContain('FB5971GA0002')
  })

  it('searches badge, name and centre', async () => {
    await renderPage()
    fireEvent.change(screen.getByLabelText('Search anomalies'), { target: { value: 'faridabad' } })
    await settle()
    const rows = document.querySelectorAll('table tbody tr')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('SHAM')
  })
})

describe('Excel — two sheets, and nothing is written when there is nothing to write', () => {
  it('writes an Anomalies sheet and a Counts sheet to a date-stamped filename', async () => {
    await renderPage()
    const downloaded = await clickExportAndGetFilename()

    // 'visit' in the filename, because no date is pinned — a whole-visit export
    // must not be labelled with a day it does not represent.
    expect(downloaded).toBe('October_2026_Visit_visit_anomalies.xlsx')

    const sheetNames = bookAppendSheet.mock.calls.map((c) => c[2])
    expect(sheetNames).toEqual(['Anomalies', 'Counts'])

    const anomalyRows = bookAppendSheet.mock.calls[0][1].rows
    expect(anomalyRows[0]).toEqual({
      Rule: 'Undeployed scan',
      Badge: 'FB5971GA0001',
      Name: 'RAM',
      Centre: 'DELHI',
      Department: '—',
      Detail: 'Scanned 2026-09-23 09:00 with no deployment for this schedule',
      Date: '2026-09-23',
    })

    expect(bookAppendSheet.mock.calls[1][1].rows).toEqual([
      { Rule: 'Undeployed scan', Count: 1 },
      { Rule: 'Stale OPEN', Count: 1 },
    ])
  })

  it('warns and writes no file when the result is empty', async () => {
    respondWith({ rows: [] })
    await renderPage()
    fireEvent.click(screen.getByText('Export Excel'))
    await settle()
    expect(toastWarning).toHaveBeenCalledWith('No anomalies to export')
    expect(writeFile).not.toHaveBeenCalled()
  })
})

describe('null-safe display — a null centre and a null event date are never blank cells', () => {
  // BAD_STATUS is the one rule that reports the CURRENT badge status, so the
  // server sends event_date = null and can easily have no home centre either.
  const NULL_ROW = {
    rule: 'BAD_STATUS',
    badge_number: 'FB5971GA0003',
    sewadar_name: 'SUKH',
    sewadar_centre: null,
    dept_name: null,
    detail: 'Badge status ELDERLY is not OPEN/PERMANENT — scanned 2 time(s) this visit',
    event_date: null,
  }

  it('renders the Unassigned centre bucket and an em-dash date', async () => {
    respondWith({ rows: [NULL_ROW] })
    await renderPage()
    const rows = document.querySelectorAll('table tbody tr')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('Unassigned centre')
    expect(rows[0].textContent).toContain('Ineligible badge')
    // date cell is '—', never '' (which would collapse the column)
    expect(rows[0].querySelector('td[data-label="Date"]').textContent).toBe('—')
  })

  it('exports the same bucket, never a blank cell', async () => {
    respondWith({ rows: [NULL_ROW] })
    await renderPage()
    await clickExportAndGetFilename()
    expect(bookAppendSheet.mock.calls[0][1].rows[0]).toEqual({
      Rule: 'Ineligible badge',
      Badge: 'FB5971GA0003',
      Name: 'SUKH',
      Centre: 'Unassigned centre',
      Department: '—',
      Detail: 'Badge status ELDERLY is not OPEN/PERMANENT — scanned 2 time(s) this visit',
      Date: '—',
    })
  })

  it('shows an unknown server-side rule as a neutral pill rather than dropping it', async () => {
    respondWith({ rows: [{ ...NULL_ROW, rule: 'FUTURE_RULE', sewadar_centre: 'DELHI' }] })
    await renderPage()
    // The chip keeps the rule reachable, and the row is still shown. Scoped to
    // the feed table: the header ViewOnlyPill is also .pill-gray.
    expect(screen.getByText('FUTURE RULE (1)')).toBeTruthy()
    const pill = document.querySelector('table .pill-gray')
    expect(pill.textContent).toContain('FUTURE RULE')
  })
})

describe('cap-aware counts — a capped feed reads as a lower bound, never a census', () => {
  // The server caps each rule at 200 rows and the whole feed at 1000 (newest
  // first). A count sitting on a cap must render "200+" with a newest-rows
  // note — a bare 200 would read as an exact census.
  const bigRows = (rule, n, start = 0) => Array.from({ length: n }, (_, i) => ({
    rule,
    badge_number: `B${String(start + i).padStart(4, '0')}`,
    sewadar_name: `NAME${start + i}`,
    sewadar_centre: 'DELHI',
    dept_name: 'MEDICAL',
    detail: 'detail',
    event_date: '2026-09-23',
  }))

  it('renders 200+ on a chip sitting on the server cap, with a newest-rows note', async () => {
    respondWith({ rows: bigRows('UNDEPLOYED_SCAN', 200) })
    await renderPage()
    expect(screen.getByText('Undeployed scan (200+)')).toBeTruthy()
    expect(screen.getByText(/showing newest 200/i)).toBeTruthy()
  })

  it('keeps exact counts exact below the cap', async () => {
    respondWith({ rows: bigRows('UNDEPLOYED_SCAN', 3) })
    await renderPage()
    expect(screen.getByText('Undeployed scan (3)')).toBeTruthy()
    expect(screen.queryByText(/showing newest/i)).toBeNull()
  })

  it('renders 1000+ when the whole result hits the total cap', async () => {
    respondWith({ rows: [...bigRows('UNDEPLOYED_SCAN', 200), ...bigRows('STALE_OPEN', 800, 200)] })
    await renderPage()
    expect(screen.getByText('All (1000+)')).toBeTruthy()
    expect(screen.getByText(/showing newest 1000/i)).toBeTruthy()
  })

  it('exports capped counts with the cap note on the Counts sheet', async () => {
    respondWith({ rows: bigRows('UNDEPLOYED_SCAN', 200) })
    await renderPage()
    await clickExportAndGetFilename()
    const countsRows = bookAppendSheet.mock.calls[1][1].rows
    expect(countsRows[0]).toEqual({ Rule: 'Undeployed scan', Count: '200+' })
    expect(countsRows[countsRows.length - 1].Rule).toMatch(/showing newest 200/i)
  })
})
