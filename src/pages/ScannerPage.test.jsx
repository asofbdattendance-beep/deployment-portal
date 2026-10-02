// @vitest-environment jsdom
/**
 * ScannerPage — page-owned wiring pins (Phase B task 6, L-23).
 *
 * Scan behaviour is pinned in useScannerSession / useScanHandler; this file
 * pins what only the page can get wrong: the session query shape (L-41:
 * event-date or(), never in_date-only) and the render integration.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render, act, cleanup, screen } from '@testing-library/react'
import { todayStrIST } from '../lib/scannerUtils'
import ScannerPage from './ScannerPage'

const mocks = vi.hoisted(() => ({
  openCamera: vi.fn(),
  fromCalls: [],
  rpc: vi.fn(),
  fetchAllRows: vi.fn(),
  getQueuedScans: vi.fn(),
  clearFailedQueue: vi.fn(),
  clearLiveQueue: vi.fn(),
  clearOrphanedQueue: vi.fn(),
  listStrandedQueue: vi.fn(),
  removeQueued: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))

// V10: the path must reach the cameraManager the component actually imports
// (src/components/scanner/cameraManager). The old './scanner/cameraManager'
// resolved to a non-existent src/pages/scanner/* module, so this mock applied
// to nothing and the page silently tested the REAL openCamera.
vi.mock('../components/scanner/cameraManager', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, openCamera: (...args) => mocks.openCamera(...args) }
})
vi.mock('../lib/supabase', () => ({
  supabase: {
    from: (table) => {
      mocks.fromCalls.push(['from', table])
      const q = {
        select: (...a) => { mocks.fromCalls.push(['select', ...a]); return q },
        eq: (...a) => { mocks.fromCalls.push(['eq', ...a]); return q },
        or: (...a) => { mocks.fromCalls.push(['or', ...a]); return q },
        order: (...a) => { mocks.fromCalls.push(['order', ...a]); return q },
        limit: (...a) => { mocks.fromCalls.push(['limit', ...a]); return q },
        then: (res) => Promise.resolve(res({ data: [] })),
      }
      return q
    },
    rpc: (...args) => mocks.rpc(...args),
  },
  fetchAllRows: (...args) => mocks.fetchAllRows(...args),
}))
vi.mock('../context/PortalAuthContext', () => ({
  usePortalAuth: () => ({ profile: { centre: 'DELHI', badge_number: 'FB0001AA0001' } }),
}))
vi.mock('../components/Toast', () => ({ useToast: () => mocks.toast }))
vi.mock('../lib/offlineQueue', () => ({
  getQueuedScans: (...args) => mocks.getQueuedScans(...args),
  installDrainListeners: vi.fn(() => vi.fn()),
  preloadDeployed: vi.fn(async () => {}),
  clearFailedQueue: (...args) => mocks.clearFailedQueue(...args),
  clearLiveQueue: (...args) => mocks.clearLiveQueue(...args),
  clearOrphanedQueue: (...args) => mocks.clearOrphanedQueue(...args),
  listStrandedQueue: (...args) => mocks.listStrandedQueue(...args),
  removeQueued: (...args) => mocks.removeQueued(...args),
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
  mocks.getQueuedScans.mockReset()
  mocks.clearFailedQueue.mockReset()
  mocks.clearLiveQueue.mockReset()
  mocks.clearOrphanedQueue.mockReset()
  mocks.listStrandedQueue.mockReset()
  mocks.removeQueued.mockReset()
  mocks.fromCalls.length = 0
  for (const k of ['success', 'error', 'warning', 'info']) mocks.toast[k].mockReset()

  const stream = makeStream()
  mocks.openCamera.mockResolvedValue({ stream, track: stream.track, torchSupported: false, deviceId: 'rear', resolutionIndex: 0, adopted: false })
  mocks.rpc.mockResolvedValue({ data: null })
  mocks.fetchAllRows.mockResolvedValue([])
  mocks.getQueuedScans.mockResolvedValue([])
  mocks.listStrandedQueue.mockResolvedValue([])
  mocks.removeQueued.mockResolvedValue(undefined)

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

describe('ScannerPage session query (L-41)', () => {
  it('queries sessions with the event-date or() predicate, never in_date-only', async () => {
    render(<ScannerPage schedules={SCHEDULES} scheduleId="sched-1" />)
    await settle()
    const today = todayStrIST()
    expect(mocks.fromCalls).toContainEqual(['from', 'dp_attendance_sessions'])
    expect(mocks.fromCalls).toContainEqual(['or', `in_date.eq.${today},out_date.eq.${today}`])
    // An in_date-only read misses overnight sessions (IN yesterday, OUT
    // today) and contradicts the Incharge page and the Daily tab.
    expect(mocks.fromCalls.filter(c => c[0] === 'eq' && c[1] === 'in_date')).toHaveLength(0)
  })
})

describe('ScannerPage render', () => {
  it('renders the scanner card with an empty recent-scans table', async () => {
    render(<ScannerPage schedules={SCHEDULES} scheduleId="sched-1" />)
    await settle()
    expect(screen.getByText('Scanner')).toBeTruthy()
    expect(screen.getByText('No scans by you yet today')).toBeTruthy()
    expect(screen.getByPlaceholderText('Manual FB/BH/VS badge')).toBeTruthy()
  })

  // V10 failing-first: with the old './scanner/cameraManager' mock path the
  // mock applied to nothing, so the page tested the REAL openCamera and this
  // assertion failed (mock never called, no <video> in ready state).
  it('applies the cameraManager mock (openCamera called, preview ready)', async () => {
    const { container } = render(<ScannerPage schedules={SCHEDULES} scheduleId="sched-1" />)
    await settle()
    expect(mocks.openCamera).toHaveBeenCalled()
    expect(container.querySelector('video')).toBeTruthy()
  })

  // Mobile shell: at phone widths the page renders the immersive shell (same
  // state machine, same slots) instead of the desktop cards.
  it('renders the immersive scan shell on phone viewports', async () => {
    const realMatchMedia = window.matchMedia
    Object.defineProperty(window, 'matchMedia', {
      configurable: true, writable: true,
      value: vi.fn((query) => ({
        matches: String(query).includes('768'),
        media: query,
        addEventListener: vi.fn(), removeEventListener: vi.fn(),
        addListener: vi.fn(), removeListener: vi.fn(),
      })),
    })
    try {
      const { container } = render(<ScannerPage schedules={SCHEDULES} scheduleId="sched-1" />)
      await settle()
      expect(container.querySelector('.scan-shell')).toBeTruthy()
      expect(container.querySelector('.scan-shell-go')).toBeTruthy()
      expect(container.querySelector('video')).toBeTruthy()
    } finally {
      if (realMatchMedia) Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: realMatchMedia })
      else delete window.matchMedia
    }
  })
})

describe('ScannerPage queue pills (V16)', () => {
  it('surfaces failed rows with a count and wires Clear failed', async () => {
    mocks.getQueuedScans.mockResolvedValue([
      { id: 'bad-1', synced: false, failed: true, status: 'failed', owner: 'u-1' },
      { id: 'live-1', synced: false, failed: false, owner: 'u-1' },
    ])
    render(<ScannerPage schedules={SCHEDULES} scheduleId="sched-1" />)
    await settle()
    // Counted pills: 1 pending + 1 failed.
    expect(screen.getByText('1 queued')).toBeTruthy()
    expect(screen.getByText('1 failed')).toBeTruthy()
    const btn = screen.getByRole('button', { name: /clear failed \(1\)/i })
    await act(async () => { btn.click(); await new Promise(r => setTimeout(r, 20)) })
    expect(mocks.clearFailedQueue).toHaveBeenCalledTimes(1)
  })

  it('surfaces orphaned rows with a count and wires Clear orphaned', async () => {
    mocks.getQueuedScans.mockResolvedValue([
      { id: 'orph-1', synced: false, failed: false, owner: null },
    ])
    render(<ScannerPage schedules={SCHEDULES} scheduleId="sched-1" />)
    await settle()
    expect(screen.getByText('1 orphaned')).toBeTruthy()
    const btn = screen.getByRole('button', { name: /clear orphaned \(1\)/i })
    await act(async () => { btn.click(); await new Promise(r => setTimeout(r, 20)) })
    expect(mocks.clearOrphanedQueue).toHaveBeenCalledTimes(1)
  })

  it('shows no queue pills when the queue is empty', async () => {
    render(<ScannerPage schedules={SCHEDULES} scheduleId="sched-1" />)
    await settle()
    expect(screen.queryByText(/queued/)).toBeNull()
    expect(screen.queryByText(/failed/)).toBeNull()
    expect(screen.queryByText(/orphaned/)).toBeNull()
    expect(screen.queryByText(/stranded/)).toBeNull()
  })
})

describe('ScannerPage stranded scans (T10)', () => {
  it('surfaces stranded rows with a count and per-row Clear wired to removeQueued', async () => {
    mocks.listStrandedQueue.mockResolvedValue([
      { id: 'strand-1', badge: 'VS0001', action: 'IN', synced: false, owner: null },
      { id: 'strand-2', badge: 'VS0002', action: 'OUT', synced: false, owner: null },
    ])
    render(<ScannerPage schedules={SCHEDULES} scheduleId="sched-1" />)
    await settle()
    expect(screen.getByText('2 stranded')).toBeTruthy()
    expect(screen.getByText(/Stranded scans \(2\)/)).toBeTruthy()
    const btns = screen.getAllByRole('button', { name: 'Clear' })
    expect(btns).toHaveLength(2)
    // Per-row Clear removes exactly that row, then refreshes the list.
    mocks.listStrandedQueue.mockResolvedValue([
      { id: 'strand-2', badge: 'VS0002', action: 'OUT', synced: false, owner: null },
    ])
    await act(async () => { btns[0].click(); await new Promise(r => setTimeout(r, 20)) })
    expect(mocks.removeQueued).toHaveBeenCalledTimes(1)
    expect(mocks.removeQueued).toHaveBeenCalledWith('strand-1')
    await settle()
    expect(screen.getByText('1 stranded')).toBeTruthy()
  })

  it('shows no stranded section when listStrandedQueue is empty', async () => {
    render(<ScannerPage schedules={SCHEDULES} scheduleId="sched-1" />)
    await settle()
    expect(screen.queryByText(/stranded/)).toBeNull()
    expect(mocks.removeQueued).not.toHaveBeenCalled()
  })
})

describe('ScannerPage unified live count + clear-live + stranded interval', () => {
  it('excludes orphaned rows from the live queued count (shown separately)', async () => {
    mocks.getQueuedScans.mockResolvedValue([
      { id: 'live-1', synced: false, failed: false, owner: 'u-1' },
      { id: 'orph-1', synced: false, failed: false, owner: null },
    ])
    render(<ScannerPage schedules={SCHEDULES} scheduleId="sched-1" />)
    await settle()
    // Live only — the orphaned row must not inflate the sync pill.
    expect(screen.getByText('1 queued')).toBeTruthy()
    expect(screen.getByText('1 orphaned')).toBeTruthy()
  })

  it('wires a confirmed Clear live queued action to clearLiveQueue', async () => {
    mocks.getQueuedScans.mockResolvedValue([
      { id: 'live-1', synced: false, failed: false, owner: 'u-1' },
    ])
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    try {
      render(<ScannerPage schedules={SCHEDULES} scheduleId="sched-1" />)
      await settle()
      const btn = screen.getByRole('button', { name: /clear live queued \(1\)/i })
      await act(async () => { btn.click(); await new Promise(r => setTimeout(r, 20)) })
      expect(mocks.clearLiveQueue).toHaveBeenCalledTimes(1)
    } finally { confirm.mockRestore() }
  })

  it('does NOT clear live rows when the confirm is declined', async () => {
    mocks.getQueuedScans.mockResolvedValue([
      { id: 'live-1', synced: false, failed: false, owner: 'u-1' },
    ])
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    try {
      render(<ScannerPage schedules={SCHEDULES} scheduleId="sched-1" />)
      await settle()
      const btn = screen.getByRole('button', { name: /clear live queued \(1\)/i })
      await act(async () => { btn.click(); await new Promise(r => setTimeout(r, 20)) })
      expect(mocks.clearLiveQueue).not.toHaveBeenCalled()
    } finally { confirm.mockRestore() }
  })

  it('re-checks stranded scans on a 30s interval (mount + periodic)', async () => {
    const spy = vi.spyOn(window, 'setInterval')
    try {
      render(<ScannerPage schedules={SCHEDULES} scheduleId="sched-1" />)
      await settle()
      expect(spy.mock.calls.some(c => c[1] === 30000)).toBe(true)
      expect(mocks.listStrandedQueue).toHaveBeenCalled()
    } finally { spy.mockRestore() }
  })
})
