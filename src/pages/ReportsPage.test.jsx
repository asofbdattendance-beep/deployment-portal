// @vitest-environment jsdom
// ReportsPage — smoke + contract tests. The mock setup mirrors
// src/pages/AttendancePage.test.jsx (which it also mirrors visually): an inert
// realtime channel and a STABLE toast object, because a toast mock that builds a
// fresh object per render() re-triggers the page's load effect forever and hangs
// every test here for a reason that does not exist in production.
//
// These pin the three things a mounted component can get wrong that a pure
// helper never sees:
//   1. the page renders its title and BOTH download affordances;
//   2. attendance_visit_summary rows reach the department matrix, with a TOTAL
//      footer — i.e. the RPC result is actually wired to the view;
//   3. a RESOLVED `{ error }` (supabase-js does not reject) renders a visible
//      error panel instead of a silent, fully-zeroed empty report.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import ReportsPage from './ReportsPage'

const rpc = vi.fn()
const toastError = vi.fn()
const toastSuccess = vi.fn()
const toastWarning = vi.fn()
const fetchCentresMock = vi.fn(() => Promise.resolve(CENTRES))

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
  fetchCentres: (...args) => fetchCentresMock(...args),
}))

const toast = { error: toastError, success: toastSuccess, warning: toastWarning, info: vi.fn() }

// The real writer touches anchor downloads — mirror its contract instead:
// number of non-empty sheets (empty sheets are skipped, 0 means no file).
const exportWorkbook = vi.fn(async (filename, sheets) => sheets.filter((s) => s.rows.length > 0).length)
vi.mock('../lib/excel', () => ({
  exportWorkbook: (...args) => exportWorkbook(...args),
  fileSlug: (s) => String(s ?? 'schedule').replace(/[^A-Za-z0-9._-]+/g, '_'),
}))
vi.mock('../components/Toast', () => ({
  useToast: () => toast,
}))

const SCHEDULES = [
  { id: 'sched-1', name: 'October 2026 Visit' },
  { id: 'sched-2', name: 'November 2026 Visit' },
]

// One row per centre x department, exactly as attendance_visit_summary returns.
// DELHI is a parent CENTRE, DELHI-1 its child — the matrix must roll the child
// into the parent until opened.
const VISIT = [
  { centre: 'DELHI', department_id: 'd1', dept_name: 'MEDICAL', deployed: 4, ever_present: 3, never_present: 1, open_now: 0 },
  { centre: 'DELHI-1', department_id: 'd1', dept_name: 'MEDICAL', deployed: 6, ever_present: 5, never_present: 1, open_now: 1 },
  { centre: 'DELHI-1', department_id: 'd2', dept_name: 'COOKING', deployed: 2, ever_present: 2, never_present: 0, open_now: 0 },
]
// dp_centres rows, exactly as fetchCentres returns them.
const CENTRES = [
  { id: 'c1', name: 'DELHI', parent_centre: '' },
  { id: 'c2', name: 'DELHI-1', parent_centre: 'DELHI' },
]
const DAILY = [
  { centre: 'DELHI', department_id: 'd1', dept_name: 'MEDICAL', expected: 4, present: 3, absent: 1, open_now: 0 },
]
const PRESENT_BADGES = [
  { badge_number: 'FB5971GA0001', sewadar_name: 'RAM', sewadar_centre: 'DELHI', department_id: 'd1', dept_name: 'MEDICAL', is_vss: false },
]
const ABSENT_BADGES = [
  { badge_number: 'FB5971GA0002', sewadar_name: 'SHAM', sewadar_centre: 'DELHI', department_id: 'd1', dept_name: 'MEDICAL', is_vss: false },
]

/** Queue one resolved result per RPC, keyed on the name the page actually calls. */
function respondWith({ visit = VISIT, daily = DAILY, present = PRESENT_BADGES, absent = ABSENT_BADGES } = {}) {
  rpc.mockImplementation((name, params) => {
    if (name === 'attendance_visit_summary') return Promise.resolve({ data: visit, error: null })
    if (name === 'attendance_daily_summary') return Promise.resolve({ data: daily, error: null })
    if (name === 'attendance_day_badges') {
      return Promise.resolve({ data: params?.p_mode === 'absent' ? absent : present, error: null })
    }
    return Promise.resolve({ data: [], error: null })
  })
}

