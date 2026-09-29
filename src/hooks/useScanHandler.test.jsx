// @vitest-environment jsdom
// useScanHandler — the shared scan-in/out decision tree.
//
// The behaviour worth protecting is the ERROR CLASSIFICATION: only
// network/timeout errors may fall through to an offline enqueue, while
// auth/RLS/validation errors must surface to the operator. A regression
// that swallowed an RLS rejection would silently queue a scan that the
// server will never accept.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useScanHandler } from './useScanHandler'

const rpc = vi.fn()
const enqueueScan = vi.fn()
const getQueuedScans = vi.fn()

vi.mock('../lib/supabase', () => ({
  supabase: { rpc: (...args) => rpc(...args) },
}))
vi.mock('../lib/offlineQueue', () => ({
  enqueueScan: (...args) => enqueueScan(...args),
  getQueuedScans: (...args) => getQueuedScans(...args),
}))

const BADGE = 'FB5971GA0001'

// `overrides` is additive: every existing call passes nothing and keeps the
// exact same hook configuration.
function setup(overrides = {}) {
  const showPopup = vi.fn()
  const toast = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
  const onQueued = vi.fn()
  const onAfterScan = vi.fn()
  const view = renderHook(() =>
    useScanHandler({
      scheduleId: 'sched-1',
      profile: { centre: 'DELHI' },
      deptName: null,
      showPopup,
      toast,
      onQueued,
      onAfterScan,
      ...overrides,
    })
  )
  return { ...view, showPopup, toast, onQueued, onAfterScan }
}

beforeEach(() => {
  rpc.mockReset()
  enqueueScan.mockReset()
  getQueuedScans.mockReset()
  getQueuedScans.mockResolvedValue([])
  // Default: a successful enqueue under the A1 result contract. Tests that
  // need failure override with { ok:false, reason }. An unstubbed mock
  // resolves undefined, and `res.ok` on undefined would TypeError.
  enqueueScan.mockResolvedValue({ ok: true, id: 'q-default' })
  // default: online
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
})

afterEach(() => { vi.useRealTimers() })

describe('badge validation', () => {
  it('rejects a malformed badge before any RPC', async () => {
    const { result, showPopup } = setup()
    await act(async () => { await result.current.handleScan('NOT-A-BADGE') })
    expect(rpc).not.toHaveBeenCalled()
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', message: expect.stringContaining('Invalid badge') }))
  })

  it('ignores an empty scan', async () => {
    const { result } = setup()
    await act(async () => { await result.current.handleScan('   ') })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('accepts a VSS badge', async () => {
    rpc.mockResolvedValueOnce({ data: { open: null, last_out: null } })
    rpc.mockResolvedValueOnce({ data: { ok: true } })
    const { result, showPopup } = setup()
    await act(async () => { await result.current.handleScan('VS001') })
    expect(showPopup).toHaveBeenCalled()
  })
})

describe('scan_in on a fresh sewadar', () => {
  it('scans IN when there is no open session', async () => {
    // get_scan_state -> { open: null, last_out: null }, then scan_in -> ok
    rpc.mockResolvedValueOnce({ data: { open: null, last_out: null } })
    rpc.mockResolvedValueOnce({ data: { ok: true, undeployed: false } })
    const { result, showPopup, onAfterScan } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    expect(rpc).toHaveBeenCalledWith('get_scan_state', { p_badge: BADGE, p_schedule: 'sched-1' })
    expect(rpc).toHaveBeenCalledWith('scan_in', expect.objectContaining({ p_badge: BADGE, p_centre: 'DELHI' }))
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'in' }))
    expect(onAfterScan).toHaveBeenCalled()
    expect(enqueueScan).not.toHaveBeenCalled()
  })

  it('flags an undeployed scan', async () => {
    rpc.mockResolvedValueOnce({ data: null })
    rpc.mockResolvedValueOnce({ data: { ok: true, undeployed: true } })
    const { result, showPopup } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'flagged' }))
  })

  it('marks manual-entry scans with p_is_manual (camera scans send false)', async () => {
    // M3: the server stores is_manual and Scanner Ops reports it — a
    // hand-typed correction must not look like a camera scan.
    rpc.mockResolvedValueOnce({ data: { open: null, last_out: null } })
    rpc.mockResolvedValueOnce({ data: { ok: true } })
    const { result } = setup()
    await act(async () => { await result.current.handleScan(BADGE, { manual: true }) })
    expect(rpc).toHaveBeenCalledWith('scan_in', expect.objectContaining({ p_badge: BADGE, p_is_manual: true }))
  })
})

describe('scan_out when a session is open', () => {
  it('prompts for the OUT time instead of closing blind', async () => {
    rpc.mockResolvedValue({ data: { open: { id: 'open-1', status: 'OPEN', in_date: '2026-09-24', in_time: '09:00:00' }, last_out: null } })
    const { result, showPopup } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'forgot' }))
  })
})

