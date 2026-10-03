// @vitest-environment jsdom
// ReportsPage — contract tests for the shared day-badges Reports page
// (dept_incharge + aso/super_admin). The mock setup mirrors
// src/pages/AttendancePage.test.jsx: supabase-js rpc, a STABLE toast object
// (a toast mock that builds a fresh object per render() re-triggers the
// page's load effect forever), the real exportWorkbook contract (number of
// non-empty sheets), and a hoisted auth profile so each test can act as a
// different role.
//
// These pin the things a mounted component can get wrong that a pure helper
// never sees:
//   1. BOTH `attendance_day_badges` modes (present + absent) are requested —
//      via Promise.allSettled, THROWING on a returned `{ error }`;
//   2. the Complete / Present / Absent tabs render with a Status column;
//   3. the centre filter narrows every tab;
//   4. aso/super_admin/dept_incharge get "Download Excel" (one sheet per
//      centre) AND "Export PDF"; the PDF also carries window.print +
//      the print-only .centre-page sections — scope itself is never
//      filtered client-side.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import ReportsPage from './ReportsPage'

const rpc = vi.fn()
// Delegates to `rpc` fixtures, upholding the real fetchAllRpc contract:
// a resolved `{ error }` THROWS instead of returning rows (the page's error
// panel tests drive errors through this path exactly as production does).
const fetchAllRpc = vi.fn(async (name, params) => {
  const res = await rpc(name, params)
  if (res?.error) throw res.error
  return Array.isArray(res?.data) ? res.data : []
})
const toastError = vi.fn()
const toastSuccess = vi.fn()
const toastWarning = vi.fn()

vi.mock('../lib/supabase', () => ({
  supabase: {
    rpc: (...args) => rpc(...args),
  },
  fetchAllRpc: (...args) => fetchAllRpc(...args),
}))