async function settle() {
  await waitFor(() => {
    expect(document.querySelector('.spin')).toBeNull()
  })
}

async function renderPage(props = {}) {
  const utils = render(<ReportsPage schedules={SCHEDULES} scheduleId="sched-1" {...props} />)
  await waitFor(() => expect(rpc).toHaveBeenCalled())
  await settle()
  return utils
}

beforeEach(() => {
  rpc.mockReset()
  toastError.mockReset()
  toastSuccess.mockReset()
  toastWarning.mockReset()
  exportWorkbook.mockClear()
  fetchCentresMock.mockReset()
  fetchCentresMock.mockResolvedValue(CENTRES)
  respondWith()
})

afterEach(() => {
  cleanup()
})

describe('ReportsPage — renders', () => {
  it('shows the Reports title and both download buttons', async () => {
    await renderPage()
    expect(screen.getByRole('heading', { name: /Reports/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Download Present/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Download Absent/i })).toBeTruthy()
  })

  it('renders departments across the top with collapsed parent aggregates and a TOTAL footer', async () => {
    await renderPage()
    // Header: Centre first, then one column per department, then the totals.
    const heads = [...document.querySelectorAll('table thead th')].map((th) => th.textContent)
    expect(heads[0]).toContain('Centre')
    expect(heads).toContain('MEDICAL')
    expect(heads).toContain('COOKING')
    const body = [...document.querySelectorAll('table tbody tr')].map((tr) => tr.textContent)
    // Collapsed: one DELHI (+1) aggregate row, no DELHI-1 row yet.
    expect(body.some((t) => t.includes('(+1)'))).toBe(true)
    expect(body.some((t) => t.includes('DELHI-1'))).toBe(false)
    // Aggregate: 4+6+2 deployed, 3+5+2 present → cells read "10/12".
    const agg = body.find((t) => t.includes('(+1)'))
    expect(agg).toContain('10/12')
    expect(body.filter((t) => t.includes('TOTAL'))).toHaveLength(1)
  })

  it('puts a table-free department summary above the matrix and heat-tints the cells', async () => {
    await renderPage()
    // One table in the whole document — the strip must never become a table.
    expect(document.querySelectorAll('table')).toHaveLength(1)
    const strip = screen.getByTestId('dept-strip')
    expect(strip.querySelectorAll('table')).toHaveLength(0)
    // Strict document order: the department-wise strip precedes the matrix.
    const table = document.querySelector('table')
    expect(strip.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Heat cells keep the numbers and carry their band as data, not text.
    const cell = document.querySelector('table tbody td[data-label="MEDICAL"]')
    expect(cell.textContent.replace(/\s/g, '')).toContain('8/10')
    expect(['full', 'partial', 'low', 'none']).toContain(cell.getAttribute('data-band'))
    expect(cell.getAttribute('title')).toMatch(/of \d+ scanned/)
    // The TOTAL footer stays the last body row of that same table.
    const rows = [...document.querySelectorAll('table tbody tr')]
    expect(rows[rows.length - 1].textContent).toContain('TOTAL')
  })

  it('expanding a parent splits the aggregate into its own row plus children', async () => {
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: /expand DELHI/i }))
    const body = [...document.querySelectorAll('table tbody tr')].map((tr) => tr.textContent)
    // The split: DELHI's own 3/4 plus DELHI-1's 7/8.
    const child = body.find((t) => t.includes('DELHI-1'))
    expect(child).toContain('7/8')
    const own = body.find((t) => t.includes('DELHI') && !t.includes('DELHI-1') && !t.includes('(+1)') && !t.includes('TOTAL'))
    expect(own).toContain('3/4')
    // .. and the split still adds up to the collapsed aggregate.
    expect(body.some((t) => t.includes('(+1)'))).toBe(false)
  })

  it('shows filtered totals in the KPI tiles when a centre filter is set', async () => {
    // I1: tiles read unfiltered matrix.totals while the matrix below reads
    // visibleTotals — under a filter the two contradicted each other.
    // Fixtures: DELHI 4 + DELHI-1 6+2 = 12 deployed; DELHI-1 alone = 8.
    await renderPage()
    fireEvent.change(screen.getByLabelText('Filter by centre'), { target: { value: 'DELHI-1' } })
    const tile = screen.getByText('Deployed').closest('.stat')
    expect(tile.querySelector('.stat-value').textContent).toBe('8')
  })

  it('warns instead of claiming success when the badge list is empty', async () => {
    // I2: the Summary sheet always carries a TOTAL row, so `written` never
    // hit 0 and an empty list still toasted "Absent list exported".
    respondWith({ absent: [] })
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: /Download Absent/i }))
    await waitFor(() => expect(toastWarning).toHaveBeenCalledWith(expect.stringMatching(/no absent/i)))
    expect(toastSuccess).not.toHaveBeenCalledWith(expect.stringMatching(/absent list exported/i))
  })
})