describe('error classification', () => {
  it('surfaces an RLS/auth error instead of queueing it', async () => {
    const err = Object.assign(new Error('row-level security violation'), { code: '42501' })
    rpc.mockResolvedValueOnce({ data: null })
    rpc.mockRejectedValueOnce(err)
    const { result, toast, showPopup } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    expect(enqueueScan).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalled()
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }))
  })

  it('surfaces a validation error (Invalid badge) from the server', async () => {
    rpc.mockResolvedValueOnce({ data: null })
    rpc.mockRejectedValueOnce(new Error('Invalid badge format'))
    const { result, toast } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    expect(toast.error).toHaveBeenCalledWith('Invalid badge format')
  })

  it('queues when the browser is offline', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    rpc.mockRejectedValue(new Error('Failed to fetch'))
    enqueueScan.mockResolvedValue({ ok: true, id: 'q-1' })
    const { result, showPopup, onQueued } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    expect(enqueueScan).toHaveBeenCalledWith(expect.objectContaining({ badge: BADGE, action: 'IN' }))
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'queued' }))
    expect(onQueued).toHaveBeenCalled()
  })

  it('surfaces an error when offline storage is unavailable', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    rpc.mockRejectedValue(new Error('Failed to fetch'))
    enqueueScan.mockResolvedValue({ ok: false, reason: 'unavailable' })
    const { result, toast } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    expect(toast.error).toHaveBeenCalledWith('Offline storage unavailable')
  })

  // A2 (L-02): a full queue reports itself distinctly from missing storage.
  it('reports a full queue distinctly from unavailable storage', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    rpc.mockRejectedValue(new Error('Failed to fetch'))
    enqueueScan.mockResolvedValue({ ok: false, reason: 'full' })
    const { result, showPopup, toast } = setup()
    let out
    await act(async () => { out = await result.current.handleScan(BADGE) })
    expect(out).toEqual({ ok: false, reason: 'offline_queue_full' })
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', message: expect.stringContaining('full') }))
    expect(toast.error).toHaveBeenCalledWith('Offline queue is full')
  })

  it('reports a queue write failure distinctly', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    rpc.mockRejectedValue(new Error('Failed to fetch'))
    enqueueScan.mockResolvedValue({ ok: false, reason: 'write-failed', error: new Error('quota') })
    const { result, toast } = setup()
    let out
    await act(async () => { out = await result.current.handleScan(BADGE) })
    expect(out).toEqual({ ok: false, reason: 'offline_queue_write_failed' })
    expect(toast.error).toHaveBeenCalledWith('Offline queue write failed')
  })

  // A2 (L-01): an enqueueScan THROW (old contract) must not escape handleScan.
  it('never lets an enqueue rejection escape handleScan', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    rpc.mockRejectedValue(new Error('Failed to fetch'))
    enqueueScan.mockRejectedValue(new Error('IDB exploded'))
    const { result } = setup()
    let out
    await act(async () => { out = await result.current.handleScan(BADGE) })
    expect(typeof out.ok).toBe('boolean')
  })

  // A2 (L-09): same badge+action within 2s offline queues exactly once.
  it('suppresses a duplicate offline enqueue for the same badge+action', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    rpc.mockRejectedValue(new Error('Failed to fetch'))
    enqueueScan.mockResolvedValue({ ok: true, id: 'q-1' })
    const { result, toast } = setup()
    let first, second
    await act(async () => { first = await result.current.handleScan(BADGE) })
    await act(async () => { second = await result.current.handleScan(BADGE) })
    expect(first.ok).toBe(true)
    expect(second).toEqual({ ok: false, reason: 'duplicate_queued' })
    expect(enqueueScan).toHaveBeenCalledTimes(1)
    expect(toast.warning).toHaveBeenCalledWith('Already queued — ignoring duplicate scan')
  })

  it('queues an OUT — not a second IN — when offline with a pending queued IN', async () => {
    // C4: the operator scanned IN offline (queued), then scans again to go
    // OUT while still offline. The lookup fails, so server state is unknown —
    // but this device already holds an unsynced IN for the badge, which means
    // the intent is OUT. Queueing another IN would orphan the session.
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    rpc.mockRejectedValue(new Error('Failed to fetch'))
    getQueuedScans.mockResolvedValue([{ id: 'q-in', badge: BADGE, schedule_id: 'sched-1', action: 'IN', synced: false }])
    enqueueScan.mockResolvedValue({ ok: true, id: 'q-out' })
    const { result, showPopup, onQueued } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    expect(enqueueScan).toHaveBeenCalledWith(expect.objectContaining({ badge: BADGE, action: 'OUT' }))
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'queued' }))
    expect(onQueued).toHaveBeenCalled()
  })

  it('still queues an IN when offline with no pending IN for the badge', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    rpc.mockRejectedValue(new Error('Failed to fetch'))
    getQueuedScans.mockResolvedValue([])
    enqueueScan.mockResolvedValue({ ok: true, id: 'q-1' })
    const { result } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    expect(enqueueScan).toHaveBeenCalledWith(expect.objectContaining({ badge: BADGE, action: 'IN' }))
  })
})

describe('busy flag', () => {
  it('blocks a second scan while one is in flight', async () => {
    let release
    rpc.mockImplementationOnce(() => new Promise((res) => { release = res }))
    const { result } = setup()
    let first
    act(() => { first = result.current.handleScan(BADGE) })
    expect(result.current.busy).toBe(true)
    await act(async () => { await result.current.handleScan(BADGE) }) // must be ignored
    expect(rpc).toHaveBeenCalledTimes(1)
    await act(async () => { release({ data: null }); await first })
  })

  it('resets the busy flag after a completed scan', async () => {
    rpc.mockResolvedValueOnce({ data: null })
    rpc.mockResolvedValueOnce({ data: { ok: true } })
    const { result } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    expect(result.current.busy).toBe(false)
  })
})

