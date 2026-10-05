// @vitest-environment jsdom
// useSewaViewData — the mode-aware data owner behind SewaView. Visit mode
// must NEVER fire a previsit RPC (and previsit mode must never fire a visit
// RPC): the two lenses read different tables, and a stray call is either
// wasted spend or a scope leak. The mock setup mirrors AttendancePage.test.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { SEWA_MODE_VISIT, SEWA_MODE_PREVISIT } from '../lib/sewaMode'
import { useSewaViewData } from './useSewaViewData'

const rpc = vi.fn()
const fetchAllRpc = vi.fn(async (name, params) => {
  const res = await rpc(name, params)
  if (res?.error) throw res.error
  return Array.isArray(res?.data) ? res.data : []
})
const noopChannel = () => {
  const ch = { on: () => ch, subscribe: () => ch, unsubscribe: () => ch }
  return ch
}
vi.mock('../lib/supabase', () => ({
  supabase: { rpc: (...args) => rpc(...args), channel: () => noopChannel(), removeChannel: () => {} },
  fetchAllRpc: (...args) => fetchAllRpc(...args),
}))
vi.mock('../lib/realtime', () => ({ reportRealtimeStatus: () => {} }))

const DATES = ['2026-10-07', '2026-10-08']
const CENTRE_DAILY = [
  { event_date: '2026-10-07', centre: 'DELHI', present: 2, open_now: 0, deployed: 4 },
  { event_date: '2026-10-08', centre: 'DELHI', present: 1, open_now: 1, deployed: 4 },
]
const PRESENT = {
  '2026-10-07': [
    { badge_number: 'B1', sewadar_name: 'RAM', sewadar_centre: 'DELHI', department_id: 'd1', dept_name: 'MEDICAL', is_vss: false },
    { badge_number: 'B2', sewadar_name: 'SHAM', sewadar_centre: 'DELHI', department_id: 'd1', dept_name: 'MEDICAL', is_vss: false },
  ],
  '2026-10-08': [
    { badge_number: 'B1', sewadar_name: 'RAM', sewadar_centre: 'DELHI', department_id: 'd1', dept_name: 'MEDICAL', is_vss: false },
  ],
}
const ABSENT = {
  '2026-10-07': [
    { badge_number: 'B3', sewadar_name: 'GITA', sewadar_centre: 'DELHI', department_id: 'd1', dept_name: 'MEDICAL', is_vss: false },
  ],
  '2026-10-08': [],
}
const SEWADAR_SUMMARY = [
  {
    badge_number: 'B1', sewadar_name: 'RAM', sewadar_centre: 'DELHI', dept_name: 'MEDICAL',
    is_vss: false, days_present: 2, total_scans: 2, open_sessions: 1,
    first_in_date: '2026-10-07', first_in_time: '09:00:00',
    last_out_date: '2026-10-08', last_out_time: null, still_open: true, undeployed_scan: false,
  },
]
const PREVISIT_SUMMARY = [
  { event_date: '2026-10-05', centre: 'DELHI', department_id: 'd1', dept_name: 'MEDICAL', present: 1, open_now: 0 },
]
const PREVISIT_ROWS = [
  {
    event_date: '2026-10-05', badge_number: 'B1', sewadar_name: 'RAM', sewadar_centre: 'DELHI',
    department_id: 'd1', dept_name: 'MEDICAL', is_vss: false, in_time: '09:00:00',
    out_time: '18:00:00', duration_min: 540, is_manual: false, undeployed: false,
    session_count: 1, is_open: false,
  },
]
const PREVISIT_DEPLOYED = [
  { badge_number: 'B1', sewadar_name: 'RAM', sewadar_centre: 'DELHI', department_id: 'd1', dept_name: 'MEDICAL', is_vss: false },
]

function respondWith(overrides = {}) {
  rpc.mockImplementation((name, params) => {
    if (overrides[name] instanceof Error) return Promise.resolve({ data: null, error: overrides[name] })
    if (name === 'attendance_centre_daily') return Promise.resolve({ data: CENTRE_DAILY, error: null })
    if (name === 'attendance_day_badges') {
      const rows = (params?.p_mode === 'absent' ? ABSENT : PRESENT)[params?.p_date] || []
      return Promise.resolve({ data: rows, error: null })
    }
    if (name === 'attendance_sewadar_summary') return Promise.resolve({ data: SEWADAR_SUMMARY, error: null })
    if (name === 'previsit_summary') return Promise.resolve({ data: PREVISIT_SUMMARY, error: null })
    if (name === 'previsit_sewadars') return Promise.resolve({ data: PREVISIT_ROWS, error: null })
    if (name === 'previsit_deployed') return Promise.resolve({ data: PREVISIT_DEPLOYED, error: null })
    return Promise.resolve({ data: [], error: null })
  })
}

