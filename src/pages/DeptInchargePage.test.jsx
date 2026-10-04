// @vitest-environment jsdom
/**
 * DeptInchargePage — page-owned wiring pins (Phase B task 6, L-23).
 *
 * Scan behaviour is pinned in useScannerSession / useScanHandler; this file
 * pins what only the page can get wrong: the offline pin on load failure
 * (L-43), the session poll (L-42), and the incharge gate render.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render, act, cleanup, screen, fireEvent } from '@testing-library/react'
import { todayStrIST } from '../lib/scannerUtils'
import DeptInchargePage from './DeptInchargePage'
import { getQueuedScans, clearLiveQueue } from '../lib/offlineQueue'

const mocks = vi.hoisted(() => ({
  openCamera: vi.fn(),
  rpc: vi.fn(),
  fetchAllRows: vi.fn(),
  exportWorkbook: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))

vi.mock('../components/scanner/cameraManager', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, openCamera: (...args) => mocks.openCamera(...args) }
})
vi.mock('../lib/supabase', () => ({
  supabase: { rpc: (...args) => mocks.rpc(...args) },
  fetchAllRows: (...args) => mocks.fetchAllRows(...args),
}))
vi.mock('../context/PortalAuthContext', () => ({
  usePortalAuth: () => ({ profile: { centre: 'DELHI', badge_number: 'FB0001AA0001' } }),
}))
vi.mock('../components/Toast', () => ({ useToast: () => mocks.toast }))
vi.mock('../lib/offlineQueue', () => ({
  getQueuedScans: vi.fn(async () => []),
  preloadDeployed: vi.fn(async () => {}),
  clearFailedQueue: vi.fn(async () => {}),
  clearLiveQueue: vi.fn(async () => 0),
  clearOrphanedQueue: vi.fn(async () => {}),
  listStrandedQueue: vi.fn(async () => []),
  removeQueued: vi.fn(async () => {}),
  // Real implementations: QueueRecoveryBar owns the classification now.
  isFailedQueueRow: (r) => !!r && (r.status === 'failed' || r.failed === true),
  isOrphanedQueueRow: (r) => !(!!r && (r.status === 'failed' || r.failed === true)) && (r?.owner ?? null) === null && !r?.synced,
  // The app-level sync engine subscribes to this event name.
  QUEUE_CHANGED_EVENT: 'portal-queue-changed',
}))
vi.mock('../lib/excel', () => ({
  exportWorkbook: (...args) => mocks.exportWorkbook(...args),
  fileSlug: (s) => s,
}))

function makeStream(name = 'stream') {
  const track = {
    kind: 'video',
    readyState: 'live',
    stop: vi.fn(function () { track.readyState = 'ended' }),
    getSettings: () => ({ facingMode: 'environment', width: 1280, height: 720 }),
    getCapabilities: () => ({ focusMode: ['continuous'], zoom: { min: 1, max: 2 } }),
    applyConstraints: vi.fn().mockResolvedValue(undefined),
  }
  return { name, getTracks: () => [track], getVideoTracks: () => [track], track }
}

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 50)) })

beforeEach(() => {
  mocks.openCamera.mockReset()
  mocks.rpc.mockReset()
  mocks.fetchAllRows.mockReset()
  mocks.exportWorkbook.mockReset()
  for (const k of ['success', 'error', 'warning', 'info']) mocks.toast[k].mockReset()

  const stream = makeStream()
  mocks.openCamera.mockResolvedValue({ stream, track: stream.track, torchSupported: false, deviceId: 'rear', resolutionIndex: 0, adopted: false })
  mocks.rpc.mockResolvedValue({ data: null })
  mocks.fetchAllRows.mockResolvedValue([])

  Object.defineProperty(window.navigator, 'mediaDevices', {
    configurable: true, writable: true,
    value: { getUserMedia: vi.fn(), enumerateDevices: vi.fn().mockResolvedValue([]) },
  })
  window.BarcodeDetector = class {
    static getSupportedFormats = () => Promise.resolve(['code_39', 'code_128'])
    detect = () => Promise.resolve([])
  }
  Object.defineProperty(window.HTMLMediaElement.prototype, 'play', {
    configurable: true, writable: true, value: vi.fn().mockResolvedValue(undefined),
  })
  Object.defineProperty(window.HTMLMediaElement.prototype, 'pause', {
    configurable: true, writable: true, value: vi.fn(),
  })
  Object.defineProperty(window.HTMLMediaElement.prototype, 'load', {
    configurable: true, writable: true, value: vi.fn(),
  })
  window.HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    drawImage: vi.fn(), getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(64 * 48 * 4) })),
  }))
})

afterEach(() => {
  cleanup()
  delete window.BarcodeDetector
  vi.useRealTimers()
})

const SCHEDULES = [{ id: 'sched-1', name: 'Visit' }]
const sessionCalls = () => mocks.fetchAllRows.mock.calls.filter(c => c[0] === 'dp_attendance_sessions').length

describe('DeptInchargePage gate', () => {
  it('shows the not-an-incharge gate when the caller has no departments', async () => {
    mocks.rpc.mockResolvedValue({ data: [] })
    render(<DeptInchargePage schedules={SCHEDULES} scheduleId="sched-1" />)
    await settle()
    expect(screen.getByText('No department assigned')).toBeTruthy()
  })

  // V10 failing-first: with the old './scanner/cameraManager' mock path the
  // mock applied to nothing, so the page tested the REAL openCamera and this
  // assertion failed (mock never called, no <video> in ready state).
  it('applies the cameraManager mock (openCamera called, preview ready)', async () => {
    mocks.rpc.mockResolvedValue({ data: ['dept-1'] })
    const { container } = render(<DeptInchargePage schedules={SCHEDULES} scheduleId="sched-1" />)
    await settle()
    expect(mocks.openCamera).toHaveBeenCalled()
    expect(container.querySelector('video')).toBeTruthy()
  })
})

// v53 perf: the page must NOT fetch every sewadar in the portal. The server has
// to RLS-evaluate the department predicate per row (twice per table, because
// fetchAllRows asks for count: 'exact' on page 1), and the page only ever uses
// these rows to enrich DEPLOYED badges. An unfiltered read was the 1-2 s.
describe('DeptInchargePage — sewadar profile fetches are scoped to deployed badges', () => {
  it('filters dp_sewadars / vss_sewadars by the deployed badge list', async () => {
    mocks.rpc.mockResolvedValue({ data: ['dept-1'] })
    mocks.fetchAllRows.mockImplementation(async (table) => {
      if (table === 'deployments') {
        return [
          { id: 'r1', schedule_id: 'sched-1', centre: 'DELHI', badge_number: 'FB0001AA0001', department_id: 'dept-1' },
          { id: 'r2', schedule_id: 'sched-1', centre: 'NOIDA', badge_number: 'FB0001AA0002', department_id: 'dept-1' },
        ]
      }
      return []
    })
    render(<DeptInchargePage schedules={SCHEDULES} scheduleId="sched-1" />)
    await settle()
    const inFilter = (table) => {
      const call = mocks.fetchAllRows.mock.calls.find(c => c[0] === table)
      expect(call, `expected a ${table} fetch`).toBeTruthy()
      // the filter factory must apply an .in('badge_number', [...]) predicate
      let applied = null
      const fake = { in: (col, vals) => { applied = { col, vals }; return fake } }
      call[2](fake)
      return applied
    }
    const sew = inFilter('dp_sewadars')
    expect(sew?.col).toBe('badge_number')
    expect(sew?.vals).toEqual(['FB0001AA0001', 'FB0001AA0002'])
    expect(inFilter('vss_sewadars')?.col).toBe('badge_number')
  })

  it('skips the profile fetches entirely when nothing is deployed', async () => {
    mocks.rpc.mockResolvedValue({ data: ['dept-1'] })
    mocks.fetchAllRows.mockResolvedValue([])
    render(<DeptInchargePage schedules={SCHEDULES} scheduleId="sched-1" />)
    await settle()
    const tables = mocks.fetchAllRows.mock.calls.map(c => c[0])
    expect(tables).toContain('deployments')
    // Profile fetches are the badge-CHUNKED reads (`.in('badge_number',
    // [...])`). The offline directory's best-effort VSS roster read carries
    // a null filter and is not a profile fetch.
    const chunked = []
    for (const c of mocks.fetchAllRows.mock.calls) {
      if ((c[0] === 'vss_sewadars' || c[0] === 'dp_sewadars') && typeof c[2] === 'function') {
        const fake = {
          in: (col, vals) => { chunked.push([c[0], col, vals]); return fake },
          eq: () => fake,
          order: () => fake,
        }
        try { c[2](fake) } catch { /* predicate shape only */ }
      }
    }
    expect(chunked).toEqual([])
  })
})

