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
import { render, act, cleanup, screen } from '@testing-library/react'
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
    expect(screen.getByText('Not a Dept Incharge for this schedule')).toBeTruthy()
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