function Probe({ scheduleId, mode, windowDates }) {
  const data = useSewaViewData(scheduleId, mode, windowDates)
  return (
    <div
      data-testid="probe"
      data-loading={data.loading ? 'yes' : 'no'}
      data-error={data.loadError || ''}
      data-current={data.rowsAreCurrent ? 'yes' : 'no'}
    >
      {JSON.stringify({
        summary: data.summary,
        rows: data.rows,
        deployed: data.deployed,
      })}
    </div>
  )
}

function probePayload() {
  return JSON.parse(screen.getByTestId('probe').textContent)
}
function rpcNames() {
  return rpc.mock.calls.map(([n]) => n)
}

beforeEach(() => {
  rpc.mockReset()
  fetchAllRpc.mockClear()
  respondWith()
})
afterEach(cleanup)

describe('useSewaViewData — visit mode', () => {
  it('reads the visit feeds and never fires a previsit RPC', async () => {
    render(<Probe scheduleId="sched-1" mode={SEWA_MODE_VISIT} windowDates={DATES} />)
    await waitFor(() => expect(screen.getByTestId('probe').dataset.loading).toBe('no'))
    const names = rpcNames()
    expect(names).toContain('attendance_centre_daily')
    expect(names).toContain('attendance_sewadar_summary')
    expect(names.filter((n) => n === 'attendance_day_badges')).toHaveLength(4)
    expect(names.some((n) => n.startsWith('previsit'))).toBe(false)
  })

  it('returns the usePrevisitData contract shape', async () => {
    render(<Probe scheduleId="sched-1" mode={SEWA_MODE_VISIT} windowDates={DATES} />)
    await waitFor(() => expect(screen.getByTestId('probe').dataset.loading).toBe('no'))
    const p = probePayload()
    expect(p.summary).toHaveLength(2)
    // Present badges stamped per day: B1×2 days + B2×1 day.
    expect(p.rows.filter((r) => !r.undeployed)).toHaveLength(3)
    expect(p.rows.find((r) => r.badge_number === 'B1' && r.event_date === '2026-10-07').is_open).toBe(true)
    // Deployed = present ∪ absent across the window: B1, B2, B3.
    expect(p.deployed.map((r) => r.badge_number).sort()).toEqual(['B1', 'B2', 'B3'])
    expect(screen.getByTestId('probe').dataset.current).toBe('yes')
    expect(screen.getByTestId('probe').dataset.error).toBe('')
  })

  it('a failed visit feed surfaces loadError instead of a confident empty view', async () => {
    respondWith({ attendance_centre_daily: new Error('PGRST202') })
    render(<Probe scheduleId="sched-1" mode={SEWA_MODE_VISIT} windowDates={DATES} />)
    await waitFor(() => expect(screen.getByTestId('probe').dataset.loading).toBe('no'))
    expect(screen.getByTestId('probe').dataset.error).toMatch(/attendance_centre_daily/)
  })

  it('windowless schedules fetch nothing day-grained but stay honest', async () => {
    render(<Probe scheduleId="sched-1" mode={SEWA_MODE_VISIT} windowDates={[]} />)
    await waitFor(() => expect(screen.getByTestId('probe').dataset.loading).toBe('no'))
    expect(rpcNames().filter((n) => n === 'attendance_day_badges')).toHaveLength(0)
    const p = probePayload()
    expect(p.rows).toEqual([])
    expect(p.deployed).toEqual([])
  })
})

describe('useSewaViewData — previsit mode', () => {
  it('reads the previsit feeds and never fires a visit RPC', async () => {
    render(<Probe scheduleId="sched-1" mode={SEWA_MODE_PREVISIT} windowDates={DATES} />)
    await waitFor(() => expect(screen.getByTestId('probe').dataset.loading).toBe('no'))
    const names = rpcNames()
    expect(names).toContain('previsit_summary')
    expect(names.some((n) => n.startsWith('attendance_'))).toBe(false)
    const p = probePayload()
    expect(p.summary).toEqual(PREVISIT_SUMMARY)
    expect(p.rows).toEqual(PREVISIT_ROWS)
    expect(p.deployed).toEqual(PREVISIT_DEPLOYED)
  })
})