// ─── D-1: a session-lookup timeout is NOT "no open session" ────────────────────
describe('session lookup timeout (D-1)', () => {
  // A >5s get_open_session is abandoned by withTimeout's LOCAL AbortController
  // while still in flight, so the sewadar's real session state is UNKNOWN.
  // Falling through to scan_in produces the 'Already IN' dead end.
  it('does NOT fall through to scan_in when the lookup times out', async () => {
    rpc.mockRejectedValueOnce(new Error('Session lookup timed out after 5000ms'))
    const { result, showPopup, toast } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('get_scan_state', { p_badge: BADGE, p_schedule: 'sched-1' })
    expect(rpc).not.toHaveBeenCalledWith('scan_in', expect.anything())
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', message: expect.stringContaining('timed out') }))
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('timed out'))
  })

  it('reports a distinct reason so the caller can offer a retry', async () => {
    rpc.mockRejectedValueOnce(new Error('Session lookup timed out after 5000ms'))
    const { result } = setup()
    let out
    await act(async () => { out = await result.current.handleScan(BADGE) })
    expect(out).toEqual({ ok: false, reason: 'session_lookup_timeout' })
  })

  it('still queues when the device is genuinely offline (timeout while offline)', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    rpc.mockRejectedValueOnce(new Error('Session lookup timed out after 5000ms'))
    rpc.mockRejectedValueOnce(new Error('Failed to fetch'))
    enqueueScan.mockResolvedValue({ ok: true, id: 'q-1' })
    const { result, showPopup } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    expect(enqueueScan).toHaveBeenCalledWith(expect.objectContaining({ badge: BADGE, action: 'IN' }))
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'queued' }))
  })

  it('surfaces a timeout on the post-Already-IN re-fetch instead of the dead end', async () => {
    rpc.mockResolvedValueOnce({ data: null }) // no open session
    rpc.mockRejectedValueOnce(new Error('Already IN')) // scan_in
    rpc.mockRejectedValueOnce(new Error('Session lookup timed out after 5000ms')) // re-fetch
    const { result, showPopup } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      message: expect.stringContaining('timed out'),
    }))
    expect(showPopup).not.toHaveBeenCalledWith(expect.objectContaining({
      message: 'Already checked IN — please OUT first',
    }))
  })
})

// ─── D-2: the re-fetch's error field is captured, not dropped ──────────────────
describe('get_scan_state PostgREST error (D-2)', () => {
  it('surfaces a returned error object on the first lookup', async () => {
    // `error` resolved (not thrown) — the old `.then(r => r.data)` shape lost it.
    // An RLS/permission rejection must surface, NOT be swallowed into a
    // scan_in fall-through (which would queue a scan the server will refuse).
    // v44 note: PGRST202 is deliberately excluded here — a missing v44 is a
    // deploy-ordering condition, not a permission failure, and it degrades
    // (see the v44 fallback describe below) instead of surfacing.
    rpc.mockResolvedValueOnce({ data: null, error: Object.assign(new Error('permission denied for table'), { code: '42501' }) })
    const { result, showPopup, toast } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }))
    expect(toast.error).toHaveBeenCalled()
  })

  it('surfaces a returned error object on the post-Already-IN re-fetch, not a dead end', async () => {
    rpc.mockResolvedValueOnce({ data: { open: null, last_out: null } })
    rpc.mockRejectedValueOnce(new Error('Already IN'))
    rpc.mockResolvedValueOnce({ data: null, error: Object.assign(new Error('permission denied'), { code: '42501' }) })
    const { result, showPopup, toast } = setup()
    let out
    await act(async () => { out = await result.current.handleScan(BADGE) })
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }))
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('permission denied'))
    expect(out).toEqual({ ok: false, reason: 'session_lookup_failed' })
  })

  it('still reports the plain Already-IN message when the re-fetch genuinely returns null', async () => {
    rpc.mockResolvedValueOnce({ data: null })
    rpc.mockRejectedValueOnce(new Error('Already IN'))
    rpc.mockResolvedValueOnce({ data: null, error: null })
    const { result, showPopup, toast } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', message: 'Already checked IN — please OUT first' }))
    expect(toast.error).toHaveBeenCalledWith('Already IN — OUT first')
  })

  // L-39: the Already-IN refetch path showed the forgot prompt (with its
  // ">12h open" pill and destructive "Close OUT then IN") for a session of
  // ANY age. A 2-minute session must get the plain Already-IN error instead.
  it('refetches a young session as plain Already-IN, not a forgot prompt', async () => {
    vi.useFakeTimers(); vi.setSystemTime(FIXED_NOW)
    rpc.mockResolvedValueOnce({ data: null }) // first lookup: no open session
    rpc.mockRejectedValueOnce(new Error('Already IN')) // scan_in
    rpc.mockResolvedValueOnce({ data: { open: { id: 'open-9', status: 'OPEN', ...istStamp(2, 'in') }, last_out: null } }) // refetch: 2h old
    const { result, showPopup } = setup()
    let out
    await act(async () => { out = await result.current.handleScan(BADGE) })
    expect(out.ok).toBe(false)
    expect(out.outTimeDefault).toBeUndefined()
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', message: 'Already checked IN — please OUT first' }))
    expect(showPopup).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'forgot' }))
  })
})

// ─── D-3: the online scan_in carries the same nonce the drain will replay ──────
describe('idempotency nonce (D-3)', () => {
  it('passes a p_nonce on the ONLINE scan_in', async () => {
    rpc.mockResolvedValueOnce({ data: null })
    rpc.mockResolvedValueOnce({ data: { ok: true } })
    const { result } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    const call = rpc.mock.calls.find(([name]) => name === 'scan_in')
    expect(call).toBeTruthy()
    expect(call[1].p_nonce).toEqual(expect.any(String))
    expect(call[1].p_nonce.length).toBeGreaterThan(8)
  })

  it('reuses that SAME nonce as the queued row id, so the drain replays it', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    // Commit-then-lost-response: scan_in rejects at the network, so the client
    // enqueues. The drain sends p_nonce: q.id — that id must be the online nonce.
    rpc.mockResolvedValueOnce({ data: null })
    rpc.mockRejectedValueOnce(new Error('Failed to fetch'))
    enqueueScan.mockResolvedValue({ ok: true, id: 'q-1' })
    const { result } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    const scanInArgs = rpc.mock.calls.find(([name]) => name === 'scan_in')[1]
    const queued = enqueueScan.mock.calls[0][0]
    expect(queued.id).toBe(scanInArgs.p_nonce)
  })

  it('gives each attempt a fresh nonce', async () => {
    // Two full IN flows: get_open_session -> null, then scan_in -> ok, twice.
    rpc.mockResolvedValueOnce({ data: null })
    rpc.mockResolvedValueOnce({ data: { ok: true } })
    rpc.mockResolvedValueOnce({ data: null })
    rpc.mockResolvedValueOnce({ data: { ok: true } })
    const { result } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    await act(async () => { await result.current.handleScan(BADGE) })
    const nonces = rpc.mock.calls.filter(([n]) => n === 'scan_in').map(([, a]) => a.p_nonce)
    expect(nonces).toHaveLength(2)
    expect(nonces[0]).not.toBe(nonces[1])
  })
})

