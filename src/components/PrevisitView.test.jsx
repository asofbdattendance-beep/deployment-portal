// @vitest-environment jsdom
// PrevisitView — the defects a mounted test catches that pure shapers cannot:
//
//   P1  the sewa-day selector defaults to nothing (or the wrong day), so a
//       page with data renders the "no previsit sewa" empty state.
//   P2  a failed RPC resolves as clean empty rows (the A11 lie) instead of
//       a visible error.
//   P3  rows from the previous schedule linger while the new one loads.
//   P4  the "All sewa days" option cannot be selected (the old select
//       snapped back to the newest day).
//   P5  register cells carry no data-label, so the ≤640px card collapse
//       renders values with blank labels.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import PrevisitView from './PrevisitView'

const rpc = vi.fn()
const toastError = vi.fn()
const toastSuccess = vi.fn()

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

const toast = { error: toastError, success: toastSuccess, warning: vi.fn(), info: vi.fn() }
vi.mock('../components/Toast', () => ({
  useToast: () => toast,
}))

const exportWorkbook = vi.fn()
vi.mock('../lib/excel', () => ({
  fileSlug: (s) => String(s || 'x').toLowerCase().replace(/\s+/g, '-'),
  exportWorkbook: (...args) => exportWorkbook(...args),
}))

vi.mock('../lib/realtime', () => ({
  reportRealtimeStatus: () => {},
}))

const SCHEDULES = [{ id: 'sched-1', name: 'October 2026 Visit' }]

const SUMMARY = [
  { event_date: '2026-10-06', centre: 'CENTRE A', department_id: 'd1', dept_name: 'MEDICAL', present: 2, open_now: 1 },
  { event_date: '2026-10-05', centre: 'CENTRE A', department_id: 'd1', dept_name: 'MEDICAL', present: 1, open_now: 0 },
]

// v64 grouped shape: one row per (day, badge) — first IN, last OUT,
// summed minutes (NULL while open), session_count, is_open.
const SEWADARS = [
  { event_date: '2026-10-06', badge_number: 'B1', sewadar_name: 'Asha', sewadar_centre: 'CENTRE A', department_id: 'd1', dept_name: 'MEDICAL', is_vss: false, in_time: '09:00:00', out_time: '12:00:00', duration_min: 180, is_manual: false, undeployed: false, session_count: 1, is_open: false },
  { event_date: '2026-10-06', badge_number: 'B2', sewadar_name: 'Bina', sewadar_centre: 'CENTRE B', department_id: 'd1', dept_name: 'MEDICAL', is_vss: false, in_time: '09:05:00', out_time: null, duration_min: null, is_manual: false, undeployed: false, session_count: 1, is_open: true },
  { event_date: '2026-10-05', badge_number: 'B3', sewadar_name: 'Chand', sewadar_centre: 'CENTRE A', department_id: 'd1', dept_name: 'MEDICAL', is_vss: false, in_time: '10:00:00', out_time: '11:00:00', duration_min: 60, is_manual: false, undeployed: true, session_count: 2, is_open: false },
]

const DEPLOYED = [
  { badge_number: 'B1', sewadar_name: 'Asha', sewadar_centre: 'CENTRE A', department_id: 'd1', dept_name: 'MEDICAL', is_vss: false },
  { badge_number: 'B2', sewadar_name: 'Bina', sewadar_centre: 'CENTRE B', department_id: 'd1', dept_name: 'MEDICAL', is_vss: false },
  { badge_number: 'B4', sewadar_name: 'Dev', sewadar_centre: 'CENTRE A', department_id: 'd1', dept_name: 'MEDICAL', is_vss: false },
]

function mockRpc(summary = SUMMARY, sewadars = SEWADARS, deployed = DEPLOYED) {
  rpc.mockImplementation(async (name) => {
    if (name === 'previsit_summary') return { data: summary, error: null }
    if (name === 'previsit_sewadars') return { data: sewadars, error: null }
    if (name === 'previsit_deployed') return { data: deployed, error: null }
    return { data: [], error: null }
  })
}

beforeEach(() => {
  rpc.mockReset()
  exportWorkbook.mockReset()
  toastError.mockClear()
  toastSuccess.mockClear()
  pgHandlers.length = 0
})

