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
const subscribeOfflineSync = vi.fn(() => vi.fn())

vi.mock('../lib/supabase', () => ({
  supabase: { rpc: (...args) => rpc(...args) },
}))
vi.mock('../lib/offlineQueue', () => ({
  getQueuedScans: (...args) => getQueuedScans(...args),
  enqueueScan: (...args) => enqueueScan(...args),
  // Real implementations: the hook shares the canonical predicates now.
  isFailedQueueRow: (r) => !!r && (r.status === 'failed' || r.failed === true),
  isOrphanedQueueRow: (r) => !(!!r && (r.status === 'failed' || r.failed === true)) && (r?.owner ?? null) === null && !r?.synced,
}))
vi.mock('../lib/offlineSync', () => ({
  subscribeOfflineSync: (...args) => subscribeOfflineSync(...args),
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
  subscribeOfflineSync.mockReset()
  subscribeOfflineSync.mockReturnValue(vi.fn())
  getQueuedScans.mockResolvedValue([])
  enqueueScan.mockResolvedValue({ ok: true, id: 'q-1' })
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
})

afterEach(() => { vi.useRealTimers() })

describe('useScannerSession bundle', () => {
  it('exposes the session bundle with empty initial state and subscribes to the app-level sync engine', () => {
    const { result, unmount } = setup()
    expect(result.current.popup).toBeNull()
    expect(result.current.outTime).toBe('')
    expect(result.current.busy).toBe(false)
    expect(result.current.queued).toEqual([])
    expect(result.current.syncing).toBe(false)
    for (const k of ['showPopup', 'closePopup', 'handleScan', 'handleCameraScan', 'commitScan', 'confirmForgot', 'refreshQueue']) {
      expect(typeof result.current[k]).toBe('function')
    }
    expect(subscribeOfflineSync).toHaveBeenCalledTimes(1)
    const off = subscribeOfflineSync.mock.results[0].value
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
    getQueuedScans.mockResolvedValue([{ id: 'q-1', synced: false, failed: false, owner: 'user-A' }])
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
      rpc.mockResolvedValueOnce({ data: { open: null, last_out: null } }) // scan_out
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

  // T11(b): a follow-up re-IN dropped as busy must surface a warning, never a
  // silent success. The first scan stays inflight (holds busy) while the
  // forgot-OUT closes online; the 200ms follow-up then races it and loses.
  it('a busy follow-up re-IN surfaces a warning and no false IN success', async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW)
    try {
      let releaseFirst
      rpc.mockImplementation((fn) =>
        fn === 'scan_out'
          ? Promise.resolve({ data: { ok: true }, error: null })
          : new Promise((res) => { releaseFirst = res })
      )
      const { popup, outTime } = forgotState()
      const { result, toast, unmount } = setup()
      // Start a scan and leave it inflight — busy is now held.
      act(() => { result.current.handleScan('FB5971GA0001') })
      act(() => { result.current.showPopup(popup) })
      act(() => { result.current.setOutTime(outTime) })
      await act(async () => { await result.current.confirmForgot() })
      expect(toast.success).toHaveBeenCalledWith('OUT closed')
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      expect(toast.warning).toHaveBeenCalledWith('follow-up IN did not land — re-scan')
      expect(result.current.popup).toMatchObject({ status: 'error', badge: 'FB5971GA0001' })
      // No false success: the only success toast is the OUT celebration —
      // no `IN <badge>` was ever shown for the dropped re-IN.
      expect(toast.success).toHaveBeenCalledTimes(1)
      await act(async () => { releaseFirst({ data: { open: null, last_out: null }, error: null }) })
      unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  // T11(a) hook side: handleCameraScan declines synchronously while a
  // decision popup is open or a scan is inflight, so the camera suppressor
  // is not burned on a scan that never ran.
  it('handleCameraScan returns false while decision-pending or busy', async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW)
    try {
      let releaseFirst
      rpc.mockImplementation(() => new Promise((res) => { releaseFirst = res }))
      const { result, toast, unmount } = setup()
      let r
      act(() => { result.current.showPopup({ status: 'forgot', badge: 'FB5971GA0001', in_date: '2026-09-24', in_time: '17:00:00', openId: 'o-1' }) })
      act(() => { r = result.current.handleCameraScan('FB5971GA0002') })
      expect(r).toBe(false)
      expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/pending prompt/i))
      act(() => { result.current.closePopup() })
      act(() => { result.current.handleScan('FB5971GA0001') }) // holds busy
      act(() => { r = result.current.handleCameraScan('FB5971GA0002') })
      expect(r).toBe(false)
      expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/busy/i))
      await act(async () => { releaseFirst({ data: { open: null, last_out: null }, error: null }) })
      unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('camera pause effect (L-46)', () => {  it('pauses while a decision popup is open and resumes when it resolves', () => {
    const { result, unmount } = setup()
    const pause = vi.fn(), resume = vi.fn()
    act(() => { result.current.scannerRef.current = { pause, resume } })
    act(() => { result.current.showPopup({ status: 'confirm_out', badge: 'X' }) })
    expect(pause).toHaveBeenCalledTimes(1)
    expect(resume).not.toHaveBeenCalled()
    act(() => { result.current.showPopup({ status: 'in', badge: 'X' }) })
    expect(resume).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('ignores non-decision popups and never resumes without a prior pause', () => {
    const { result, unmount } = setup()
    const pause = vi.fn(), resume = vi.fn()
    act(() => { result.current.scannerRef.current = { pause, resume } })
    act(() => { result.current.showPopup({ status: 'in', badge: 'X' }) })
    act(() => { result.current.closePopup() })
    expect(pause).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
    unmount()
  })
})

describe('useScannerSession V15 hardening', () => {
  function setupWithSchedule(initial = 'sched-1') {
    const t = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
    const clearManual = vi.fn()
    const onAfterScan = vi.fn()
    const view = renderHook(({ scheduleId }) => useScannerSession({
      scheduleId,
      profile: { centre: 'DELHI' },
      deptName: null,
      deptNameById: new Map(),
      toast: t,
      onAfterScan,
      forgotSuccessToast: 'OUT closed',
      clearManual,
    }), { initialProps: { scheduleId: initial } })
    return { ...view, toast: t, clearManual, onAfterScan }
  }

  it('store snapshots update queued/syncing and never reject (V15 .catch)', async () => {
    const { result, unmount } = setup()
    const subscriber = subscribeOfflineSync.mock.calls[0][0]
    await act(async () => { subscriber({ queued: [{ id: 'q-1', synced: false, failed: false, owner: 'user-A' }] }) })
    expect(result.current.queued).toHaveLength(1)
    expect(result.current.syncing).toBe(true)
    await act(async () => { subscriber({ queued: [] }) })
    expect(result.current.queued).toEqual([])
    expect(result.current.syncing).toBe(false)
    // A malformed snapshot must not surface as an unhandled rejection.
    await act(async () => { subscriber(undefined) })
    unmount()
  })

  it('refreshQueue lowers syncing once the queue empties (V16)', async () => {
    getQueuedScans.mockResolvedValue([{ id: 'q-1', synced: false, failed: false, owner: 'user-A' }])
    const { result, unmount } = setup()
    await act(async () => { await result.current.refreshQueue() })
    expect(result.current.syncing).toBe(true)
    getQueuedScans.mockResolvedValue([])
    await act(async () => { await result.current.refreshQueue() })
    expect(result.current.syncing).toBe(false)
    expect(result.current.queued).toEqual([])
    unmount()
  })

  it('a schedule switch clears a stale decision popup (V15 schedule key)', () => {
    const { result, rerender, unmount } = setupWithSchedule('sched-1')
    act(() => { result.current.showPopup({ status: 'confirm_out', badge: 'FB5971GA0001', openId: 'o-1' }) })
    expect(result.current.popup).toMatchObject({ status: 'confirm_out', scheduleId: 'sched-1' })
    rerender({ scheduleId: 'sched-2' })
    expect(result.current.popup).toBeNull()
    unmount()
  })

  it('commit refuses a popup stamped with the previous schedule (V15 guard)', async () => {
    rpc.mockResolvedValue({ data: { ok: true }, error: null })
    const { result, rerender, toast, unmount } = setupWithSchedule('sched-1')
    act(() => { result.current.showPopup({ status: 'choose', action: 'OUT', badge: 'FB5971GA0001', openId: 'o-1' }) })
    // Simulate a popup that survived the switch (e.g. set just before it).
    rerender({ scheduleId: 'sched-2' })
    act(() => { result.current.showPopup({ status: 'choose', action: 'OUT', badge: 'FB5971GA0001', openId: 'o-1', scheduleId: 'sched-1' }) })
    await act(async () => { await result.current.commitScan() })
    expect(rpc).not.toHaveBeenCalledWith('scan_in', expect.anything())
    expect(rpc).not.toHaveBeenCalledWith('scan_out', expect.anything())
    expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/schedule changed/i))
    expect(result.current.popup).toBeNull()
    unmount()
  })

  it('a manual scan behind an open decision popup is dropped, not swapped in (V15 gate)', async () => {
    rpc.mockResolvedValue({ data: { ok: true }, error: null })
    const { result, toast, unmount } = setup()
    act(() => { result.current.showPopup({ status: 'forgot', badge: 'FB5971GA0001', in_date: '2026-09-24', in_time: '17:00:00', openId: 'o-1' }) })
    // act() does not propagate the callback's return — capture it outside.
    let r
    await act(async () => { r = await result.current.handleScan('FB5971GA0002', { manual: true }) })
    expect(r).toMatchObject({ ok: false, reason: 'decision-pending' })
    expect(rpc).not.toHaveBeenCalled()
    expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/pending prompt/i))
    // The pending question is untouched.
    expect(result.current.popup).toMatchObject({ badge: 'FB5971GA0001', status: 'forgot' })
    unmount()
  })

  it('a confirmed follow-up bypasses the decision gate (V15)', async () => {
    rpc.mockResolvedValue({ data: { ok: true }, error: null })
    const { result, unmount } = setup()
    act(() => { result.current.showPopup({ status: 'choose', action: 'OUT', badge: 'FB5971GA0001', openId: 'o-1' }) })
    await act(async () => { await result.current.commitScan() })
    // The commit path reached the server (scan_out against the pinned id).
    expect(rpc).toHaveBeenCalledWith('scan_out', expect.objectContaining({ p_open_id: 'o-1' }))
    unmount()
  })

  it('a choose popup never auto-dismisses — it waits for the operator tap', async () => {
    vi.useFakeTimers()
    try {
      const { result, unmount } = setup()
      act(() => { result.current.showPopup({ status: 'choose', action: 'IN', badge: 'FB5971GA0001' }) })
      await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
      expect(result.current.popup).toMatchObject({ status: 'choose', action: 'IN' })
      unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('commit carries the manual flag so a hand-typed correction keeps its audit mark', async () => {
    rpc.mockResolvedValue({ data: { ok: true }, error: null })
    const { result, unmount } = setup()
    act(() => { result.current.showPopup({ status: 'choose', action: 'IN', badge: 'FB5971GA0001', manual: true }) })
    await act(async () => { await result.current.commitScan() })
    expect(rpc).toHaveBeenCalledWith('scan_in', expect.objectContaining({ p_badge: 'FB5971GA0001', p_is_manual: true }))
    unmount()
  })
})
