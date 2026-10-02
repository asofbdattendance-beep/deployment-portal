// @vitest-environment jsdom
/**
 * InchargeScannerPage — scanner-only page for the dept_incharge Attendance tab.
 *
 * Mock patterns follow ScannerPage.test.jsx (supabase/fetchAllRows,
 * PortalAuthContext, Toast). One deliberate departure: useScannerSession is
 * mocked here (ScannerPage.test.jsx uses the real hook) so the scanner
 * success path — handleScan -> onAfterScan -> recent list refresh — runs
 * deterministically without driving the camera/RPC stack.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render, act, cleanup, screen, fireEvent } from '@testing-library/react'
import { todayStrIST } from '../lib/scannerUtils'
import InchargeScannerPage from './InchargeScannerPage'

const mocks = vi.hoisted(() => ({
  fetchAllRows: vi.fn(),
  filterCalls: [],
  scannerCfg: null,
  handleScan: null,
  sessionRows: [],
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))

vi.mock('../lib/supabase', () => ({
  supabase: { rpc: () => Promise.resolve({ data: null }) },
  fetchAllRows: (...args) => mocks.fetchAllRows(...args),
}))
vi.mock('../context/PortalAuthContext', () => ({
  usePortalAuth: () => ({ profile: { centre: 'DELHI', badge_number: 'FB0001AA0001' } }),
}))
vi.mock('../components/Toast', () => ({ useToast: () => mocks.toast }))
vi.mock('../components/scanner/BarcodeScanner', () => ({
  default: React.forwardRef((props, _ref) => (
    <button data-testid="camera-stub" onClick={() => props.onScan('FB999')}>scan</button>
  )),
}))
vi.mock('../hooks/useScannerSession', () => ({
  useScannerSession: (cfg) => {
    mocks.scannerCfg = cfg
    return {
      popup: null,
      outTime: '',
      setOutTime: vi.fn(),
      closePopup: vi.fn(),
      handleScan: (...args) => mocks.handleScan(...args),
      handleCameraScan: vi.fn(),
      commitScan: vi.fn(),
      confirmForgot: vi.fn(),
      busy: false,
      resetBusy: vi.fn(),
      queued: [],
      syncing: false,
      refreshQueue: vi.fn(),
      scannerRef: { current: null },
    }
  },
}))

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 50)) })

const SCHEDULES = [{ id: 'sched-1', name: 'Visit' }]
const DEPTS = [{ id: 'd1', name: 'LANGAR' }]
const rowFor = (today) => ({
  id: 's1',
  badge_number: 'FB123',
  sewadar_name: 'Test Sewadar',
  sewadar_centre: 'DELHI',
  sewadar_dept: 'd1',
  in_date: today,
  out_date: null,
  in_time: '10:00',
  out_time: null,
  is_vss: false,
  undeployed_scan: false,
  created_at: `${today}T10:00:00`,
})

beforeEach(() => {
  mocks.fetchAllRows.mockReset()
  mocks.filterCalls.length = 0
  mocks.scannerCfg = null
  mocks.sessionRows = []
  for (const k of ['success', 'error', 'warning', 'info']) mocks.toast[k].mockReset()

  // The success path: a scan appends today's session, then the page's
  // onAfterScan (refreshSessions) re-reads it via fetchAllRows.
  mocks.handleScan = vi.fn(async (_badge) => {
    mocks.sessionRows = [rowFor(todayStrIST())]
    await mocks.scannerCfg?.onAfterScan?.()
    mocks.scannerCfg?.clearManual?.()
    return { ok: true }
  })

  mocks.fetchAllRows.mockImplementation((table, cols, applyFilters) => {
    if (table === 'deployment_departments') return Promise.resolve(DEPTS)
    if (table === 'dp_attendance_sessions') {
      if (typeof applyFilters === 'function') {
        const calls = []
        const q = {
          eq: (...a) => { calls.push(['eq', ...a]); return q },
          or: (...a) => { calls.push(['or', ...a]); return q },
          order: (...a) => { calls.push(['order', ...a]); return q },
          in: (...a) => { calls.push(['in', ...a]); return q },
        }
        applyFilters(q)
        mocks.filterCalls.push(...calls)
      }
      return Promise.resolve(mocks.sessionRows)
    }
    return Promise.resolve([])
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('InchargeScannerPage render', () => {
  it('renders the title, manual entry, and the recent-scans empty state', async () => {
    render(<InchargeScannerPage schedules={SCHEDULES} scheduleId="sched-1" />)
    await settle()
    expect(screen.getByText('Attendance')).toBeTruthy()
    expect(screen.getByText('Visit')).toBeTruthy()
    expect(screen.getByPlaceholderText('Enter badge manually (FB/BH/VS)')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Mark' })).toBeTruthy()
    expect(screen.getByText('No scans today')).toBeTruthy()
  })

  it('queries sessions with the event-date or() predicate, never in_date-only', async () => {
    render(<InchargeScannerPage schedules={SCHEDULES} scheduleId="sched-1" />)
    await settle()
    const today = todayStrIST()
    expect(mocks.filterCalls).toContainEqual(['or', `in_date.eq.${today},out_date.eq.${today}`])
    // An in_date-only read misses overnight sessions (IN yesterday, OUT
    // today) and contradicts the Incharge page and the Daily tab.
    expect(mocks.filterCalls.filter(c => c[0] === 'eq' && c[1] === 'in_date')).toHaveLength(0)
  })
})

describe('InchargeScannerPage scanner success path', () => {
  it('updates the recent list after a manual scan', async () => {
    render(<InchargeScannerPage schedules={SCHEDULES} scheduleId="sched-1" />)
    await settle()
    expect(screen.getByText('No scans today')).toBeTruthy()

    const input = screen.getByPlaceholderText('Enter badge manually (FB/BH/VS)')
    await act(async () => {
      fireEvent.change(input, { target: { value: 'FB123' } })
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Mark' }))
      await new Promise(r => setTimeout(r, 50))
    })

    expect(mocks.handleScan).toHaveBeenCalledWith('FB123', { manual: true })
    expect(screen.queryByText('No scans today')).toBeNull()
    expect(screen.getByText('FB123')).toBeTruthy()
    expect(screen.getByText('Test Sewadar')).toBeTruthy()
    // deptNameById resolves the sewadar_dept snapshot to a name, not a uuid.
    expect(screen.getByText('LANGAR')).toBeTruthy()
  })
})