afterEach(() => { cleanup() })

describe('PrevisitView', () => {
  it('defaults to the newest sewa day and renders its rows (P1)', async () => {
    mockRpc()
    render(<PrevisitView schedules={SCHEDULES} scheduleId="sched-1" />)
    await waitFor(() => expect(screen.getByText('Asha')).toBeTruthy())
    // Newest day 2026-10-06 → Asha + Bina visible, Chand (10-05) hidden.
    expect(screen.queryByText('Chand')).toBeNull()
    expect(screen.getByText('Bina')).toBeTruthy()
  })

  it('switching the sewa day swaps the rows', async () => {
    mockRpc()
    render(<PrevisitView schedules={SCHEDULES} scheduleId="sched-1" />)
    await waitFor(() => expect(screen.getByText('Asha')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '5 Oct' }))
    await waitFor(() => expect(screen.getByText('Chand')).toBeTruthy())
    expect(screen.queryByText('Asha')).toBeNull()
  })

  it('the All chip combines every sewa day, and Total counts days (P4)', async () => {
    mockRpc()
    render(<PrevisitView schedules={SCHEDULES} scheduleId="sched-1" />)
    await waitFor(() => expect(screen.getByText('Asha')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'All (2)' }))
    // Present register now holds all three sewadar-days.
    await waitFor(() => expect(screen.getByText('Chand')).toBeTruthy())
    expect(screen.getByText('Asha')).toBeTruthy()
    expect(screen.getByText('Present (3)')).toBeTruthy()
    // Total tab shows day counts instead of a single-day tick.
    fireEvent.click(screen.getByText('Total (3)'))
    await waitFor(() => expect(screen.getByText('Dev')).toBeTruthy())
    expect(screen.getAllByText('1/2')).toHaveLength(2)
  })

  it('a failed RPC shows an error, never a clean empty view (P2)', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'function previsit_summary does not exist' } })
    render(<PrevisitView schedules={SCHEDULES} scheduleId="sched-1" />)
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(toastError).not.toHaveBeenCalled()
  })

  it('stale rows from the previous schedule are never shown (P3)', async () => {
    mockRpc()
    const { rerender } = render(<PrevisitView schedules={[...SCHEDULES, { id: 'sched-2', name: 'Next Visit' }]} scheduleId="sched-1" />)
    await waitFor(() => expect(screen.getByText('Asha')).toBeTruthy())
    rpc.mockResolvedValue({ data: [], error: null })
    rerender(<PrevisitView schedules={[...SCHEDULES, { id: 'sched-2', name: 'Next Visit' }]} scheduleId="sched-2" />)
    await waitFor(() => expect(screen.queryByText('Asha')).toBeNull())
  })

  it('every cell carries a data-label for the mobile card view (P5)', async () => {
    mockRpc()
    const { container } = render(<PrevisitView schedules={SCHEDULES} scheduleId="sched-1" />)
    await waitFor(() => expect(screen.getByText('Asha')).toBeTruthy())
    expect(container.querySelectorAll('td:not([data-label])')).toHaveLength(0)
  })

  it('exports the visible rows', async () => {
    mockRpc()
    exportWorkbook.mockResolvedValue(2)
    render(<PrevisitView schedules={SCHEDULES} scheduleId="sched-1" />)
    await waitFor(() => expect(screen.getByText('Asha')).toBeTruthy())
    fireEvent.click(screen.getByText('Export Excel'))
    await waitFor(() => expect(exportWorkbook).toHaveBeenCalledTimes(1))
    const [filename, sheets] = exportWorkbook.mock.calls[0]
    expect(filename).toContain('previsit')
    expect(sheets[0].rows).toHaveLength(2)
    expect(toastSuccess).toHaveBeenCalled()
  })

  it('shows Total, Present and Attention tabs with counts — and never an Absent tab', async () => {
    mockRpc()
    render(<PrevisitView schedules={SCHEDULES} scheduleId="sched-1" />)
    await waitFor(() => expect(screen.getByText('Asha')).toBeTruthy())
    // Newest day 2026-10-06: Total 3 deployed, Present 2 sewadars, Attention 1 (Bina open).
    expect(screen.getByText('Total (3)')).toBeTruthy()
    expect(screen.getByText('Present (2)')).toBeTruthy()
    expect(screen.getByText('Attention (1)')).toBeTruthy()
    expect(screen.queryByText(/absent/i)).toBeNull()
  })

  it('the Total tab is a badge × day matrix with green present / red absent tiles', async () => {
    mockRpc()
    render(<PrevisitView schedules={SCHEDULES} scheduleId="sched-1" />)
    await waitFor(() => expect(screen.getByText('Total (3)')).toBeTruthy())
    fireEvent.click(screen.getByText('Total (3)'))
    // Day headers read "Oct / 6" with the full ISO date as tooltip.
    await waitFor(() => expect(screen.getByText('Dev')).toBeTruthy())
    const dayHeads = [...document.querySelectorAll('.att-table thead th.att-day[title]')].map((th) => th.title)
    expect(dayHeads).toEqual(['2026-10-06', '2026-10-05'])
    expect(screen.getAllByText('Oct')).toHaveLength(2)
    // Asha + Bina present on 10-06 (2 green tiles); Dev absent everywhere.
    expect(document.querySelectorAll('.att-cell.att-present')).toHaveLength(2)
    expect(document.querySelectorAll('.att-cell.att-absent')).toHaveLength(4)
    // Days pill per row: Asha 1/2, Dev 0/2.
    expect(screen.getAllByText('1/2')).toHaveLength(2)
    expect(screen.getByText('0/2')).toBeTruthy()
  })

  it('the Attention tab flags open, undeployed and repeat scans', async () => {
    mockRpc()
    render(<PrevisitView schedules={SCHEDULES} scheduleId="sched-1" />)
    await waitFor(() => expect(screen.getByText('Asha')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'All (2)' }))
    fireEvent.click(screen.getByText(/Attention \(2\)/))
    await waitFor(() => expect(screen.getByText('Open sessions (1)')).toBeTruthy())
    expect(screen.getByText('Undeployed scans (1)')).toBeTruthy()
    expect(screen.getByText('Scanned more than once (1)')).toBeTruthy()
    // Chand carries two flags on one row — listed once per section.
    expect(screen.getAllByText('Chand')).toHaveLength(2)
  })

  it('initialTab lands each reports page on its own sub-tab', async () => {
    mockRpc()
    render(<PrevisitView schedules={SCHEDULES} scheduleId="sched-1" initialTab="total" />)
    // Total tab active immediately: Dev (deployed, never scanned) visible.
    await waitFor(() => expect(screen.getByText('Dev')).toBeTruthy())
  })

  it('exports the Total tab with the Present column', async () => {
    mockRpc()
    exportWorkbook.mockResolvedValue(3)
    render(<PrevisitView schedules={SCHEDULES} scheduleId="sched-1" />)
    await waitFor(() => expect(screen.getByText('Total (3)')).toBeTruthy())
    fireEvent.click(screen.getByText('Total (3)'))
    await waitFor(() => expect(screen.getByText('Dev')).toBeTruthy())
    fireEvent.click(screen.getByText('Export Excel'))
    await waitFor(() => expect(exportWorkbook).toHaveBeenCalledTimes(1))
    const [filename, sheets] = exportWorkbook.mock.calls[0]
    expect(filename).toContain('total')
    expect(sheets[0].name).toBe('Total')
    expect(sheets[0].rows).toHaveLength(3)
    expect(sheets[0].rows[0]['Present 2026-10-06']).toBe('Yes')
    expect(sheets[0].rows[2]['Present 2026-10-06']).toBe('')
  })

  it('empty filter states offer a clear-filters escape hatch', async () => {
    mockRpc()
    render(<PrevisitView schedules={SCHEDULES} scheduleId="sched-1" />)
    await waitFor(() => expect(screen.getByText('Asha')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Search previsit rows'), { target: { value: 'zzz-no-one' } })
    await waitFor(() => expect(screen.getByText('Nothing matches the current filters.')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    await waitFor(() => expect(screen.getByText('Asha')).toBeTruthy())
  })

  it('asks for a schedule when none is selected', () => {
    render(<PrevisitView schedules={SCHEDULES} scheduleId="" />)
    expect(screen.getByText('No schedule selected')).toBeTruthy()
    expect(rpc).not.toHaveBeenCalled()
  })
})
