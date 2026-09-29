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
import DeptInchargePage from './DeptInchargePage'

const mocks = vi.hoisted(() => ({
  openCamera: vi.fn(),
  rpc: vi.fn(),
  fetchAllRows: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))

vi.mock('./scanner/cameraManager', async (importOriginal) => {
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
  installDrainListeners: vi.fn(() => vi.fn()),
  preloadDeployed: vi.fn(async () => {}),
  clearFailedQueue: vi.fn(async () => {}),
  clearOrphanedQueue: vi.fn(async () => {}),
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
    expect(tables).not.toContain('dp_s ewadars')
    expect(tables).not.toContain('vss_sewadars')
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