// ─── D-4: every exit resolves to { ok: boolean } ───────────────────────────────
describe('return contract (D-4)', () => {
  const OFFLINE = () => Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
  // An open session 9h old — old enough to be a real session, young enough
  // (<12h) to take the blind-OUT path instead of the forgot-OUT prompt.
  const recentIn = () => {
    const ist = new Date(Date.now() + (330 + Number(new Date().getTimezoneOffset())) * 60000)
    const d = new Date(ist.getTime() - 9 * 3600000)
    const p = (n) => String(n).padStart(2, '0')
    return { in_date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, in_time: `${p(d.getHours())}:${p(d.getMinutes())}:00` }
  }

  // Each case drives one exit and asserts the resolved shape. A bare `return`
  // (undefined) makes `const { ok } = await handleScan(x)` throw a TypeError.
  const CASES = [
    {
      name: 'busy (a scan is already in flight)',
      async drive({ result, first }) {
        let release
        rpc.mockImplementationOnce(() => new Promise((res) => { release = res }))
        let inflight
        act(() => { inflight = result.current.handleScan(BADGE) })
        const out = await result.current.handleScan(BADGE) // ignored by the busy flag
        await act(async () => { release({ data: null }); await inflight })
        return { out, first }
      },
    },
    {
      name: 'empty badge',
      async drive({ result }) { return { out: await result.current.handleScan('   ') } },
    },
    {
      name: 'invalid badge format',
      async drive({ result }) { return { out: await result.current.handleScan('NOPE') } },
    },
    {
      name: 'IN offline storage unavailable',
      async drive({ result }) {
        OFFLINE()
        rpc.mockResolvedValueOnce({ data: null })
        rpc.mockRejectedValueOnce(new Error('Failed to fetch'))
        enqueueScan.mockResolvedValue({ ok: false, reason: 'unavailable' })
        return { out: await result.current.handleScan(BADGE) }
      },
    },
    {
      name: 'OUT offline storage unavailable',
      async drive({ result }) {
        OFFLINE()
        // An open session is found, so scan_out runs and then fails to queue.
        // The IN must be <12h old or the flow diverts to the forgot-OUT prompt
        // (which resolves ok:true) and never reaches scan_out.
        rpc.mockResolvedValueOnce({ data: { open: { id: 'open-1', status: 'OPEN', ...recentIn() }, last_out: null } })
        rpc.mockRejectedValueOnce(new Error('Failed to fetch'))
        enqueueScan.mockResolvedValue({ ok: false, reason: 'unavailable' })
        return { out: await result.current.handleScan(BADGE) }
      },
    },
  ]

  it.each(CASES)('$name resolves to { ok: boolean }', async (c) => {
    const ctx = setup()
    let out
    await act(async () => { out = (await c.drive({ result: ctx.result, first: null })).out })
    expect(out).toBeTypeOf('object')
    expect(out).not.toBeNull()
    expect(typeof out.ok).toBe('boolean')
  })

  it('the 5 non-ok exits all report ok === false', async () => {
    for (const c of CASES) {
      const ctx = setup()
      rpc.mockReset(); enqueueScan.mockReset(); OFFLINE()
      // The wipe above leaves the mock returning undefined; re-establish the
      // failure default so drives that never enqueue (busy/empty/invalid)
      // still exercise a defined contract. Drives that enqueue override this.
      enqueueScan.mockResolvedValue({ ok: false, reason: 'unavailable' })
      let out
      await act(async () => { out = (await c.drive({ result: ctx.result, first: null })).out })
      expect(out.ok, `${c.name} should not report success`).toBe(false)
      expect(typeof out.reason).toBe('string')
    }
  })

  it('successful scans resolve ok === true', async () => {
    const ctx = setup()
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
    rpc.mockResolvedValueOnce({ data: null })
    rpc.mockResolvedValueOnce({ data: { ok: true } })
    let out
    await act(async () => { out = await ctx.result.current.handleScan(BADGE) })
    expect(out).toEqual({ ok: true })
  })

  it('the forgot-OUT prompt resolves ok === true with an outTimeDefault', async () => {
    const ctx = setup()
    rpc.mockResolvedValueOnce({ data: { open: { id: 'open-1', status: 'OPEN', in_date: '2026-09-24', in_time: '01:00:00' }, last_out: null } })
    let out
    await act(async () => { out = await ctx.result.current.handleScan(BADGE) })
    expect(out.ok).toBe(true)
    expect(out.outTimeDefault).toMatch(/^\d{2}:\d{2}$/)
  })

  // A4 / L-05 — the prefill must be IST, and must survive a device whose zone
  // OR clock is wrong. FIXED_NOW = 2026-09-27T12:00:00Z = 17:30 IST.
  it('prefills the forgot-OUT in IST (17:30), not the device-local hour', async () => {
    vi.useFakeTimers(); vi.setSystemTime(FIXED_NOW)
    rpc.mockResolvedValueOnce({ data: { open: { id: 'open-1', status: 'OPEN', ...istStamp(20, 'in') }, last_out: null } })
    const ctx = setup()
    let out
    await act(async () => { out = await ctx.result.current.handleScan(BADGE) })
    expect(out.outTimeDefault).toBe('17:30')
  })

  it('carries in_time on the forgot popup so the page can enforce order vs IN', async () => {
    vi.useFakeTimers(); vi.setSystemTime(FIXED_NOW)
    rpc.mockResolvedValueOnce({ data: { open: { id: 'open-1', status: 'OPEN', ...istStamp(20, 'in') }, last_out: null } })
    const { result, showPopup } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({
      status: 'forgot', in_time: expect.stringMatching(/^\d{2}:\d{2}:\d{2}$/),
    }))
  })

  it('clamps a future prefill to now when the device clock runs fast (no doomed write)', async () => {
    // Device clock 6h AHEAD of FIXED_NOW: skewed now = 18:00Z = 23:30 IST.
    // IN is 26h before the skewed now, so the forgot path still triggers and
    // the prefill must be the (skewed) now, strictly after the IN.
    vi.useFakeTimers(); vi.setSystemTime(new Date(FIXED_NOW.getTime() + 6 * 3600000))
    rpc.mockResolvedValueOnce({ data: { open: { id: 'open-1', status: 'OPEN', in_date: '2026-09-26', in_time: '21:30:00' }, last_out: null } })
    const ctx = setup()
    let out
    await act(async () => { out = await ctx.result.current.handleScan(BADGE) })
    expect(out.outTimeDefault).toBe('23:30')
    const inTs = Date.parse('2026-09-26T21:30:00+05:30')
    expect(Date.parse(`2026-09-27T${out.outTimeDefault}:00+05:30`)).toBeGreaterThan(inTs)
  })
})

