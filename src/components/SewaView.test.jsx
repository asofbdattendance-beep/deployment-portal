// @vitest-environment jsdom
// SewaView (visit mode) — the "difference only dates" contract, mounted:
// the previsit register UX renders over the visit window with visit nouns,
// and a stray row outside the window can never grow a Bhati Visit column.
// Mock setup mirrors PrevisitView.test.jsx.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import SewaView from './SewaView'

const rpc = vi.fn()
const fetchAllRpc = vi.fn(async (name, params) => {
  const res = await rpc(name, params)
  if (res?.error) throw res.error
  return Array.isArray(res?.data) ? res.data : []
})
const fetchAllRows = vi.fn(async () => [])
const fromMock = vi.fn()
const toastError = vi.fn()
const toastSuccess = vi.fn()
const noopChannel = () => {
  const ch = { on: () => ch, subscribe: () => ch, unsubscribe: () => ch }
  return ch
}
vi.mock('../lib/supabase', () => ({
  supabase: {
    rpc: (...args) => rpc(...args),
    from: (...args) => fromMock(...args),
    channel: () => noopChannel(),
    removeChannel: () => {},
  },
  fetchAllRpc: (...args) => fetchAllRpc(...args),
  fetchAllRows: (...args) => fetchAllRows(...args),
}))
vi.mock('../components/Toast', () => ({
  useToast: () => ({ error: toastError, success: toastSuccess, warning: vi.fn(), info: vi.fn() }),
}))
const exportWorkbook = vi.fn()
vi.mock('../lib/excel', () => ({
  fileSlug: (s) => String(s || 'x').toLowerCase().replace(/\s+/g, '-'),
  exportWorkbook: (...args) => exportWorkbook(...args),
}))
vi.mock('../lib/realtime', () => ({ reportRealtimeStatus: () => {} }))

const SCHEDULES = [{ id: 'sched-1', name: 'October 2026 Visit', visit_start_date: '2026-10-07', visit_end_date: '2026-10-09' }]
const NOWINDOW = [{ id: 'sched-1', name: 'October 2026 Visit' }]

const CENTRE_DAILY = [
  // Stray previsit-bleed row: inside no window date, must never render.
  { event_date: '2026-10-01', centre: 'DELHI', present: 9, open_now: 0, deployed: 4 },
  { event_date: '2026-10-07', centre: 'DELHI', present: 2, open_now: 0, deployed: 4 },
  { event_date: '2026-10-08', centre: 'DELHI', present: 1, open_now: 1, deployed: 4 },
  { event_date: '2026-10-07', centre: 'FARIDABAD', present: 1, open_now: 0, deployed: 2 },
]
const BADGE = (badge, name, centre) => ({
  badge_number: badge, sewadar_name: name, sewadar_centre: centre,
  department_id: 'd1', dept_name: 'MEDICAL', is_vss: false,
})
const PRESENT = {
  '2026-10-07': [BADGE('B1', 'RAM', 'DELHI'), BADGE('B2', 'SHAM', 'FARIDABAD')],
  '2026-10-08': [BADGE('B1', 'RAM', 'DELHI')],
  '2026-10-09': [BADGE('B2', 'SHAM', 'FARIDABAD')],
}
const ABSENT = {
  '2026-10-07': [BADGE('B3', 'GITA', 'DELHI')],
  '2026-10-08': [BADGE('B2', 'SHAM', 'FARIDABAD'), BADGE('B3', 'GITA', 'DELHI')],
  '2026-10-09': [BADGE('B1', 'RAM', 'DELHI'), BADGE('B3', 'GITA', 'DELHI')],
}
const SEWADAR_SUMMARY = [
  {
    badge_number: 'B1', sewadar_name: 'RAM', sewadar_centre: 'DELHI', dept_name: 'MEDICAL',
    is_vss: false, days_present: 2, total_scans: 2, open_sessions: 1,
    first_in_date: '2026-10-07', first_in_time: '09:00:00',
    last_out_date: '2026-10-08', last_out_time: null, still_open: true, undeployed_scan: false,
  },
]

