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
  fromCalls: [],
  scannerCfg: null,
  handleScan: null,
  sessionRows: [],
  sessionCount: 0,
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))

vi.mock('../lib/supabase', () => ({
  supabase: {
    rpc: () => Promise.resolve({ data: null }),
    from: (table) => {
      mocks.fromCalls.push(['from', table])
      let selectOpts = null
      const q = {
        select: (cols, opts) => {
          selectOpts = opts
          mocks.fromCalls.push(['select', cols, opts])
          return q
        },
        eq: (...a) => {
          mocks.filterCalls.push(['eq', ...a])
          mocks.fromCalls.push(['eq', ...a])
          return q
        },
        or: (...a) => {
          mocks.filterCalls.push(['or', ...a])
          mocks.fromCalls.push(['or', ...a])
          return q
        },
        order: (...a) => {
          mocks.fromCalls.push(['order', ...a])
          return q
        },
        limit: (...a) => {
          mocks.fromCalls.push(['limit', ...a])
          return q
        },
        then: (resolve) => {
          return Promise.resolve(
            resolve({
              data: mocks.sessionRows,
              count: selectOpts?.count === 'exact' ? (mocks.sessionCount ?? mocks.sessionRows.length) : null,
              error: null,
            })
          )
        },
      }
      return q
    },
  },
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
  globalThis.__SCANNER_REFRESH_DEBOUNCE_MS__ = 0
  mocks.fetchAllRows.mockReset()
  mocks.filterCalls.length = 0
  mocks.fromCalls.length = 0
  mocks.scannerCfg = null
  mocks.sessionRows = []
  mocks.sessionCount = 0
  for (const k of ['success', 'error', 'warning', 'info']) mocks.toast[k].mockReset()

  // The success path: a scan appends today's session, then the page's
  // onAfterScan (refreshSessions) re-reads it.
  mocks.handleScan = vi.fn(async (badge) => {
    mocks.sessionRows = [rowFor(todayStrIST())]
    mocks.sessionCount = 1
    await mocks.scannerCfg?.onAfterScan?.({
      badge,
      action: 'IN',
      sewadar_name: 'Test Sewadar',
      sewadar_centre: 'DELHI',
      dept_id: 'd1',
      dept_name: 'LANGAR',
    })
    mocks.scannerCfg?.clearManual?.()
    return { ok: true }
  })

  mocks.fetchAllRows.mockImplementation((table) => {
    if (table === 'deployment_departments') return Promise.resolve(DEPTS)
    return Promise.resolve([])
  })
})

afterEach(() => {
  cleanup()
  delete globalThis.__SCANNER_REFRESH_DEBOUNCE_MS__
  vi.useRealTimers()
})

describe('InchargeScannerPage render', () => {
  it('renders the title, manual entry, and the recent-scans empty state', async () => {
    render(<InchargeScannerPage schedules={SCHEDULES} scheduleId="sched-1" />)
    await settle()
    expect(screen.getByText('Attendance')).toBeTruthy()
    expect(screen.getByText('Visit')).toBeTruthy()
    expect(screen.getByPlaceholderText('Enter badge manually (FB/VS)')).toBeTruthy()
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

  it('queries dp_attendance_sessions with .limit(10) instead of unbounded fetchAllRows', async () => {
    render(<InchargeScannerPage schedules={SCHEDULES} scheduleId="sched-1" />)
    await settle()
    expect(mocks.fetchAllRows).not.toHaveBeenCalledWith('dp_attendance_sessions', expect.anything(), expect.anything(), expect.anything(), expect.anything())
    expect(mocks.fromCalls).toContainEqual(['from', 'dp_attendance_sessions'])
    expect(mocks.fromCalls).toContainEqual(['limit', 10])
  })

  // v77 & v82 perf: the 15 s poll must not pay count:'exact' (~3.2 s mean on
  // dp_attendance_sessions prod-wide). The refresh (post-scan re-read exercises
  // the same path) passes { count: 'none' }; the initial load keeps { count: 'exact' }
  // with .limit(10) so a truncated first paint still fails loudly.
  it('refresh skips count:exact while the initial load keeps it', async () => {
    render(<InchargeScannerPage schedules={SCHEDULES} scheduleId="sched-1" />)
    await settle()
    const selectCalls = mocks.fromCalls.filter(c => c[0] === 'select')
    expect(selectCalls).toHaveLength(1)
    expect(selectCalls[0][2]).toEqual({ count: 'exact' })
    await act(async () => { await mocks.scannerCfg.onAfterScan() })
    const selectCallsAfter = mocks.fromCalls.filter(c => c[0] === 'select')
    expect(selectCallsAfter).toHaveLength(2)
    expect(selectCallsAfter[1][2]).toEqual({ count: 'none' })
  })
})

describe('InchargeScannerPage scanner success path', () => {
  it('updates the recent list after a manual scan', async () => {
    render(<InchargeScannerPage schedules={SCHEDULES} scheduleId="sched-1" />)
    await settle()
    expect(screen.getByText('No scans today')).toBeTruthy()

    const input = screen.getByPlaceholderText('Enter badge manually (FB/VS)')
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

// A post-scan refresh landing while the initial load is in flight must not
// make the load discard its department names (they shared one sequence
// counter — on a first-ever open with no cached names, every Dept pill and
// column stayed blank until a remount).
describe('InchargeScannerPage — scan during a slow initial load', () => {
  it('keeps the initial load results when a post-scan refresh overlaps it', async () => {
    let releaseDepts
    const gate = new Promise((r) => { releaseDepts = r })
    mocks.sessionRows = [rowFor(todayStrIST())]
    mocks.fetchAllRows.mockImplementation(async (table) => {
      if (table === 'deployment_departments') { await gate; return DEPTS }
      if (table === 'dp_attendance_sessions') return mocks.sessionRows
      return []
    })
    render(<InchargeScannerPage schedules={SCHEDULES} scheduleId="sched-1" />)
    await settle()
    // the operator scans before the load has finished
    await act(async () => { await mocks.scannerCfg.onAfterScan() })
    await act(async () => { releaseDepts() })
    await settle()
    expect(screen.getAllByText('LANGAR').length).toBeGreaterThan(0)
  })
})

describe('InchargeScannerPage optimistic feed & debounce', () => {
  it('preserves pending optimistic scan across background refresh when server has not caught up', async () => {
    // Initial load: 0 sessions
    mocks.sessionRows = []
    render(<InchargeScannerPage schedules={SCHEDULES} scheduleId="sched-1" />)
    await settle()
    expect(screen.getByText('No scans today')).toBeTruthy()

    // Operator scans FB123 IN
    await act(async () => {
      mocks.scannerCfg.onAfterScan({
        badge: 'FB123',
        action: 'IN',
        sewadar_name: 'Optimistic Sewadar',
        sewadar_centre: 'DELHI',
        dept_name: 'LANGAR',
      })
    })

    // Immediately rendered optimistically
    expect(screen.queryByText('No scans today')).toBeNull()
    expect(screen.getByText('FB123')).toBeTruthy()
    expect(screen.getByText('Optimistic Sewadar')).toBeTruthy()

    // Background refresh fires while server still returns empty rows (e.g. queue not drained)
    mocks.sessionRows = []
    await act(async () => {
      // Simulate another background refresh tick
      await mocks.scannerCfg.onAfterScan()
    })

    // FB123 must NOT be wiped
    expect(screen.getByText('FB123')).toBeTruthy()
    expect(screen.getByText('Optimistic Sewadar')).toBeTruthy()
  })

  it('OUT scan updates session but does not increment totalScansCount KPI tile', async () => {
    mocks.sessionRows = []
    mocks.sessionCount = 0
    render(<InchargeScannerPage schedules={SCHEDULES} scheduleId="sched-1" />)
    await settle()
    const getScansTodayValue = () => {
      const label = screen.getByText('Scans today')
      const tile = label.closest('.kpi-tile') || label.closest('.stat-box') || label.parentElement
      return tile.querySelector('.stat-value')?.textContent?.trim()
    }
    expect(getScansTodayValue()).toBe('0')

    // Scan IN -> increments count
    await act(async () => {
      mocks.scannerCfg.onAfterScan({
        badge: 'FB123',
        action: 'IN',
        sewadar_name: 'Sewadar One',
      })
    })
    expect(getScansTodayValue()).toBe('1')

    // Scan OUT for same sewadar -> updates session, count stays 1
    await act(async () => {
      mocks.scannerCfg.onAfterScan({
        badge: 'FB123',
        action: 'OUT',
        sewadar_name: 'Sewadar One',
      })
    })
    expect(getScansTodayValue()).toBe('1')
  })

  it('debounces rapid burst scans into a single background refresh query', async () => {
    globalThis.__SCANNER_REFRESH_DEBOUNCE_MS__ = 50
    mocks.sessionRows = []
    render(<InchargeScannerPage schedules={SCHEDULES} scheduleId="sched-1" />)
    await settle()

    const selectCallsBefore = mocks.fromCalls.filter(c => c[0] === 'select').length

    // Rapid burst of 3 scans
    await act(async () => {
      mocks.scannerCfg.onAfterScan({ badge: 'FB1', action: 'IN' })
      mocks.scannerCfg.onAfterScan({ badge: 'FB2', action: 'IN' })
      mocks.scannerCfg.onAfterScan({ badge: 'FB3', action: 'IN' })
    })

    // Before debounce delay elapses, no extra query
    const selectCallsImmediate = mocks.fromCalls.filter(c => c[0] === 'select').length
    expect(selectCallsImmediate).toBe(selectCallsBefore)

    // Wait for debounce timer to fire
    await act(async () => {
      await new Promise(r => setTimeout(r, 70))
    })

    const selectCallsAfter = mocks.fromCalls.filter(c => c[0] === 'select').length
    expect(selectCallsAfter).toBe(selectCallsBefore + 1)
  })
})
