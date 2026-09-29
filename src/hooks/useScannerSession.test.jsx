// @vitest-environment jsdom
/**
 * useScannerSession — the scan-session bundle shared by ScannerPage and
 * DeptInchargePage (extracted Phase B task 5: the two pages carried
 * near-identical popup/queue/forgot wiring and had already drifted once).
 *
 * Pins the moved behaviour (no silent change in the extraction) plus the
 * task-5 deltas: refreshQueue raises `syncing` while rows are pending
 * (L-44), and the forgot confirm keeps its offline parity (L-36) with no
 * follow-up IN while the OUT hasn't synced.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useScannerSession } from './useScannerSession'

const rpc = vi.fn()
const enqueueScan = vi.fn()
const getQueuedScans = vi.fn()
const installDrainListeners = vi.fn(() => vi.fn())

vi.mock('../lib/supabase', () => ({
  supabase: { rpc: (...args) => rpc(...args) },
}))
vi.mock('../lib/offlineQueue', () => ({
  getQueuedScans: (...args) => getQueuedScans(...args),
  enqueueScan: (...args) => enqueueScan(...args),
  installDrainListeners: (...args) => installDrainListeners(...args),
}))

const NOW = new Date('2026-09-24T12:00:00Z') // 17:30 IST
function istParts(d) {
  const ist = new Date(d.getTime() + (330 + new Date().getTimezoneOffset()) * 60000)
  const p = (n) => String(n).padStart(2, '0')
  return {
    date: `${ist.getFullYear()}-${p(ist.getMonth() + 1)}-${p(ist.getDate())}`,
    time: `${p(ist.getHours())}:${p(ist.getMinutes())}:00`,
    hm: `${p(ist.getHours())}:${p(ist.getMinutes())}`,
  }
}

function setup(overrides = {}) {
  const t = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
  const clearManual = vi.fn()
  const onAfterScan = vi.fn()
  const view = renderHook(() => useScannerSession({
    scheduleId: 'sched-1',
    profile: { centre: 'DELHI' },
    deptName: null,
    deptNameById: new Map(),
    toast: t,
    onAfterScan,
    forgotSuccessToast: 'OUT closed',
    clearManual,
    ...overrides,
  }))
  return { ...view, toast: t, clearManual, onAfterScan }
}

// A forgot form 1h after IN, answered 30min later — valid, never clamped.
function forgotState() {
  const inP = istParts(new Date(NOW.getTime() - 3600000))
  const answer = istParts(new Date(NOW.getTime() - 1800000))
  return {
    popup: {
      status: 'forgot', badge: 'FB5971GA0001',
      in_date: inP.date, in_time: inP.time, openId: 'open-1',
    },
    outTime: answer.hm,
  }
}

beforeEach(() => {
  rpc.mockReset()
  enqueueScan.mockReset()
  getQueuedScans.mockReset()
  installDrainListeners.mockReset()
  installDrainListeners.mockReturnValue(vi.fn())
  getQueuedScans.mockResolvedValue([])
  enqueueScan.mockResolvedValue({ ok: true, id: 'q-1' })
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
})

afterEach(() => { vi.useRealTimers() })

describe('useScannerSession bundle', () => {
  it('exposes the session bundle with empty initial state and subscribes the drain', () => {
    const { result, unmount } = setup()
    expect(result.current.popup).toBeNull()
    expect(result.current.outTime).toBe('')
    expect(result.current.busy).toBe(false)
    expect(result.current.queued).toEqual([])
    expect(result.current.syncing).toBe(false)
    for (const k of ['showPopup', 'closePopup', 'handleScan', 'handleCameraScan', 'confirmScan', 'confirmForgot', 'refreshQueue']) {
      expect(typeof result.current[k]).toBe('function')
    }
    expect(installDrainListeners).toHaveBeenCalledTimes(1)
    const off = installDrainListeners.mock.results[0].value
    unmount()
    expect(off).toHaveBeenCalledTimes(1)
  })

  it('showPopup/closePopup drive the popup state', () => {
    const { result, unmount } = setup()
    act(() => { result.current.showPopup({ status: 'in', badge: 'FB5971GA0001' }) })
    expect(result.current.popup).toMatchObject({ status: 'in' })
    act(() => { result.current.closePopup() })
    expect(result.current.popup).toBeNull()
    unmount()
  })

  // L-44: queue progress owns the syncing flag.
  it('refreshQueue raises syncing while rows are pending', async () => {
    getQueuedScans.mockResolvedValue([{ id: 'q-1', synced: false, failed: false }])
    const { result, unmount } = setup()
    await act(async () => { await result.current.refreshQueue() })
    expect(result.current.queued).toHaveLength(1)
    expect(result.current.syncing).toBe(true)
    unmount()
  })

  it('leaves syncing down when the queue is clean', async () => {
    getQueuedScans.mockResolvedValue([{ id: 'q-1', synced: true, failed: false }])
    const { result, unmount } = setup()
    await act(async () => { await result.current.refreshQueue() })
    expect(result.current.syncing).toBe(false)
    unmount()
  })

  // L-36 through the hook: offline forgot-OUT queues with the chosen ts.
  it('forgot confirm queues offline with the chosen ts and fires no follow-up', async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW)
    try {
      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
      rpc.mockRejectedValue(new Error('Failed to fetch'))
      const { popup, outTime } = forgotState()
      const { result, toast, unmount } = setup()
      act(() => { result.current.showPopup(popup) })
      act(() => { result.current.setOutTime(outTime) })
      await act(async () => { await result.current.confirmForgot() })
      expect(enqueueScan).toHaveBeenCalledWith(expect.objectContaining({
        badge: 'FB5971GA0001', action: 'OUT', open_id: 'open-1',
      }))
      expect(toast.success).not.toHaveBeenCalledWith('OUT closed')
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      expect(rpc).not.toHaveBeenCalledWith('scan_in', expect.anything())
      unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('forgot confirm online celebrates, closes, and follows up with the IN', async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW)
    try {
      rpc.mockResolvedValueOnce({ data: { ok: true }, error: null }) // scan_out
      rpc.mockResolvedValueOnce({ data: { open: null, last_out: null } }) // follow-up lookup
      rpc.mockResolvedValueOnce({ data: { ok: true }, error: null }) // follow-up scan_in
      const { popup, outTime } = forgotState()
      const { result, toast, clearManual, unmount } = setup()
      act(() => { result.current.showPopup(popup) })
      act(() => { result.current.setOutTime(outTime) })
      await act(async () => { await result.current.confirmForgot() })
      expect(toast.success).toHaveBeenCalledWith('OUT closed')
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      expect(rpc).toHaveBeenCalledWith('scan_in', expect.objectContaining({ p_badge: 'FB5971GA0001' }))
      expect(clearManual).toHaveBeenCalled()
      unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})