function mockRpc() {
  rpc.mockImplementation((name, params) => {
    if (name === 'attendance_centre_daily') return Promise.resolve({ data: CENTRE_DAILY, error: null })
    if (name === 'attendance_day_badges') {
      return Promise.resolve({ data: (params?.p_mode === 'absent' ? ABSENT : PRESENT)[params?.p_date] || [], error: null })
    }
    if (name === 'attendance_sewadar_summary') return Promise.resolve({ data: SEWADAR_SUMMARY, error: null })
    return Promise.resolve({ data: [], error: null })
  })
}

function dayChipTitles() {
  return screen.getAllByRole('button', { name: (_c, el) => el?.classList?.contains('day-chip') }).map((b) => b.getAttribute('title') || b.textContent)
}

beforeEach(() => {
  rpc.mockReset()
  fetchAllRpc.mockClear()
  exportWorkbook.mockReset()
  mockRpc()
})
afterEach(cleanup)

describe('SewaView — visit mode', () => {
  it('renders the visit register over exactly the window dates', async () => {
    render(<SewaView schedules={SCHEDULES} scheduleId="sched-1" initialTab="present" />)
    await waitFor(() => expect(screen.getByRole('heading', { name: /Bhati Visit Register/ })).toBeTruthy())
    expect(screen.getByText('Visit day')).toBeTruthy()
    // Default = newest window day 10-09: only SHAM scanned that day.
    await waitFor(() => expect(screen.getByText('SHAM')).toBeTruthy())
    expect(screen.queryByText('RAM')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^All/ }))
    await waitFor(() => expect(screen.getAllByText('RAM')).toHaveLength(2))
    const chips = dayChipTitles()
    expect(chips).toContain('2026-10-07')
    expect(chips).toContain('2026-10-09')
    expect(chips.some((t) => t && t.includes('2026-10-01'))).toBe(false)
  })

  it('never lets an out-of-window row grow a Total column (hard rule)', async () => {
    render(<SewaView schedules={SCHEDULES} scheduleId="sched-1" initialTab="total" />)
    await waitFor(() => expect(screen.getByText('GITA')).toBeTruthy())
    const dayTitles = screen.getAllByRole('columnheader').map((th) => th.getAttribute('title')).filter(Boolean)
    expect(dayTitles).not.toContain('2026-10-01')
    expect(dayTitles).toEqual(expect.arrayContaining(['2026-10-07', '2026-10-08', '2026-10-09']))
  })

  it('exports with the visit slug, never previsit', async () => {
    exportWorkbook.mockResolvedValue(2)
    render(<SewaView schedules={SCHEDULES} scheduleId="sched-1" initialTab="total" />)
    await waitFor(() => expect(screen.getByText('GITA')).toBeTruthy())
    fireEvent.click(screen.getByText('Export Excel'))
    await waitFor(() => expect(exportWorkbook).toHaveBeenCalledTimes(1))
    expect(exportWorkbook.mock.calls[0][0]).toContain('_visit_')
    expect(exportWorkbook.mock.calls[0][0]).not.toContain('previsit')
  })

  it('honours the dashboard centre deep-link and has no Absent tab', async () => {
    render(<SewaView schedules={SCHEDULES} scheduleId="sched-1" initialTab="present" initialCentre="FARIDABAD" />)
    await waitFor(() => expect(screen.getByRole('heading', { name: /Bhati Visit Register/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^All/ }))
    await waitFor(() => expect(screen.getAllByText('SHAM')).toHaveLength(2))
    expect(screen.queryByText('RAM')).toBeNull()
    expect(screen.getByLabelText('Centre filter').value).toBe('FARIDABAD')
    expect(screen.queryByRole('tab', { name: /absent/i })).toBeNull()
    expect(screen.getByLabelText('Search visit rows')).toBeTruthy()
  })

  it('a failed visit feed is an error, never a clean empty register', async () => {
    rpc.mockImplementation((name) => {
      if (name === 'attendance_centre_daily') return Promise.resolve({ data: null, error: new Error('PGRST202') })
      return Promise.resolve({ data: [], error: null })
    })
    render(<SewaView schedules={SCHEDULES} scheduleId="sched-1" initialTab="present" />)
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
  })

  it('windowless schedules render an honest empty view, not windowless columns', async () => {
    render(<SewaView schedules={NOWINDOW} scheduleId="sched-1" initialTab="total" />)
    await waitFor(() => expect(screen.getByText('Nobody deployed in scope')).toBeTruthy())
    expect(dayChipTitles().some((t) => t && /2026-10-0/.test(t))).toBe(false)
  })
})