// ── get_open_session's NO-SESSION payload shape ──────────────────────────────
//
// `get_open_session` returns a TABLE ROW TYPE, and plpgsql's
// `SELECT * INTO v_row … LIMIT 1` + `RETURN v_row` yields an ALL-NULL record
// when nothing is found. Verified on PG 15: `to_jsonb(fn())` on that record is
//   {"id": null, "status": null, "in_date": null, "in_time": null, …}
// — a JSON OBJECT, not `null`. PostgREST serialises the composite that way, so
// `data` arrives truthy and the old `data || null` read it as "a session
// exists". The client therefore ALWAYS took the OUT branch, `open.id` was
// null, `scan_out` fell back to its own lookup, found nothing open, and
// answered "No open session to close" — on a sewadar who had never scanned IN.
// The IN branch was unreachable.
// v44 `get_scan_state` returns jsonb, so a miss is a genuine `null` inside the
// object and the all-NULL-record trap can no longer reach it. The trap is only
// still reachable through the pre-v44 `get_open_session` fallback — so that is
// exactly where it is now pinned.
const FIXED_NOW = new Date('2026-09-27T12:00:00Z')
// in_date / out_date + in_time / out_time as the DB stores them: bare IST
// columns with no offset, which the client re-interprets as +05:30.
function istStamp(hoursAgo, prefix) {
  const d = new Date(FIXED_NOW.getTime() + (330 + new Date().getTimezoneOffset()) * 60000 - hoursAgo * 3600000)
  const p = (n) => String(n).padStart(2, '0')
  return {
    [`${prefix}_date`]: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    [`${prefix}_time`]: `${p(d.getHours())}:${p(d.getMinutes())}:00`,
  }
}

describe('scan-state "no session" payload shapes', () => {
  const NULL_ROW = { id: null, status: null, in_date: null, in_time: null, schedule_id: null, badge_number: null }

  it('treats the legacy all-NULL row payload as NO session, and scans IN', async () => {
    // PGRST202 -> the pre-v44 fallback -> get_open_session's real PostgREST shape
    rpc.mockResolvedValueOnce({ data: null, error: Object.assign(new Error('function get_scan_state does not exist'), { code: 'PGRST202' }) })
    rpc.mockResolvedValueOnce({ data: NULL_ROW })          // the real PostgREST shape
    rpc.mockResolvedValueOnce({ data: { ok: true } })      // scan_in
    const { result, showPopup } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    expect(rpc).toHaveBeenCalledWith('scan_in', expect.objectContaining({ p_badge: BADGE }))
    expect(rpc).not.toHaveBeenCalledWith('scan_out', expect.anything())
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'in' }))
  })

  it('treats an empty array payload as NO session, and scans IN', async () => {
    rpc.mockResolvedValueOnce({ data: [] })
    rpc.mockResolvedValueOnce({ data: { ok: true } })
    const { result } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    expect(rpc).toHaveBeenCalledWith('scan_in', expect.objectContaining({ p_badge: BADGE }))
    expect(rpc).not.toHaveBeenCalledWith('scan_out', expect.anything())
  })

  it('still takes the OUT branch for a genuine open session', async () => {
    // 2h old: outside the v44 1h confirm gate, inside the 12h forgot threshold,
    // so this is the plain automatic-OUT band. Fixed clock so it cannot drift.
    vi.useFakeTimers(); vi.setSystemTime(FIXED_NOW)
    rpc.mockResolvedValueOnce({ data: { open: { id: 'open-1', status: 'OPEN', ...istStamp(2, 'in') }, last_out: null } })
    rpc.mockResolvedValueOnce({ data: { ok: true } })      // scan_out
    const { result, showPopup } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    expect(rpc).toHaveBeenCalledWith('scan_out', expect.objectContaining({ p_badge: BADGE, p_open_id: 'open-1' }))
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'out' }))
  })

  it('unwraps a single-element array of a real session', async () => {
    // PostgREST may serialise a function return as a 1-row set.
    vi.useFakeTimers(); vi.setSystemTime(FIXED_NOW)
    rpc.mockResolvedValueOnce({ data: [{ open: { id: 'open-9', status: 'OPEN', ...istStamp(2, 'in') }, last_out: null }] })
    rpc.mockResolvedValueOnce({ data: { ok: true } })
    const { result } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    expect(rpc).toHaveBeenCalledWith('scan_out', expect.objectContaining({ p_open_id: 'open-9' }))
  })
})