// v52: the signature of an un-migrated read policy. `get_my_dept_ids` is
// SECURITY DEFINER so the grant RESOLVES, while the `deployments` RLS read
// silently returns nothing because a dept_incharge has no centre. Without this
// banner the page renders a calm "No sewadars in this dept" and the cause is
// invisible.
describe('DeptInchargePage — grant resolves but no deployments are visible', () => {
  it('warns about the read policy instead of implying an empty department', async () => {
    mocks.rpc.mockResolvedValue({ data: ['dept-1'] })       // grant RESOLVES
    mocks.fetchAllRows.mockResolvedValue([])                  // deployments read → []
    render(<DeptInchargePage schedules={SCHEDULES} scheduleId="sched-1" />)
    await settle()
    // the page opens on Scanning; the banner lives with the list tabs
    fireEvent.click(screen.getByRole('button', { name: /Complete list/i }))
    await settle()
    // the copy is split across <strong> nodes, so match on the region's text
    const banner = document.querySelector('[role="status"]')
    expect(banner?.textContent).toMatch(/no deployments are visible/i)
    expect(banner?.textContent).toMatch(/v52_dept_incharge_read_access/i)
  })

  it('stays silent once deployments ARE visible', async () => {
    mocks.rpc.mockResolvedValue({ data: ['dept-1'] })
    mocks.fetchAllRows.mockImplementation(async (table) => {
      if (table === 'deployment_departments') return [{ id: 'dept-1', name: 'Traffic' }]
      if (table === 'deployments') {
        return [{ id: 'r1', schedule_id: 'sched-1', centre: 'DELHI', badge_number: 'FB0001AA0001', department_id: 'dept-1' }]
      }
      return []
    })
    render(<DeptInchargePage schedules={SCHEDULES} scheduleId="sched-1" />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /Complete list/i }))
    await settle()
    const statusText = [...document.querySelectorAll('[role="status"]')].map(e => e.textContent).join(' ')
    expect(statusText).not.toMatch(/no deployments are visible/i)
  })
})

