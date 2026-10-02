// @vitest-environment jsdom
// LiveScannersPage — the smoke test, plus the three failures that are only
// visible with the component mounted, because each is a lie the pure helpers
// cannot see:
//
//   L1  `last_scan_time` is a bare IST wall clock for the queried DATE, so the
//       Active/Idle verdict depends on the page's own date + the current clock.
//       The clock is pinned below so the verdicts are deterministic.
//   L2  the drill-down must be LAZY — `attendance_scanner_open` may not be
//       called until a row is actually expanded, or opening the page would
//       fan out one RPC per scanner.
//   L3  a failed REFRESH must keep the last good rows and say the data is
//       stale. Blanking the table would read as "every scanner went offline".
//
// The mock setup mirrors src/pages/AttendancePage.test.jsx.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import LiveScannersPage from './LiveScannersPage'

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

// A STABLE toast object, deliberately — a fresh object per render() would spin
// the page's load effect forever. See the same note in AttendancePage.test.jsx.
const toast = { error: toastError, success: toastSuccess, warning: toastWarning, info: vi.fn() }

vi.mock('../components/Toast', () => ({
  useToast: () => toast,
}))

const SCHEDULES = [{ id: 'sched-1', name: 'October 2026 Visit' }]

// L1: the clock is pinned to 2026-09-23 10:00:00 IST. `scannerStatus` builds
// `${dateStr}T${lastScanTime}+05:30` and calls anything inside 15 minutes
// "active", so the two fixture times are chosen relative to 10:00 IST.
// ONLY Date is faked — setTimeout/setInterval stay real, so RTL's waitFor and
// the page's own debounce + 60s freshness tick still work.
const NOW = new Date('2026-09-23T04:30:00Z') // === 2026-09-23 10:00:00 +05:30
const DATE = '2026-09-23'
const ACTIVE_TIME = '09:52:00' // 8 minutes ago  → active
const IDLE_TIME = '07:10:00' // 170 minutes ago → idle

const SCANNERS = [
  {
    scanner_badge: 'SC01',
    scanner_name: 'Scanner One',
    scanner_centre: 'DELHI',
    scans_in: 12,
    scans_out: 9,
    open_now: 3,
    manual_scans: 1,
    first_in_time: '08:00:00',
    last_scan_time: ACTIVE_TIME,
  },
  {
    scanner_badge: 'SC02',
    scanner_name: 'Scanner Two',
    scanner_centre: 'FARIDABAD',
    scans_in: 4,
    scans_out: 4,
    open_now: 0,
    manual_scans: 0,
    first_in_time: '07:05:00',
    last_scan_time: IDLE_TIME,
  },
]

const OPEN_SESSIONS = [
  {
    badge_number: 'FB5971GA0001',
    sewadar_name: 'RAM',
    sewadar_centre: 'DELHI',
    dept_name: 'MEDICAL',
    in_date: DATE,
    in_time: '09:30:00',
  },
]

/** Resolve each RPC by name, so a refresh can swap one answer without the rest. */
function respondWith({ ops = SCANNERS, open = OPEN_SESSIONS } = {}) {
  rpc.mockImplementation((name) => {
    if (name === 'attendance_scanner_ops') return Promise.resolve({ data: ops, error: null })
    if (name === 'attendance_scanner_open') return Promise.resolve({ data: open, error: null })
    return Promise.resolve({ data: [], error: null })
  })
}

/**
 * Flush pending microtasks so the state updates queued by a fireEvent land.
 * Deliberately NOT `act(async () => …)`: the raw act() thenable deadlocks
 * against the 400ms realtime-debounce timer this page schedules, and
 * `waitFor` is the RTL-aware way to await a re-render anyway.
 */
const settle = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

/**
 * Render and wait until the loading gate has passed. Content-agnostic on
 * purpose: waiting for a specific string couples the test to the row fixture
 * and silently passes when the body happens to be empty.
 */
async function renderPage(props = {}) {
  const utils = render(<LiveScannersPage schedules={SCHEDULES} scheduleId="sched-1" {...props} />)
  await waitFor(() => expect(screen.queryByText('Loading scanner activity…')).toBeNull())
  return utils
}

const rows = () => document.querySelectorAll('table tbody tr')

beforeEach(() => {
  rpc.mockReset()
  toastError.mockReset()
  toastSuccess.mockReset()
  toastWarning.mockReset()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  respondWith()
})

// The project does not enable vitest `globals`, so @testing-library/react's
// automatic afterEach cleanup never registers — without this the DOM from every
// previous test would still be mounted and getByText would match twice.
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('Live Scanners — smoke', () => {
  it('renders the title and one Active and one Idle scanner', async () => {
    await renderPage()
    expect(screen.getByText('Live Scanners')).toBeTruthy()
    expect(rows()).toHaveLength(2)
    // Exact-string match: the "Active now" stat card reads as its own label, so
    // these are the two status pills and nothing else.
    expect(screen.getByText('Active')).toBeTruthy()
    expect(screen.getByText('Idle')).toBeTruthy()
  })

  it('filters the table by badge, name or centre', async () => {
    await renderPage()
    fireEvent.change(screen.getByLabelText('Search scanners'), { target: { value: 'faridabad' } })
    await settle()
    expect(rows()).toHaveLength(1)
    expect(rows()[0].textContent).toContain('SC02')
  })
})