// ─── popup identity: name / HOME centre / deployed-dept NAME ────────────────
// Since v40 `dp_attendance_sessions.centre` is a single physical scan VENUE
// ("Bhati - Delhi MC"), not the sewadar's centre — the home centre lives in
// `sewadar_centre`. These pin the popup to the home centre and to the
// sewadar's own department name, never the venue and never the operator's
// page-level dept filter (`deptName`, which stays correct only inside the
// "Not deployed to <dept>" flag text).
describe('popup display fields', () => {
  it('shows name, home centre and dept name from the v43 scan_in payload', async () => {
    rpc.mockResolvedValueOnce({ data: null })
    rpc.mockResolvedValueOnce({
      data: {
        ok: true, undeployed: false,
        sewadar_name: 'Ramesh Lal', sewadar_centre: 'DELHI-7', dept_name: 'Jal Vihar',
      },
    })
    const { result, showPopup } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({
      status: 'in',
      name: 'Ramesh Lal',
      centre: 'DELHI-7',
      deptName: 'Jal Vihar',
    }))
  })

  it('never falls back to the venue when a payload carries only `centre`', async () => {
    // `centre` is the scan venue since v40; with no `sewadar_centre` the popup
    // shows no centre at all rather than mislabelling the sewadar.
    rpc.mockResolvedValueOnce({ data: null })
    rpc.mockResolvedValueOnce({ data: { ok: true, undeployed: false, centre: 'Bhati - Delhi MC' } })
    const { result, showPopup } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    const payload = showPopup.mock.calls[0][0]
    expect(payload.centre).toBeNull()
    expect(payload.centre).not.toBe('Bhati - Delhi MC')
  })

  it('resolves the OUT popup from the session row, not the venue', async () => {
    // 2h old so it clears the v44 1h confirm gate and auto-OUTs.
    vi.useFakeTimers(); vi.setSystemTime(FIXED_NOW)
    rpc.mockResolvedValueOnce({
      data: {
        open: {
          id: 'open-1', status: 'OPEN', ...istStamp(2, 'in'),
          sewadar_name: 'Sita Devi', sewadar_centre: 'DELHI-9',
          centre: 'Bhati - Delhi MC',           // the VENUE — must never surface
          sewadar_dept: 'uuid-1',
        },
        last_out: null,
      },
    })
    rpc.mockResolvedValueOnce({ data: { ok: true } }) // scan_out
    const { result, showPopup } = setup({ deptNameById: new Map([['uuid-1', 'Traffic']]) })
    await act(async () => { await result.current.handleScan(BADGE) })
    const payload = showPopup.mock.calls[0][0]
    expect(payload).toEqual(expect.objectContaining({
      status: 'out',
      name: 'Sita Devi',
      centre: 'DELHI-9',
      deptName: 'Traffic',
    }))
    expect(payload.centre).not.toBe('Bhati - Delhi MC')
  })

  it('degrades gracefully on a pre-v43 scan_in response', async () => {
    rpc.mockResolvedValueOnce({ data: null })
    rpc.mockResolvedValueOnce({ data: { ok: true, undeployed: false } })
    const { result, showPopup } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    // The popup still fires with the right status — the display fields being
    // null is an acceptable degradation, a crash or a missing popup is not.
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'in' }))
  })

  it('still flags an undeployed scan and keeps the page-level dept in the flag text', async () => {
    rpc.mockResolvedValueOnce({ data: null })
    rpc.mockResolvedValueOnce({
      data: {
        ok: true, undeployed: true,
        sewadar_name: 'Ramesh Lal', sewadar_centre: 'DELHI-7', dept_name: 'Jal Vihar',
      },
    })
    const { result, showPopup } = setup({ deptName: 'Traffic' })
    await act(async () => { await result.current.handleScan(BADGE) })
    const payload = showPopup.mock.calls[0][0]
    expect(payload.status).toBe('flagged')
    // Identity fields come from the scan; the FLAG text still names the
    // operator's own department, which is what that sentence means.
    expect(payload.deptName).toBe('Jal Vihar')
    expect(payload.flag).toContain('Traffic')
  })
})

