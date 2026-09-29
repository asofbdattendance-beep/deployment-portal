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
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))

vi.mock('./scanner/cameraManager', async (importOriginal) => {
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
  mocks.fromCalls.length = 0
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
})