// Hoisted so tests can switch roles per case (vi.mock factories are hoisted
// past module-level `let`, so a plain variable would read as uninitialized).
const authState = vi.hoisted(() => ({ profile: { role: 'aso' } }))
vi.mock('../context/PortalAuthContext', () => ({
  usePortalAuth: () => ({ profile: authState.profile }),
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

// Exactly as attendance_day_badges returns: the `sewadar_centre` home centre
// (never the scan venue), `dept_name`, and the VSS flag.
const PRESENT = [
  { badge_number: 'FB5971GA0001', sewadar_name: 'RAM', sewadar_centre: 'DELHI', dept_name: 'MEDICAL', is_vss: false },
  { badge_number: 'FB5971GA0002', sewadar_name: 'SHAM', sewadar_centre: 'DELHI-1', dept_name: 'MEDICAL', is_vss: true },
]
const ABSENT = [
  { badge_number: 'FB5971GA0003', sewadar_name: 'MOHAN', sewadar_centre: 'DELHI', dept_name: 'COOKING', is_vss: false },
]

/** Queue one resolved result per RPC mode, keyed on `p_mode`. */
function respondWith({ present = PRESENT, absent = ABSENT } = {}) {
  rpc.mockImplementation((name, params) => {
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

function tableHeads() {
  return [...document.querySelectorAll('.card table thead th')].map((th) => th.textContent)
}

function tableBody() {
  return [...document.querySelectorAll('.card table tbody tr')].map((tr) => tr.textContent)
}

beforeEach(() => {
  rpc.mockReset()
  toastError.mockReset()
  toastSuccess.mockReset()
  toastWarning.mockReset()
  exportWorkbook.mockClear()
  authState.profile = { role: 'aso' }
  window.print = vi.fn()
  respondWith()
})

afterEach(() => {
  cleanup()
})

describe('ReportsPage — data contract', () => {
  it('requests BOTH day-badges modes for the schedule + day', async () => {
    await renderPage()
    expect(rpc).toHaveBeenCalledWith(
      'attendance_day_badges',
      expect.objectContaining({ p_schedule: 'sched-1', p_mode: 'present' }),
    )
    expect(rpc).toHaveBeenCalledWith(
      'attendance_day_badges',
      expect.objectContaining({ p_schedule: 'sched-1', p_mode: 'absent' }),
    )
    const presentCall = rpc.mock.calls.find(([, p]) => p?.p_mode === 'present')
    expect(presentCall[1].p_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('renders the title, a View-only pill and three tabs with counts', async () => {
    await renderPage()
    expect(screen.getByRole('heading', { name: /Reports/i })).toBeTruthy()
    expect(screen.getByText('View-only')).toBeTruthy()
    expect(screen.getByRole('tab', { name: /Complete List \(3\)/i })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /Present \(2\)/i })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /Absent \(1\)/i })).toBeTruthy()
  })
})

describe('ReportsPage — tabs carry a Status column', () => {
  it('shows Status with both values on the Complete List', async () => {
    await renderPage()
    expect(tableHeads()).toContain('Status')
    const body = tableBody()
    expect(body.some((t) => t.includes('RAM') && t.includes('Present'))).toBe(true)
    expect(body.some((t) => t.includes('MOHAN') && t.includes('Absent'))).toBe(true)
  })

  it('keeps the Status column on the Present and Absent tabs', async () => {
    await renderPage()
    fireEvent.click(screen.getByRole('tab', { name: /Present \(/i }))
    expect(tableHeads()).toContain('Status')
    expect(tableBody()).toHaveLength(2)
    expect(tableBody().every((t) => t.includes('Present'))).toBe(true)
    fireEvent.click(screen.getByRole('tab', { name: /Absent \(/i }))
    expect(tableHeads()).toContain('Status')
    expect(tableBody()).toHaveLength(1)
    expect(tableBody()[0]).toContain('MOHAN')
    expect(tableBody()[0]).toContain('Absent')
  })

  it('sorts centre, then name, then badge', async () => {
    await renderPage()
    const badges = [...document.querySelectorAll('.card table tbody tr td:first-child')]
      .map((td) => td.textContent)
    // DELHI before DELHI-1; MOHAN before RAM within DELHI.
    expect(badges).toEqual(['FB5971GA0003', 'FB5971GA0001', 'FB5971GA0002'])
  })
})

describe('ReportsPage — filters narrow every tab', () => {
  it('centre filter narrows rows and tab counts', async () => {
    await renderPage()
    fireEvent.change(screen.getByLabelText('Filter by centre'), { target: { value: 'DELHI-1' } })
    expect(screen.getByRole('tab', { name: /Complete List \(1\)/i })).toBeTruthy()
    expect(tableBody()).toHaveLength(1)
    expect(tableBody()[0]).toContain('SHAM')
    fireEvent.click(screen.getByRole('tab', { name: /Present \(/i }))
    expect(tableBody()).toHaveLength(1)
    fireEvent.click(screen.getByRole('tab', { name: /Absent \(/i }))
    expect(screen.getByText(/No absent sewadars/i)).toBeTruthy()
  })

  it('search narrows across badge / name / dept', async () => {
    await renderPage()
    fireEvent.change(screen.getByLabelText('Search reports'), { target: { value: 'mohan' } })
    expect(tableBody()).toHaveLength(1)
    expect(tableBody()[0]).toContain('MOHAN')
  })
})

describe('ReportsPage — role download', () => {
  it('aso gets Download Excel with one sheet per centre', async () => {
    await renderPage()
    // The day-badges feed runs through the paginating helper — "Showing N of
    // M" and every workbook sheet are complete, never a 1000-row prefix.
    expect(fetchAllRpc.mock.calls.map(([n]) => n)).toContain('attendance_day_badges')
    const btn = screen.getByRole('button', { name: /Download Excel/i })
    expect(btn).toBeTruthy()
    // PDF is offered BESIDE Excel, not instead of it.
    expect(screen.getByRole('button', { name: /Export PDF/i })).toBeTruthy()
    fireEvent.click(btn)
    await waitFor(() => expect(exportWorkbook).toHaveBeenCalled())
    const [filename, sheets] = exportWorkbook.mock.calls[0]
    expect(filename).toMatch(/October_2026_Visit/)
    // One sheet per centre — sheet names stay the raw centre names (the
    // ≤31-char trim happens inside exportWorkbook via sheetName()).
    expect(sheets.map((s) => s.name).sort()).toEqual(['DELHI', 'DELHI-1'])
    const delhi = sheets.find((s) => s.name === 'DELHI')
    expect(Object.keys(delhi.rows[0]).sort()).toEqual(['Badge', 'Centre', 'Dept', 'Name', 'Status', 'Type'])
    const ram = delhi.rows.find((r) => r.Badge === 'FB5971GA0001')
    expect(ram).toMatchObject({ Name: 'RAM', Centre: 'DELHI', Dept: 'MEDICAL', Type: 'Regular', Status: 'Present' })
    expect(delhi.rows.find((r) => r.Badge === 'FB5971GA0003').Status).toBe('Absent')
    expect(sheets.find((s) => s.name === 'DELHI-1').rows[0]).toMatchObject({ Type: 'VSS', Status: 'Present' })
  })

  it('super_admin gets Download Excel too', async () => {
    authState.profile = { role: 'super_admin' }
    await renderPage()
    expect(screen.getByRole('button', { name: /Download Excel/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Export PDF/i })).toBeTruthy()
  })

  it('dept_incharge gets Download Excel, Export PDF, per-centre print sections', async () => {
    authState.profile = { role: 'dept_incharge' }
    await renderPage()
    // Excel is no longer aso-only: dept_incharge exports the SAME workbook
    // from the same role-scoped RPC rows.
    const excelBtn = screen.getByRole('button', { name: /Download Excel/i })
    expect(excelBtn).toBeTruthy()
    const printBtn = screen.getByRole('button', { name: /Export PDF/i })
    fireEvent.click(printBtn)
    expect(window.print).toHaveBeenCalled()
    // Print-only output: one .centre-page section per centre with the same
    // Badge/Name/Centre/Dept/Type/Status columns.
    const sections = document.querySelectorAll('.print-only .centre-page')
    expect(sections).toHaveLength(2)
    const heads = [...sections[0].querySelectorAll('thead th')].map((th) => th.textContent)
    expect(heads).toEqual(['Badge', 'Name', 'Centre', 'Dept', 'Type', 'Status'])
    // Per-centre sheet assertions: the dept_incharge workbook is non-empty
    // and split exactly like the ASO one.
    fireEvent.click(excelBtn)
    await waitFor(() => expect(exportWorkbook).toHaveBeenCalled())
    const [filename, sheets] = exportWorkbook.mock.calls.at(-1)
    expect(filename).toMatch(/October_2026_Visit/)
    expect(sheets.map((s) => s.name).sort()).toEqual(['DELHI', 'DELHI-1'])
    expect(sheets.every((s) => s.rows.length > 0)).toBe(true)
  })

  it('warns instead of exporting when no rows match', async () => {
    await renderPage()
    fireEvent.change(screen.getByLabelText('Search reports'), { target: { value: 'ZZZ-no-such-place' } })
    await waitFor(() => expect(screen.getByText(/No attendance records/i)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Download Excel/i }))
    await waitFor(() => expect(toastWarning).toHaveBeenCalledWith(expect.stringMatching(/nothing to export/i)))
    expect(exportWorkbook).not.toHaveBeenCalled()
  })
})

describe('ReportsPage — a failed RPC is never a silent empty report', () => {
  it('renders a visible error panel when the RPC resolves an error', async () => {
    // supabase-js RESOLVES { error }; it does not reject. Both arms failing
    // must not look like "nobody came".
    rpc.mockImplementation(() => Promise.resolve({ data: null, error: { message: 'function does not exist' } }))
    await renderPage()
    const alerts = screen.getAllByRole('alert')
    expect(alerts.length).toBeGreaterThan(0)
    expect(alerts[0].textContent).toMatch(/could not load/i)
    expect(document.querySelectorAll('.card table tbody tr')).toHaveLength(0)
  })

  it('keeps the healthy arm when only one mode fails', async () => {
    rpc.mockImplementation((name, params) => {
      if (name === 'attendance_day_badges' && params?.p_mode === 'absent') {
        return Promise.resolve({ data: null, error: { message: 'boom' } })
      }
      return Promise.resolve({ data: PRESENT, error: null })
    })
    await renderPage()
    expect(screen.getByRole('alert').textContent).toMatch(/could not load absent/i)
    // The present rows still render on the Complete tab.
    expect(tableBody().some((t) => t.includes('RAM'))).toBe(true)
  })
})

describe('ReportsPage — layout contract', () => {
  it('labels every cell for the ≤640px card collapse', async () => {
    await renderPage()
    const cells = document.querySelectorAll('.card table tbody td')
    expect(cells.length).toBeGreaterThan(0)
    expect([...cells].every((td) => td.hasAttribute('data-label'))).toBe(true)
  })

  it('pins the table header inside a sticky scroll wrapper', async () => {
    await renderPage()
    expect(document.querySelector('.card .table-wrap-sticky')).toBeTruthy()
    expect(document.querySelector('.card table.table-sticky')).toBeTruthy()
  })

  it('labels every filter on one baseline row', async () => {
    const { container } = await renderPage()
    const labels = [...container.querySelectorAll('.previsit-toolbar .previsit-label')].map((el) => el.textContent)
    expect(labels).toEqual(['Scan day', 'Centre', 'Search'])
  })

  it('offers Clear filters on a filtered-out empty state and restores rows', async () => {
    await renderPage()
    fireEvent.change(screen.getByLabelText('Search reports'), { target: { value: 'ZZZ-no-such-place' } })
    await waitFor(() => expect(screen.getByText(/No attendance records/i)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    await waitFor(() => expect(tableBody().some((t) => t.includes('RAM'))).toBe(true))
  })
})