describe('ReportsPage — a failed RPC is never a silent empty report', () => {
  it('renders a visible error panel when the RPC resolves an error', async () => {
    // supabase-js RESOLVES { error }; it does not reject. A missing function
    // (PGRST202) or an RLS denial must not look like "nobody came".
    rpc.mockImplementation(() => Promise.resolve({ data: null, error: { message: 'function does not exist' } }))
    await renderPage()
    expect(screen.getByRole('alert').textContent).toMatch(/could not load reports/i)
    expect(document.querySelectorAll('table tbody tr')).toHaveLength(0)
  })
})

describe('ReportsPage — date currency (rows never shown under the wrong date)', () => {
  it('hides stale rows and disables downloads while a new date loads', async () => {
    await renderPage()
    expect(document.querySelector('table')).toBeTruthy()
    // Gate every RPC behind a deferred: the new date is loading, the old rows
    // must already be gone.
    let release
    const gate = new Promise((res) => { release = res })
    rpc.mockImplementation(() => gate)
    fireEvent.change(screen.getByLabelText('Report day'), { target: { value: '2026-09-24' } })
    // Skeleton, not the previous day's matrix under the new date.
    await waitFor(() => expect(screen.queryByText('Loading reports…')).toBeTruthy())
    expect(document.querySelector('table')).toBeNull()
    // No download affordance at all while the new date loads — the skeleton
    // early-returns the whole header, so there is nothing stale to click.
    expect(screen.queryByRole('button', { name: /Download Present/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /Download Absent/i })).toBeNull()
    // Drain so no 15s withTimeout timer dangles past the test.
    release({ data: [], error: null })
    await waitFor(() => expect(screen.queryByText('Loading reports…')).toBeNull())
  })

  it('disables downloads during a same-date refresh', async () => {
    // Same schedule+date: rows stay current (no skeleton) but `loading` alone
    // must gate the buttons until the refresh lands.
    await renderPage()
    expect(screen.getByRole('button', { name: /Download Present/i }).disabled).toBe(false)
    let release
    const gate = new Promise((res) => { release = res })
    rpc.mockImplementation(() => gate)
    fireEvent.click(screen.getByRole('button', { name: /Refresh/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Download Present/i }).disabled).toBe(true))
    expect(screen.getByRole('button', { name: /Download Absent/i }).disabled).toBe(true)
    release({ data: [], error: null })
    await waitFor(() => expect(screen.getByRole('button', { name: /Download Present/i }).disabled).toBe(false))
  })

  it('stamps the new date on failure instead of leaving the old rows current', async () => {    await renderPage()
    rpc.mockImplementation(() => Promise.resolve({ data: null, error: { message: 'boom' } }))
    fireEvent.change(screen.getByLabelText('Report day'), { target: { value: '2026-09-24' } })
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByText(/could not load reports/i)).toBeTruthy()
    expect(document.querySelector('table')).toBeNull()
  })
})

