// @vitest-environment jsdom
// PrevisitDashboard — the summary half of the previsit surface. Pins that
// the dashboard tabs show KPIs + breakdowns (not the register table) and
// that both halves read through the same hook data.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import PrevisitDashboard from './PrevisitDashboard'

const rpc = vi.fn()

const noopChannel = () => {
  const ch = {
    on: () => ch,
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

vi.mock('../lib/realtime', () => ({
  reportRealtimeStatus: () => {},
}))

const SCHEDULES = [{ id: 'sched-1', name: 'October 2026 Visit' }]

const SUMMARY = [
  { event_date: '2026-10-06', centre: 'CENTRE A', department_id: 'd1', dept_name: 'MEDICAL', present: 2, open_now: 1 },
  { event_date: '2026-10-06', centre: 'CENTRE B', department_id: 'd2', dept_name: 'TRAFFIC', present: 1, open_now: 0 },
  { event_date: '2026-10-05', centre: 'CENTRE A', department_id: 'd1', dept_name: 'MEDICAL', present: 1, open_now: 0 },
]

// The roster behind the heatmap denominator: 3 deployed in A, 1 in B.
const DEPLOYED = [
  { badge_number: 'B1', sewadar_centre: 'CENTRE A' },
  { badge_number: 'B2', sewadar_centre: 'CENTRE A' },
  { badge_number: 'B3', sewadar_centre: 'CENTRE A' },
  { badge_number: 'B4', sewadar_centre: 'CENTRE B' },
]

beforeEach(() => {
  rpc.mockReset()
  rpc.mockImplementation(async (name) => {
    if (name === 'previsit_summary') return { data: SUMMARY, error: null }
    if (name === 'previsit_sewadars') return { data: [], error: null }
    if (name === 'previsit_deployed') return { data: DEPLOYED, error: null }
    return { data: [], error: null }
  })
})

afterEach(() => { cleanup() })

describe('PrevisitDashboard', () => {
  it('renders KPI tiles from the summary', async () => {
    render(<PrevisitDashboard schedules={SCHEDULES} scheduleId="sched-1" />)
    await waitFor(() => expect(screen.getByText('Sewa days')).toBeTruthy())
    // 2 sewa days, 4 present, 1 open, 2 departments — tiles, not a table.
    expect(screen.getByText('Present by sewa day')).toBeTruthy()
    expect(screen.queryByPlaceholderText(/badge/i)).toBeNull()
  })

  it('lists the day strip and the centre heatmap (the old department table is gone)', async () => {
    const { container } = render(<PrevisitDashboard schedules={SCHEDULES} scheduleId="sched-1" />)
    // The date shows once, short ("6 Oct"), on the strip; the strip + matrix
    // header render day + month as separate spans, so it stays unique.
    await waitFor(() => expect(screen.getByText('6 Oct')).toBeTruthy())
    expect(screen.queryByText('By sewa day')).toBeNull()
    expect(screen.queryByText('By department')).toBeNull()
    expect(screen.queryByText('MEDICAL')).toBeNull()
    expect(screen.queryByText('TRAFFIC')).toBeNull()

    expect(screen.getByText('Attendance by centre')).toBeTruthy()
    expect(screen.getByText('Present by centre and sewa day')).toBeTruthy()
    // Rows: centre name over its deployed count.
    expect(screen.getByText('CENTRE A')).toBeTruthy()
    expect(screen.getByText('CENTRE B')).toBeTruthy()
    // The per-row "N sewas" identity sub-line is gone on purpose: the Total
    // column already says it, and a second line made every row taller on a
    // phone. Pinned so it cannot creep back in.
    expect(container.querySelector('.att-centre-sub')).toBeNull()
    // Cells are ratios, not booleans: A 6 Oct = 2/3, B 5 Oct = 0/1.
    expect(screen.getByText('2/3')).toBeTruthy()
    expect(screen.getByText('0/1')).toBeTruthy()
    // Total column + the all-centres row.
    expect(screen.getByText('3/6')).toBeTruthy()
    expect(screen.getByText('4/8')).toBeTruthy()
    // Both centred columns are header cells with an explicit scope.
    expect(container.querySelectorAll('th[scope="col"]').length).toBe(4)
    expect(container.querySelectorAll('th[scope="row"]').length).toBe(3)
  })

  it('says the ratio out loud so colour is never the only signal', async () => {
    render(<PrevisitDashboard schedules={SCHEDULES} scheduleId="sched-1" />)
    await waitFor(() => expect(screen.getByText('2/3')).toBeTruthy())
    expect(screen.getByText('2 of 3 present on 2026-10-06')).toBeTruthy()
    expect(screen.getByText('0 of 1 present on 2026-10-05')).toBeTruthy()
  })

  it('shows the empty state when nothing was scanned', async () => {
    rpc.mockImplementation(async () => ({ data: [], error: null }))
    render(<PrevisitDashboard schedules={SCHEDULES} scheduleId="sched-1" />)
    await waitFor(() => expect(screen.getByText('No previsit sewa recorded')).toBeTruthy())
  })

  it('a failed RPC shows an error, never a clean empty view', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'function previsit_summary does not exist' } })
    render(<PrevisitDashboard schedules={SCHEDULES} scheduleId="sched-1" />)
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
  })

  it('reloads on demand', async () => {
    render(<PrevisitDashboard schedules={SCHEDULES} scheduleId="sched-1" />)
    await waitFor(() => expect(screen.getByText('Sewa days')).toBeTruthy())
    const calls = rpc.mock.calls.length
    fireEvent.click(screen.getByText('Reload'))
    await waitFor(() => expect(rpc.mock.calls.length).toBeGreaterThan(calls))
  })
})
