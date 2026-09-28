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
  fetchCentres: () => Promise.resolve(CENTRES),
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