describe('DeptInchargePage offline pin (L-43)', () => {
  it('shows the stale-data pin when the load fails', async () => {
    mocks.rpc.mockResolvedValue({ data: ['d1'] })
    mocks.fetchAllRows.mockRejectedValue(new Error('db down'))
    render(<DeptInchargePage schedules={SCHEDULES} scheduleId="sched-1" />)
    await settle()
    expect(screen.getByText(/showing last data/)).toBeTruthy()
    expect(mocks.toast.error).toHaveBeenCalled()
  })

  it('shows no pin when the load succeeds', async () => {
    mocks.rpc.mockResolvedValue({ data: ['d1'] })
    render(<DeptInchargePage schedules={SCHEDULES} scheduleId="sched-1" />)
    await settle()
    expect(screen.queryByText(/showing last data/)).toBeNull()
  })
})

describe('DeptInchargePage session poll (L-42)', () => {
  it('re-reads sessions every 15s instead of going stale all day', async () => {
    // Fake clock from the start: the interval is scheduled with it, and the
    // mocked loads settle on microtasks, so advancing the clock is enough.
    vi.useFakeTimers()
    try {
      mocks.rpc.mockResolvedValue({ data: ['d1'] })
      render(<DeptInchargePage schedules={SCHEDULES} scheduleId="sched-1" />)
      await act(async () => { await vi.advanceTimersByTimeAsync(100) })
      expect(sessionCalls()).toBe(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(15100) })
      expect(sessionCalls()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

// T3: a slow schedule-A load must never overwrite a fast schedule-B load, and
// switching schedules must clear stale rows + reset filters immediately.
describe('DeptInchargePage load race (T3)', () => {
  const SCHEDS = [{ id: 'sched-A', name: 'A' }, { id: 'sched-B', name: 'B' }]

  it('slow schedule-A load cannot overwrite fast schedule-B rows', async () => {
    mocks.rpc.mockResolvedValue({ data: ['dept-1'] })
    let resolveA
    const gateA = new Promise(r => { resolveA = r })
    let depCalls = 0
    mocks.fetchAllRows.mockImplementation(async (table) => {
      if (table === 'deployment_departments') return [{ id: 'dept-1', name: 'Traffic' }]
      if (table === 'deployments') {
        depCalls += 1
        if (depCalls === 1) {
          await gateA
          return [{ id: 'rA', schedule_id: 'sched-A', centre: 'DELHI', badge_number: 'AAA', department_id: 'dept-1' }]
        }
        return [{ id: 'rB', schedule_id: 'sched-B', centre: 'DELHI', badge_number: 'BBB', department_id: 'dept-1' }]
      }
      return []
    })
    const { rerender } = render(<DeptInchargePage schedules={SCHEDS} scheduleId="sched-A" />)
    // let load A start (rpc + departments resolve) while its deployments hang
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
    rerender(<DeptInchargePage schedules={SCHEDS} scheduleId="sched-B" />)
    await settle()
    await settle()
    // B's fast load landed first
    fireEvent.click(screen.getByRole('button', { name: /Complete list/i }))
    await settle()
    expect(screen.getByText(/BBB/)).toBeTruthy()
    // now the slow A load resolves — it must not overwrite B's rows
    await act(async () => { resolveA() })
    await settle()
    expect(screen.getByText(/BBB/)).toBeTruthy()
    expect(screen.queryByText(/AAA/)).toBeNull()
  })

  it('clears stale rows and resets filters on schedule switch', async () => {
    mocks.rpc.mockResolvedValue({ data: ['dept-1', 'dept-2'] })
    let resolveB
    const gateB = new Promise(r => { resolveB = r })
    let depCalls = 0
    mocks.fetchAllRows.mockImplementation(async (table) => {
      if (table === 'deployment_departments') return [{ id: 'dept-1', name: 'Traffic' }, { id: 'dept-2', name: 'Parking' }]
      if (table === 'deployments') {
        depCalls += 1
        if (depCalls === 1) {
          return [{ id: 'rA', schedule_id: 'sched-A', centre: 'DELHI', badge_number: 'AAA', department_id: 'dept-1' }]
        }
        await gateB
        return [{ id: 'rB', schedule_id: 'sched-B', centre: 'NOIDA', badge_number: 'BBB', department_id: 'dept-1' }]
      }
      if (table === 'dp_sewadars') {
        return [{ badge_number: 'AAA', sewadar_name: 'Aaa', centre: 'DELHI', is_initiated: true, gender: 'M' }]
      }
      return []
    })
    const { rerender } = render(<DeptInchargePage schedules={SCHEDS} scheduleId="sched-A" />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /Complete list/i }))
    await settle()
    expect(screen.getByText(/AAA/)).toBeTruthy()
    // point both client filters at the old rows
    fireEvent.change(screen.getByLabelText(/Filter by department/i), { target: { value: 'dept-1' } })
    fireEvent.change(screen.getByLabelText(/Filter by centre/i), { target: { value: 'DELHI' } })
    await settle()
    expect(screen.getByText(/AAA/)).toBeTruthy()
    // switch schedule — B's load hangs, so anything rendered now is stale
    rerender(<DeptInchargePage schedules={SCHEDS} scheduleId="sched-B" />)
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
    expect(screen.queryByText(/AAA/)).toBeNull()
    expect(screen.getByLabelText(/Filter by centre/i).value).toBe('')
    expect(screen.getByLabelText(/Filter by department/i).value).toBe('')
    // drain the hanging load so the test leaves no pending work
    await act(async () => { resolveB() })
    await settle()
  })
})

// T4: a late poll must not overwrite newer sessions, and a successful poll
// clears the stale-data pin.
describe('DeptInchargePage session poll guards (T4)', () => {
  it('late poll cannot overwrite newer sessions', async () => {
    vi.useFakeTimers()
    try {
      const today = todayStrIST()
      const sess = (t) => ({ id: 1, badge_number: 'B1', sewadar_name: 'Ram', sewadar_centre: 'DELHI', sewadar_dept: 'dept-1', in_date: today, out_date: null, in_time: t, out_time: null, is_vss: false, undeployed_scan: false, created_at: `2026-01-01T${t}:00.000Z` })
      mocks.rpc.mockResolvedValue({ data: ['dept-1'] })
      let resolveP1
      let sessCalls = 0
      mocks.fetchAllRows.mockImplementation(async (table) => {
        if (table === 'deployment_departments') return [{ id: 'dept-1', name: 'Traffic' }]
        if (table === 'deployments') {
          return [{ id: 'r1', schedule_id: 'sched-1', centre: 'DELHI', badge_number: 'B1', department_id: 'dept-1' }]
        }
        if (table === 'dp_attendance_sessions') {
          sessCalls += 1
          if (sessCalls === 1) return [sess('08:00')]
          if (sessCalls === 2) { await new Promise(r => { resolveP1 = r }); return [sess('06:00')] }
          return [sess('11:00')]
        }
        if (table === 'dp_sewadars') {
          return [{ badge_number: 'B1', sewadar_name: 'Ram', centre: 'DELHI', is_initiated: true, gender: 'M' }]
        }
        return []
      })
      mocks.exportWorkbook.mockResolvedValue(1)
      render(<DeptInchargePage schedules={SCHEDULES} scheduleId="sched-1" />)
      await act(async () => { await vi.advanceTimersByTimeAsync(100) })
      expect(sessCalls).toBe(1)
      // poll 1 starts and hangs on its deferred fetch
      await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
      expect(sessCalls).toBe(2)
      // poll 2 starts and lands fresh sessions immediately
      await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
      expect(sessCalls).toBe(3)
      // the stale poll 1 resolves last — it must be dropped
      await act(async () => { resolveP1(); await vi.advanceTimersByTimeAsync(100) })
      fireEvent.click(screen.getByRole('button', { name: /Complete list/i }))
      await act(async () => { await vi.advanceTimersByTimeAsync(100) })
      fireEvent.click(screen.getByRole('button', { name: /^Export$/i }))
      await act(async () => { await vi.advanceTimersByTimeAsync(100) })
      expect(mocks.exportWorkbook).toHaveBeenCalledTimes(1)
      expect(mocks.exportWorkbook.mock.calls[0][1][0].rows[0]['In Time']).toBe('11:00')
    } finally {
      vi.useRealTimers()
    }
  })

  it('successful poll clears the stale-data pin', async () => {
    vi.useFakeTimers()
    try {
      mocks.rpc.mockResolvedValue({ data: ['d1'] })
      let sessCalls = 0
      mocks.fetchAllRows.mockImplementation(async (table) => {
        if (table === 'dp_attendance_sessions') {
          sessCalls += 1
          if (sessCalls === 1) throw new Error('db down')
          return []
        }
        return []
      })
      render(<DeptInchargePage schedules={SCHEDULES} scheduleId="sched-1" />)
      await act(async () => { await vi.advanceTimersByTimeAsync(100) })
      expect(screen.getByText(/showing last data/)).toBeTruthy()
      await act(async () => { await vi.advanceTimersByTimeAsync(15100) })
      expect(screen.queryByText(/showing last data/)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

// T5: the same badge in two centres must stay distinct — one Present, one
// Absent, with per-centre In/Out and no duplicate-key warning.
describe('DeptInchargePage centre-qualified presence (T5)', () => {
  it('keeps the same badge in two centres distinct', async () => {
    const today = todayStrIST()
    mocks.rpc.mockResolvedValue({ data: ['dept-1'] })
    mocks.fetchAllRows.mockImplementation(async (table) => {
      if (table === 'deployment_departments') return [{ id: 'dept-1', name: 'Traffic' }]
      if (table === 'deployments') {
        return [
          { id: 'r1', schedule_id: 'sched-1', centre: 'DELHI', badge_number: 'B1', department_id: 'dept-1' },
          { id: 'r2', schedule_id: 'sched-1', centre: 'NOIDA', badge_number: 'B1', department_id: 'dept-1' },
        ]
      }
      if (table === 'dp_attendance_sessions') {
        return [{ id: 1, badge_number: 'B1', sewadar_name: 'Ram Delhi', sewadar_centre: 'DELHI', sewadar_dept: 'dept-1', in_date: today, out_date: null, in_time: '09:00', out_time: null, is_vss: false, undeployed_scan: false, created_at: '2026-01-01T09:00:00.000Z' }]
      }
      if (table === 'dp_sewadars') {
        return [
          { badge_number: 'B1', sewadar_name: 'Ram Delhi', centre: 'DELHI', is_initiated: true, gender: 'M' },
          { badge_number: 'B1', sewadar_name: 'Ram Noida', centre: 'NOIDA', is_initiated: false, gender: 'F' },
        ]
      }
      return []
    })
    mocks.exportWorkbook.mockResolvedValue(1)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      render(<DeptInchargePage schedules={SCHEDULES} scheduleId="sched-1" />)
      await settle()
      // one Present (DELHI), one Absent (NOIDA) — never both the same
      expect(screen.getByRole('button', { name: /Present \(1\)/ })).toBeTruthy()
      expect(screen.getByRole('button', { name: /Absent \(1\)/ })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: /Present \(1\)/ }))
      await settle()
      expect(screen.getByText('Ram Delhi')).toBeTruthy()
      expect(screen.queryByText('Ram Noida')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: /Absent \(1\)/ }))
      await settle()
      expect(screen.getByText('Ram Noida')).toBeTruthy()
      // export carries per-centre Status + In/Out
      fireEvent.click(screen.getByRole('button', { name: /Complete list/i }))
      await settle()
      fireEvent.click(screen.getByRole('button', { name: /^Export$/i }))
      await settle()
      const rows = mocks.exportWorkbook.mock.calls[0][1][0].rows
      expect(rows).toHaveLength(2)
      const delhi = rows.find(r => r.Centre === 'DELHI')
      const noida = rows.find(r => r.Centre === 'NOIDA')
      expect(delhi.Status).toBe('Present')
      expect(delhi['In Time']).toBe('09:00')
      expect(noida.Status).toBe('Absent')
      expect(noida['In Time']).toBe('—')
      // no duplicate-key warning from the two same-badge rows
      expect(errSpy.mock.calls.some(c => String(c[0]).match(/same key/i))).toBe(false)
    } finally {
      errSpy.mockRestore()
    }
  })
})

// T6: the export driver writes whatever name it is given, so the caller must
// include the .xlsx extension.
describe('DeptInchargePage export filename (T6)', () => {
  it('names the export file with a .xlsx extension', async () => {
    mocks.rpc.mockResolvedValue({ data: ['dept-1'] })
    mocks.fetchAllRows.mockImplementation(async (table) => {
      if (table === 'deployment_departments') return [{ id: 'dept-1', name: 'Traffic' }]
      if (table === 'deployments') {
        return [{ id: 'r1', schedule_id: 'sched-1', centre: 'DELHI', badge_number: 'B1', department_id: 'dept-1' }]
      }
      if (table === 'dp_sewadars') {
        return [{ badge_number: 'B1', sewadar_name: 'Ram', centre: 'DELHI', is_initiated: true, gender: 'M' }]
      }
      return []
    })
    mocks.exportWorkbook.mockResolvedValue(1)
    render(<DeptInchargePage schedules={SCHEDULES} scheduleId="sched-1" />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /Complete list/i }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /^Export$/i }))
    await settle()
    expect(mocks.exportWorkbook).toHaveBeenCalledTimes(1)
    expect(String(mocks.exportWorkbook.mock.calls[0][0]).endsWith('.xlsx')).toBe(true)
  })
})
// V9: recent scans are ordered by `created_at` desc, not id — and the export's
// In/Out comes from the newest-created_at session per badge. fetchAllRows
// pages id-ascending, so both tests hand the rows id-first with created_at
// disagreeing: the old code (fetch order / last-wins overwrite) fails them.
describe('DeptInchargePage recent scans order (V9)', () => {
  const OLDER = '2026-01-01T06:00:00.000Z'
  const NEWER = '2026-01-01T09:00:00.000Z'

  it('lists recent scans newest-created_at first even when the id order disagrees', async () => {
    const today = todayStrIST()
    mocks.rpc.mockResolvedValue({ data: ['dept-1'] })
    mocks.fetchAllRows.mockImplementation(async (table) => {
      if (table === 'dp_attendance_sessions') {
        // id-ascending fetch order, but the HIGHER id is the OLDER scan.
        return [
          { id: 3, badge_number: 'FB0001AA0001', sewadar_name: 'Old Scan', sewadar_dept: 'dept-1', in_date: today, out_date: null, in_time: '06:00', out_time: '07:00', is_vss: false, undeployed_scan: false, created_at: OLDER },
          { id: 9, badge_number: 'FB0001AA0002', sewadar_name: 'New Scan', sewadar_dept: 'dept-1', in_date: today, out_date: null, in_time: '09:00', out_time: null, is_vss: false, undeployed_scan: false, created_at: NEWER },
        ]
      }
      return []
    })
    const { container } = render(<DeptInchargePage schedules={SCHEDULES} scheduleId="sched-1" />)
    await settle()
    const badges = [...container.querySelectorAll('.scans-badge')].map(e => e.textContent)
    expect(badges).toHaveLength(2)
    // The id-9 row is the NEWER scan — it must head the list despite the sort
    // the old code inherited from the fetch.
    expect(badges[0]).toMatch(/FB0001AA0002/)
    expect(badges[1]).toMatch(/FB0001AA0001/)
  })

  it('exports the newest-created_at session per badge for In/Out', async () => {
    const today = todayStrIST()
    // Same badge twice, id-ascending fetch order, created_at inverted: the
    // FIRST row (lower id) is the newer scan. The old last-wins overwrite kept
    // the second row's 06:00/07:00 times.
    const both = [
      { id: 3, badge_number: 'FB0001AA0001', sewadar_name: 'Ram', sewadar_dept: 'dept-1', in_date: today, out_date: null, in_time: '09:00', out_time: null, is_vss: false, undeployed_scan: false, created_at: NEWER },
      { id: 9, badge_number: 'FB0001AA0001', sewadar_name: 'Ram', sewadar_dept: 'dept-1', in_date: today, out_date: null, in_time: '06:00', out_time: '07:00', is_vss: false, undeployed_scan: false, created_at: OLDER },
    ]
    mocks.rpc.mockResolvedValue({ data: ['dept-1'] })
    mocks.fetchAllRows.mockImplementation(async (table) => {
      if (table === 'deployment_departments') return [{ id: 'dept-1', name: 'Traffic' }]
      if (table === 'deployments') {
        return [{ id: 'r1', schedule_id: 'sched-1', centre: 'DELHI', badge_number: 'FB0001AA0001', department_id: 'dept-1' }]
      }
      if (table === 'dp_attendance_sessions') return both
      if (table === 'dp_sewadars') {
        return [{ badge_number: 'FB0001AA0001', sewadar_name: 'Ram', centre: 'DELHI', is_initiated: true, gender: 'M' }]
      }
      return []
    })
    mocks.exportWorkbook.mockResolvedValue(1)
    render(<DeptInchargePage schedules={SCHEDULES} scheduleId="sched-1" />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /Complete list/i }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /^Export$/i }))
    await settle()
    expect(mocks.exportWorkbook).toHaveBeenCalledTimes(1)
    const rows = mocks.exportWorkbook.mock.calls[0][1][0].rows
    expect(rows).toHaveLength(1)
    expect(rows[0]['In Time']).toBe('09:00')
    expect(rows[0]['Out Time']).toBe('—')
  })
})