describe('L2 — the open-session drill-down is fetched lazily', () => {
  it('does not call attendance_scanner_open until a row is expanded', async () => {
    await renderPage()
    // The summary RPC only — one round trip on open, not one per scanner.
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('attendance_scanner_ops', { p_schedule: 'sched-1', p_date: DATE })
  })

  it('lists that scanner\'s open sessions when the row is expanded', async () => {
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: /open sessions for scanner one/i }))
    await waitFor(() => expect(screen.getByText('RAM')).toBeTruthy())
    expect(rpc).toHaveBeenCalledWith('attendance_scanner_open', {
      p_schedule: 'sched-1',
      p_scanner_badge: 'SC01',
    })
    expect(screen.getByText('FB5971GA0001')).toBeTruthy()
  })

  it('shows an empty state, not a blank panel, when nothing is open', async () => {
    respondWith({ open: [] })
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: /open sessions for scanner one/i }))
    await waitFor(() => expect(screen.getByText(/no open sessions/i)).toBeTruthy())
  })
})

describe('L3 — a failed refresh keeps the last good rows', () => {
  it('flags the data as stale instead of blanking the table', async () => {
    await renderPage()
    expect(rows()).toHaveLength(2)

    rpc.mockImplementation(() => Promise.resolve({ data: null, error: { message: 'boom' } }))
    fireEvent.click(screen.getByText('Refresh'))
    await waitFor(() => expect(screen.getByText(/stale/i)).toBeTruthy())
    expect(rows()).toHaveLength(2)
  })
})

describe('I5 — an expanded drill-down refreshes with the list', () => {
  it('re-fetches open sessions when the list reloads while expanded', async () => {
    // I5: the panel cached its rows forever — closed sessions stayed listed
    // even after the scanner row itself updated to Open 0.
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: /open sessions for scanner one/i }))
    await waitFor(() => expect(screen.getByText('RAM')).toBeTruthy())
    const openCalls = () => rpc.mock.calls.filter((c) => c[0] === 'attendance_scanner_open').length
    expect(openCalls()).toBe(1)
    fireEvent.click(screen.getByText('Refresh'))
    await waitFor(() => expect(openCalls()).toBe(2))
  })
})

describe('scanned — a valid scan on a non-today date is neutral, never Idle', () => {
  // The same last_scan_time that reads Active/Idle on the scan day itself must
  // read as a neutral "Scanned HH:MM" pill on any other day: amber Idle claims
  // the scanner "went quiet today", which is the wrong claim for a past visit
  // day. The pinned clock is 2026-09-23 10:00 IST, so 2026-09-22 is not today.
  async function renderPastDay() {
    await renderPage()
    fireEvent.change(screen.getByLabelText('Scan day'), { target: { value: '2026-09-22' } })
    await waitFor(() => expect(screen.getByText('Scanned 09:52')).toBeTruthy())
  }

  it('renders the neutral Scanned pill instead of amber Idle', async () => {
    await renderPastDay()
    const pill = screen.getByText('Scanned 09:52')
    expect(pill.className).toContain('pill-gray')
    expect(pill.className).not.toContain('pill-amber')
    expect(screen.getByText('Scanned 07:10')).toBeTruthy()
    expect(screen.queryByText('Idle')).toBeNull()
  })

  it('keeps Active-now at active-only with a date-aware sub on a past day', async () => {
    await renderPastDay()
    const tile = screen.getByText('Active now').closest('.stat')
    expect(tile.querySelector('.stat-value').textContent).toBe('0')
    expect(tile.querySelector('.stat-sub').textContent).toMatch(/last scan/i)
  })

  it('keeps the "in the last 15 min" sub on the scan day itself', async () => {
    await renderPage()
    const tile = screen.getByText('Active now').closest('.stat')
    expect(tile.querySelector('.stat-value').textContent).toBe('1')
    expect(tile.querySelector('.stat-sub').textContent).toMatch(/last 15 min/i)
  })

  it('exports the Scanned label so the sheet matches the screen', async () => {
    const xlsx = await import('xlsx')
    xlsx.utils.book_append_sheet.mockClear()
    await renderPastDay()
    fireEvent.click(screen.getByText(/Export Excel/))
    await waitFor(() => expect(xlsx.utils.book_append_sheet).toHaveBeenCalled())
    const rows = xlsx.utils.book_append_sheet.mock.calls[0][1].rows
    expect(rows[0].Status).toBe('Scanned 09:52')
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

describe('C2 — exports use the shared driver naming (L-24/L-25)', () => {
  it('writes a slugged {schedule}_{date}_scanners.xlsx filename', async () => {
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
      // Schedule "October 2026 Visit" must not land in the filename with raw
      // spaces. Date is clock-pinned to 2026-09-23 in this file.
      expect(downloaded).toBe('October_2026_Visit_2026-09-23_scanners.xlsx')
    } finally {
      clickSpy.mockRestore()
    }
  })
})