// ═══ v44: the 1-hour confirm gate ═══════════════════════════════════════════
//
// The IN↔OUT ladder is right, but a toggle inside 1h of the opposite event is
// almost never deliberate — a double tap, or a badge left in front of the lens.
// The invariant worth protecting is the NEGATIVE one: a gated scan must write
// NOTHING. Every test below asserts the write RPC was never called, because a
// gate that still writes on the way to asking is worse than no gate at all.
describe('v44 toggle guard (1h)', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(FIXED_NOW) })

  const openSession = (hoursAgo, extra = {}) => ({
    open: { id: 'open-1', status: 'OPEN', ...istStamp(hoursAgo, 'in'), ...extra },
    last_out: null,
  })
  const closedSession = (hoursAgo, extra = {}) => ({
    open: null,
    last_out: { id: 'old-1', status: 'CLOSED', ...istStamp(hoursAgo, 'out'), ...extra },
  })

  describe('IN → OUT direction', () => {
    it('holds the write and asks when the OUT lands 10 min after the IN', async () => {
      rpc.mockResolvedValueOnce({ data: openSession(10 / 60) })  // 10 minutes
      const { result, showPopup } = setup()
      let out
      await act(async () => { out = await result.current.handleScan(BADGE) })
      expect(rpc).not.toHaveBeenCalledWith('scan_out', expect.anything())
      expect(rpc).not.toHaveBeenCalledWith('scan_in', expect.anything())
      expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({
        status: 'confirm_out', badge: BADGE, openId: 'open-1',
        message: expect.stringContaining('mark OUT?'),
      }))
      expect(out).toEqual({ ok: false, reason: 'confirm_required', action: 'OUT' })
    })

    it('toggles automatically once the IN is older than 1h (2h)', async () => {
      rpc.mockResolvedValueOnce({ data: openSession(2) })
      rpc.mockResolvedValueOnce({ data: { ok: true } })
      const { result, showPopup } = setup()
      await act(async () => { await result.current.handleScan(BADGE) })
      expect(rpc).toHaveBeenCalledWith('scan_out', expect.objectContaining({ p_open_id: 'open-1' }))
      expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'out' }))
    })

    it('exactly 1h is outside the gate (strictly-less-than boundary)', async () => {
      rpc.mockResolvedValueOnce({ data: openSession(1) })
      rpc.mockResolvedValueOnce({ data: { ok: true } })
      const { result, showPopup } = setup()
      await act(async () => { await result.current.handleScan(BADGE) })
      expect(rpc).toHaveBeenCalledWith('scan_out', expect.objectContaining({ p_open_id: 'open-1' }))
      expect(showPopup).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'confirm_out' }))
    })

    it('Cancel is a no-op: nothing is written and the only popup is the question', async () => {
      rpc.mockResolvedValueOnce({ data: openSession(10 / 60) })
      const { result, showPopup, onAfterScan } = setup()
      await act(async () => { await result.current.handleScan(BADGE) })
      expect(rpc).toHaveBeenCalledTimes(1)          // the lookup only
      expect(showPopup).toHaveBeenCalledTimes(1)
      expect(showPopup.mock.calls[0][0].status).toBe('confirm_out')
      // Nothing was written, so nothing needs refreshing.
      expect(onAfterScan).not.toHaveBeenCalled()
    })
  })

  describe('OUT → IN direction', () => {
    it('holds the write and asks when the IN lands 15 min after the OUT', async () => {
      rpc.mockResolvedValueOnce({ data: closedSession(0.25) })
      const { result, showPopup } = setup()
      let out
      await act(async () => { out = await result.current.handleScan(BADGE) })
      expect(rpc).not.toHaveBeenCalledWith('scan_in', expect.anything())
      expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({
        status: 'confirm_in', badge: BADGE, message: expect.stringContaining('mark IN?'),
      }))
      expect(out).toEqual({ ok: false, reason: 'confirm_required', action: 'IN' })
    })

    it('resolves the confirm_in popup identity from the last_out row', async () => {
      rpc.mockResolvedValueOnce({ data: closedSession(0.25, { sewadar_name: 'Sita Devi', sewadar_centre: 'DELHI-9', centre: 'Bhati - Delhi MC' }) })
      const { result, showPopup } = setup()
      await act(async () => { await result.current.handleScan(BADGE) })
      const p = showPopup.mock.calls[0][0]
      expect(p.name).toBe('Sita Devi')
      expect(p.centre).toBe('DELHI-9')       // home centre, never the venue
      expect(p.centre).not.toBe('Bhati - Delhi MC')
    })

    it('scans IN automatically when the last OUT was 3h ago', async () => {
      rpc.mockResolvedValueOnce({ data: closedSession(3) })
      rpc.mockResolvedValueOnce({ data: { ok: true } })
      const { result, showPopup } = setup()
      await act(async () => { await result.current.handleScan(BADGE) })
      expect(rpc).toHaveBeenCalledWith('scan_in', expect.objectContaining({ p_badge: BADGE }))
      expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'in' }))
    })

    it('never prompts a sewadar who has never been scanned (last_out null)', async () => {
      rpc.mockResolvedValueOnce({ data: { open: null, last_out: null } })
      rpc.mockResolvedValueOnce({ data: { ok: true } })
      const { result, showPopup } = setup()
      await act(async () => { await result.current.handleScan(BADGE) })
      expect(rpc).toHaveBeenCalledWith('scan_in', expect.objectContaining({ p_badge: BADGE }))
      expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'in' }))
    })
  })

  describe('Confirm', () => {
    it('confirmed + openId writes that exact session with NO second lookup', async () => {
      rpc.mockResolvedValueOnce({ data: { ok: true } })  // only scan_out
      const { result, showPopup } = setup()
      await act(async () => {
        await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'OUT', openId: 'open-1', display: { name: 'Sita Devi' } })
      })
      expect(rpc).toHaveBeenCalledTimes(1)
      expect(rpc).not.toHaveBeenCalledWith('get_scan_state', expect.anything())
      expect(rpc).toHaveBeenCalledWith('scan_out', expect.objectContaining({ p_badge: BADGE, p_open_id: 'open-1' }))
      expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'out', name: 'Sita Devi' }))
    })

    it('reports an already-closed session honestly instead of OUT marked', async () => {
      // I3: someone else closed the pinned session between prompt and Confirm.
      // The server answers ok/dedup — that is NOT a fresh OUT.
      rpc.mockResolvedValueOnce({ data: { ok: true, dedup: true, message: 'Session already closed' } })
      const { result, showPopup, toast } = setup()
      const out = await act(async () => result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'OUT', openId: 'open-1' }))
      expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'out', message: expect.stringMatching(/already/i) }))
      expect(toast.success).not.toHaveBeenCalled()
      expect(out.ok).toBe(true)
    })

    it('surfaces a stale openId rather than toggling whatever replaced it', async () => {
      // v41's guard: the prompt named a session that is no longer open.
      rpc.mockRejectedValueOnce(new Error('Session does not match badge/schedule'))
      const { result, toast, showPopup } = setup()
      const out = await act(async () => result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'OUT', openId: 'gone-1' }))
      expect(rpc).toHaveBeenCalledTimes(1)
      expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }))
      expect(toast.error).toHaveBeenCalled()
      expect(out.ok).toBe(false)
    })

    it('confirmed without an openId re-resolves state and writes the IN', async () => {
      rpc.mockResolvedValueOnce({ data: { open: null, last_out: null } })
      rpc.mockResolvedValueOnce({ data: { ok: true } })
      const { result, showPopup } = setup()
      await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
      expect(rpc).toHaveBeenCalledWith('scan_in', expect.objectContaining({ p_badge: BADGE }))
      expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'in' }))
    })

    it('queues the confirmed OUT offline, carrying the pinned open_id', async () => {
      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
      rpc.mockRejectedValueOnce(new Error('Failed to fetch'))
      enqueueScan.mockResolvedValue({ ok: true, id: 'q-9' })
      const { result, showPopup, onQueued } = setup()
      const out = await act(async () => result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'OUT', openId: 'open-1' }))
      expect(enqueueScan).toHaveBeenCalledWith(expect.objectContaining({
        badge: BADGE, action: 'OUT', open_id: 'open-1',
      }))
      expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'queued' }))
      expect(onQueued).toHaveBeenCalled()
      expect(out.ok).toBe(true)
    })

    it('surfaces offline storage being unavailable on the confirmed OUT', async () => {
      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
      rpc.mockRejectedValueOnce(new Error('Failed to fetch'))
      enqueueScan.mockResolvedValue({ ok: false, reason: 'unavailable' })
      const { result, toast } = setup()
      const out = await act(async () => result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'OUT', openId: 'open-1' }))
      expect(toast.error).toHaveBeenCalledWith('Offline storage unavailable')
      expect(out).toEqual({ ok: false, reason: 'offline_storage_unavailable' })
    })

    it('a confirm_in approval must NEVER write an OUT', async () => {
      // The sewadar was OUT, so the operator was shown `confirm_in` and has no
      // openId. Before they click Confirm, another operator (or this scanner's
      // own 2s re-fire) marks that sewadar IN. The approval was minted for an
      // IN — it must not authorise closing a session it never asked about,
      // which is the exact 90-second session this feature exists to prevent.
      rpc.mockResolvedValueOnce({ data: { open: { id: 'other-op', status: 'OPEN', ...istStamp(0.2, 'in') }, last_out: null } })
      const { result, showPopup } = setup()
      await act(async () => {
        await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN', openId: null })
      })
      expect(rpc).not.toHaveBeenCalledWith('scan_out', expect.anything())
      // It is re-prompted instead — the guard is intact, just re-asked.
      expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'confirm_out' }))
    })

    it('a confirm_out approval is not carried across a direction change either', async () => {
      // Minted for OUT; the session has since closed, so the next entry is an
      // IN that is equally inside the guard window.
      rpc.mockResolvedValueOnce({ data: { open: null, last_out: { id: 'x', status: 'CLOSED', ...istStamp(0.1, 'out') } } })
      const { result, showPopup } = setup()
      await act(async () => {
        await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'OUT', openId: null })
      })
      expect(rpc).not.toHaveBeenCalledWith('scan_in', expect.anything())
      expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'confirm_in' }))
    })

    it('an approval with no direction disarms nothing (fail-closed)', async () => {
      rpc.mockResolvedValueOnce({ data: { open: { id: 'open-1', status: 'OPEN', ...istStamp(0.2, 'in') }, last_out: null } })
      const { result, showPopup } = setup()
      await act(async () => { await result.current.handleScan(BADGE, { confirmed: true }) })
      expect(rpc).not.toHaveBeenCalledWith('scan_out', expect.anything())
      expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'confirm_out' }))
    })

    it('recovers to the forgot-OUT prompt when the post-Already-IN re-fetch finds the session', async () => {
      // The client thought there was no open session, the server disagreed.
      // The re-fetch turns that dead end back into a normal forgot-OUT prompt.
      rpc.mockResolvedValueOnce({ data: { open: null, last_out: null } })
      rpc.mockRejectedValueOnce(new Error('Already IN'))
      rpc.mockResolvedValueOnce({ data: { open: { id: 'open-1', status: 'OPEN', ...istStamp(20, 'in') }, last_out: null } })
      const { result, showPopup } = setup()
      const out = await act(async () => result.current.handleScan(BADGE))
      expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({
        status: 'forgot', badge: BADGE, openId: 'open-1', in_date: expect.any(String),
      }))
      expect(out.ok).toBe(true)
      expect(out.outTimeDefault).toMatch(/^\d{2}:\d{2}$/)
    })

    it('A4: the post-Already-IN forgot prefill is IST too (both sites, not one)', async () => {
      vi.useFakeTimers(); vi.setSystemTime(FIXED_NOW)
      rpc.mockResolvedValueOnce({ data: { open: null, last_out: null } })
      rpc.mockRejectedValueOnce(new Error('Already IN — OUT first'))
      rpc.mockResolvedValueOnce({ data: { open: { id: 'open-2', status: 'OPEN', ...istStamp(20, 'in') }, last_out: null } })
      const { result } = setup()
      let out
      await act(async () => { out = await result.current.handleScan(BADGE) })
      expect(out.outTimeDefault).toBe('17:30')
    })
  })

  describe('pre-v44 fallback (v44 not applied yet)', () => {
    it('degrades to get_open_session on PGRST202 instead of failing every scan', async () => {
      rpc.mockResolvedValueOnce({ data: null, error: Object.assign(new Error('function get_scan_state does not exist'), { code: 'PGRST202' }) })
      rpc.mockResolvedValueOnce({ data: { id: 'open-1', status: 'OPEN', ...istStamp(2, 'in') } })
      rpc.mockResolvedValueOnce({ data: { ok: true } })
      const { result, showPopup } = setup()
      await act(async () => { await result.current.handleScan(BADGE) })
      expect(rpc).toHaveBeenCalledWith('get_open_session', { p_badge: BADGE, p_schedule: 'sched-1' })
      // The OUT ladder still works — this is the whole point of the fallback.
      expect(rpc).toHaveBeenCalledWith('scan_out', expect.objectContaining({ p_open_id: 'open-1' }))
      expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'out' }))
    })
  })
})