describe('DeptInchargePage unified queue count + clear-live', () => {
  const rows = () => [
    { id: 'live-1', synced: false, failed: false, owner: 'u-1' },
    { id: 'dead-1', synced: false, status: 'failed', owner: 'u-1' },
  ]

  it('counts only live rows as queued and surfaces failed separately', async () => {
    mocks.rpc.mockResolvedValue({ data: ['dept-1'] })
    mocks.fetchAllRows.mockResolvedValue([])
    getQueuedScans.mockResolvedValue(rows())
    try {
      render(<DeptInchargePage schedules={SCHEDULES} scheduleId="sched-1" />)
      await settle()
      // Queue state is rendered by the shared QueueRecoveryBar (the same
      // surface every scanner role uses), so the counts appear ONCE —
      // live rows as "1 queued", the failed row with its own recovery action.
      expect(screen.getAllByText('1 queued')).toHaveLength(1)
      expect(screen.getByText('1 failed')).toBeTruthy()
      expect(screen.getByRole('button', { name: /clear failed \(1\)/i })).toBeTruthy()
    } finally { getQueuedScans.mockResolvedValue([]) }
  })

  it('wires a confirmed Clear live queued action to clearLiveQueue', async () => {
    mocks.rpc.mockResolvedValue({ data: ['dept-1'] })
    mocks.fetchAllRows.mockResolvedValue([])
    getQueuedScans.mockResolvedValue(rows())
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    try {
      render(<DeptInchargePage schedules={SCHEDULES} scheduleId="sched-1" />)
      await settle()
      const btn = screen.getByRole('button', { name: /clear live queued \(1\)/i })
      await act(async () => { btn.click(); await new Promise(r => setTimeout(r, 20)) })
      expect(clearLiveQueue).toHaveBeenCalledTimes(1)
    } finally { confirm.mockRestore(); getQueuedScans.mockResolvedValue([]); clearLiveQueue.mockClear() }
  })

  it('does NOT clear live rows when the confirm is declined', async () => {
    mocks.rpc.mockResolvedValue({ data: ['dept-1'] })
    mocks.fetchAllRows.mockResolvedValue([])
    getQueuedScans.mockResolvedValue(rows())
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    try {
      render(<DeptInchargePage schedules={SCHEDULES} scheduleId="sched-1" />)
      await settle()
      const btn = screen.getByRole('button', { name: /clear live queued \(1\)/i })
      await act(async () => { btn.click(); await new Promise(r => setTimeout(r, 20)) })
      expect(clearLiveQueue).not.toHaveBeenCalled()
    } finally { confirm.mockRestore(); getQueuedScans.mockResolvedValue([]); clearLiveQueue.mockClear() }
  })
})