describe('ReportsPage — export summary follows the active view + filters', () => {
  it('builds the Visit summary from the visit rows with an Open now column', async () => {
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: /Download Present/i }))
    await waitFor(() => expect(exportWorkbook).toHaveBeenCalled())
    const summary = exportWorkbook.mock.calls[0][1].find((s) => s.name.startsWith('Summary'))
    // DELHI/MEDICAL 4, DELHI-1/MEDICAL 6, DELHI-1/COOKING 2, plus the TOTAL.
    expect(summary.rows).toHaveLength(4)
    const delhi = summary.rows.find((r) => r.Centre === 'DELHI' && r.Department === 'MEDICAL')
    expect(delhi.Deployed).toBe(4)
    expect(delhi['Ever present']).toBe(3)
    expect(delhi['Never present']).toBe(1)
    expect(delhi['Open now']).toBe(0)
    const total = summary.rows.find((r) => r.Centre === 'TOTAL')
    expect(total.Deployed).toBe(12)
    expect(total['Open now']).toBe(1)
  })

  it('applies the centre filter to the summary rows, not just the detail list', async () => {
    await renderPage()
    fireEvent.change(screen.getByLabelText('Filter by centre'), { target: { value: 'DELHI-1' } })
    fireEvent.click(screen.getByRole('button', { name: /Download Present/i }))
    await waitFor(() => expect(exportWorkbook).toHaveBeenCalled())
    const summary = exportWorkbook.mock.calls[0][1].find((s) => s.name.startsWith('Summary'))
    // Two DELHI-1 rows plus the TOTAL — the DELHI-only row is gone.
    expect(summary.rows).toHaveLength(3)
    expect(summary.rows.every((r) => r.Centre === 'DELHI-1' || r.Centre === 'TOTAL')).toBe(true)
  })

  it('builds the Day summary from the daily rows in the Today view', async () => {
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: /^Today$/i }))
    fireEvent.click(screen.getByRole('button', { name: /Download Present/i }))
    await waitFor(() => expect(exportWorkbook).toHaveBeenCalled())
    const summary = exportWorkbook.mock.calls[0][1].find((s) => s.name.startsWith('Summary'))
    const row = summary.rows.find((r) => r.Centre === 'DELHI')
    expect(row.Expected).toBe(4)
    expect(row.Present).toBe(3)
    expect(row['Open now']).toBe(0)
  })
})

describe('ReportsPage — rates clamp to 0..100', () => {
  it('renders 100%, never 120%, for an over-count day', async () => {
    respondWith({ daily: [{ centre: 'DELHI', department_id: 'd1', dept_name: 'MEDICAL', expected: 10, present: 12, absent: 0, open_now: 0 }] })
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: /^Today$/i }))
    await waitFor(() => expect(document.body.textContent).toContain('100%'))
    expect(document.body.textContent).not.toContain('120%')
  })
})

describe('ReportsPage — search honesty', () => {
  it('says no rows match instead of shipping an empty export', async () => {
    await renderPage()
    fireEvent.change(screen.getByLabelText('Search reports'), { target: { value: 'ZZZ-no-such-place' } })
    await waitFor(() => expect(screen.getByText(/No rows match the current filters/i)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Download Present/i }))
    await waitFor(() => expect(toastWarning).toHaveBeenCalledWith(expect.stringMatching(/no rows match/i)))
    expect(exportWorkbook).not.toHaveBeenCalled()
  })

  it('describes exactly what the filter pill covers', async () => {
    await renderPage()
    fireEvent.change(screen.getByLabelText('Search reports'), { target: { value: 'DELHI' } })
    const pill = await screen.findByText(/in the matrix/i)
    expect(pill.title).toMatch(/badge\/name/i)
  })
})

describe('ReportsPage — centres reference data never blanks the filters', () => {
  it('keeps the last good centres when a refresh fails to fetch them', async () => {
    await renderPage()
    expect(screen.getByLabelText('Filter by centre').textContent).toContain('DELHI')
    fetchCentresMock.mockRejectedValueOnce(new Error('centres down'))
    fireEvent.click(screen.getByRole('button', { name: /Refresh/i }))
    // visit + daily re-fire (2 initial + 2 refresh); the failed centres fetch
    // must not blank the options or raise the error panel.
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(4))
    expect(screen.getByLabelText('Filter by centre').textContent).toContain('DELHI')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
