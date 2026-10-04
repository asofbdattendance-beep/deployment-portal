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
// V11: timeout assertions below are built from the REAL withTimeout message
// format — never a hardcoded copy — so a format change fails loudly here.
import { withTimeout } from '../lib/scannerUtils'

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
  // Default: a successful enqueue under the A1 result contract (owner set,
  // as in production for a signed-in scanner). Tests that need failure
  // override with { ok:false, reason }; owner-null tests override the owner.
  // An unstubbed mock resolves undefined, and `res.ok` on undefined would
  // TypeError.
  enqueueScan.mockResolvedValue({ ok: true, id: 'q-default', owner: 'user-A' })
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

  it('accepts a noisy-but-recoverable badge (sanitised before validation)', async () => {
    rpc.mockResolvedValueOnce({ data: { open: null, last_out: null } })
    rpc.mockResolvedValueOnce({ data: { ok: true } })
    const { result, showPopup } = setup()
    // Code-39 guards + lower case + a positional O→0 confusion — all recovered.
    await act(async () => { await result.current.handleScan('*fb5978ga00O5*') })
    expect(rpc).toHaveBeenCalled()
    expect(showPopup).toHaveBeenCalled()
  })

  it('rejects a bare number that matches no badge pattern', async () => {
    const { result, showPopup } = setup()
    await act(async () => { await result.current.handleScan('982762371') })
    expect(rpc).not.toHaveBeenCalled()
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', message: expect.stringContaining('Invalid badge') }))
  })
})

// Explicit choice: a plain scan NEVER writes. It resolves state and shows a
// `choose` popup; the write happens only on the committed callback.
describe('explicit choice: a plain scan never writes', () => {
  it('shows Mark IN (not an IN write) when there is no open session', async () => {
    // get_scan_state -> { open: null, last_out: null }, then NOTHING.
    rpc.mockResolvedValueOnce({ data: { open: null, last_out: null } })
    const { result, showPopup, onAfterScan } = setup()
    let out
    await act(async () => { out = await result.current.handleScan(BADGE) })
    expect(rpc).toHaveBeenCalledWith('get_scan_state', { p_badge: BADGE, p_schedule: 'sched-1' })
    expect(rpc).not.toHaveBeenCalledWith('scan_in', expect.anything())
    expect(rpc).not.toHaveBeenCalledWith('scan_out', expect.anything())
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'choose', action: 'IN', badge: BADGE }))
    expect(out).toEqual({ ok: false, reason: 'confirm_required', action: 'IN' })
    // Nothing was written, so nothing needs refreshing.
    expect(onAfterScan).not.toHaveBeenCalled()
    expect(enqueueScan).not.toHaveBeenCalled()
  })

  it('committing the IN choice writes scan_in and celebrates', async () => {
    rpc.mockResolvedValueOnce({ data: { open: null, last_out: null } })
    rpc.mockResolvedValueOnce({ data: { ok: true, undeployed: false } })
    const { result, showPopup, onAfterScan } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
    expect(rpc).toHaveBeenCalledWith('scan_in', expect.objectContaining({ p_badge: BADGE, p_centre: 'DELHI' }))
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'in' }))
    expect(onAfterScan).toHaveBeenCalled()
    expect(enqueueScan).not.toHaveBeenCalled()
  })

  it('shows Mark OUT (not an OUT write) when a session is open', async () => {
    vi.useFakeTimers(); vi.setSystemTime(FIXED_NOW)
    rpc.mockResolvedValueOnce({ data: { open: { id: 'open-1', status: 'OPEN', ...istStamp(2, 'in') }, last_out: null } })
    const { result, showPopup } = setup()
    let out
    await act(async () => { out = await result.current.handleScan(BADGE) })
    expect(rpc).not.toHaveBeenCalledWith('scan_out', expect.anything())
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'choose', action: 'OUT', badge: BADGE, openId: 'open-1' }))
    expect(out).toEqual({ ok: false, reason: 'confirm_required', action: 'OUT' })
  })

  it('committing the OUT choice closes the pinned session', async () => {
    vi.useFakeTimers(); vi.setSystemTime(FIXED_NOW)
    rpc.mockResolvedValueOnce({ data: { open: { id: 'open-1', status: 'OPEN', ...istStamp(2, 'in') }, last_out: null } })
    rpc.mockResolvedValueOnce({ data: { ok: true } })
    const { result, showPopup, onAfterScan } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'OUT', openId: 'open-1' }) })
    expect(rpc).toHaveBeenCalledWith('scan_out', expect.objectContaining({ p_badge: BADGE, p_open_id: 'open-1' }))
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'out' }))
    expect(onAfterScan).toHaveBeenCalled()
  })

  it('flags an undeployed scan on commit', async () => {
    rpc.mockResolvedValueOnce({ data: null })
    rpc.mockResolvedValueOnce({ data: { ok: true, undeployed: true } })
    const { result, showPopup } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'flagged' }))
  })

  it('marks manual-entry commits with p_is_manual (camera commits send false)', async () => {
    // M3: the server stores is_manual and Scanner Ops reports it — a
    // hand-typed correction must not look like a camera scan.
    rpc.mockResolvedValueOnce({ data: { open: null, last_out: null } })
    rpc.mockResolvedValueOnce({ data: { ok: true } })
    const { result } = setup()
    await act(async () => { await result.current.handleScan(BADGE, { manual: true }) })
    await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN', manual: true }) })
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
    rpc.mockRejectedValueOnce(err)
    const { result, toast, showPopup } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    expect(enqueueScan).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalled()
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }))
  })

  it('surfaces a validation error from the committed server write', async () => {
    // Lookup is unreachable; the choice is offered; the commit hits the
    // server rejection — which must surface, never queue.
    rpc.mockRejectedValueOnce(new Error('Failed to fetch'))
    rpc.mockRejectedValueOnce(new Error('Invalid badge format'))
    const { result, toast } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
    expect(enqueueScan).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('Invalid badge format')
  })

  it('offers the choice (no auto-write) when the lookup fails, then queues the commit offline', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    rpc.mockRejectedValue(new Error('Failed to fetch'))
    enqueueScan.mockResolvedValue({ ok: true, id: 'q-1' })
    const { result, showPopup, onQueued } = setup()
    let out
    await act(async () => { out = await result.current.handleScan(BADGE) })
    // The scan itself writes nothing — it only offers the choice.
    expect(enqueueScan).not.toHaveBeenCalled()
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'choose', action: 'IN' }))
    expect(out).toEqual({ ok: false, reason: 'confirm_required', action: 'IN' })
    // The operator taps Mark IN: the write attempt fails offline and queues.
    await act(async () => { out = await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
    expect(enqueueScan).toHaveBeenCalledWith(expect.objectContaining({ badge: BADGE, action: 'IN' }))
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'queued' }))
    expect(onQueued).toHaveBeenCalled()
    expect(out.ok).toBe(true)
  })

  it('surfaces an error when offline storage is unavailable on commit', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    rpc.mockRejectedValue(new Error('Failed to fetch'))
    enqueueScan.mockResolvedValue({ ok: false, reason: 'unavailable' })
    const { result, toast } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
    expect(toast.error).toHaveBeenCalledWith('Offline storage unavailable')
  })

  // A2 (L-02): a full queue reports itself distinctly from missing storage.
  it('reports a full queue distinctly from unavailable storage', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    rpc.mockRejectedValue(new Error('Failed to fetch'))
    enqueueScan.mockResolvedValue({ ok: false, reason: 'full' })
    const { result, showPopup, toast } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    let out
    await act(async () => { out = await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
    expect(out).toEqual({ ok: false, reason: 'offline_queue_full' })
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', message: expect.stringContaining('full') }))
    expect(toast.error).toHaveBeenCalledWith('Offline queue is full')
  })

  it('reports a queue write failure distinctly', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    rpc.mockRejectedValue(new Error('Failed to fetch'))
    enqueueScan.mockResolvedValue({ ok: false, reason: 'write-failed', error: new Error('quota') })
    const { result, toast } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    let out
    await act(async () => { out = await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
    expect(out).toEqual({ ok: false, reason: 'offline_queue_write_failed' })
    expect(toast.error).toHaveBeenCalledWith('Offline queue write failed')
  })

  // A2 (L-01): an enqueueScan THROW (old contract) must not escape handleScan.
  it('never lets an enqueue rejection escape handleScan', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    rpc.mockRejectedValue(new Error('Failed to fetch'))
    enqueueScan.mockRejectedValue(new Error('IDB exploded'))
    const { result } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    let out
    await act(async () => { out = await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
    expect(typeof out.ok).toBe('boolean')
  })

  // A2 (L-09): same badge+action within 2s offline queues exactly once.
  it('suppresses a duplicate offline enqueue for the same badge+action', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    rpc.mockRejectedValue(new Error('Failed to fetch'))
    enqueueScan.mockResolvedValue({ ok: true, id: 'q-1' })
    const { result, toast } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    let first, second
    await act(async () => { first = await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
    await act(async () => { second = await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
    expect(first.ok).toBe(true)
    expect(second).toEqual({ ok: false, reason: 'duplicate_queued' })
    expect(enqueueScan).toHaveBeenCalledTimes(1)
    expect(toast.warning).toHaveBeenCalledWith('Already queued — ignoring duplicate scan')
  })

  it('offers Mark OUT — not Mark IN — when offline with a pending queued IN', async () => {
    // C4: the operator scanned IN offline (queued), then scans again to go
    // OUT while still offline. The lookup fails, so server state is unknown —
    // but this device already holds an unsynced IN for the badge, which means
    // the intent is OUT. Offering Mark IN would orphan the session.
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    rpc.mockRejectedValue(new Error('Failed to fetch'))
    getQueuedScans.mockResolvedValue([{ id: 'q-in', badge: BADGE, schedule_id: 'sched-1', action: 'IN', synced: false }])
    enqueueScan.mockResolvedValue({ ok: true, id: 'q-out' })
    const { result, showPopup, onQueued } = setup()
    let out
    await act(async () => { out = await result.current.handleScan(BADGE) })
    expect(out).toEqual({ ok: false, reason: 'confirm_required', action: 'OUT' })
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'choose', action: 'OUT' }))
    await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'OUT', openId: null }) })
    expect(enqueueScan).toHaveBeenCalledWith(expect.objectContaining({ badge: BADGE, action: 'OUT' }))
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'queued' }))
    expect(onQueued).toHaveBeenCalled()
  })

  it('still offers Mark IN when offline with no pending IN for the badge', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    rpc.mockRejectedValue(new Error('Failed to fetch'))
    getQueuedScans.mockResolvedValue([])
    enqueueScan.mockResolvedValue({ ok: true, id: 'q-1' })
    const { result, showPopup } = setup()
    let out
    await act(async () => { out = await result.current.handleScan(BADGE) })
    expect(out).toEqual({ ok: false, reason: 'confirm_required', action: 'IN' })
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'choose', action: 'IN' }))
    await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
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
    const { result, showPopup } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('get_scan_state', { p_badge: BADGE, p_schedule: 'sched-1' })
    expect(rpc).not.toHaveBeenCalledWith('scan_in', expect.anything())
    // Jammer-safe: a timeout offers the queueable choice (never a dead-end),
    // since link state stays true while nothing completes.
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'choose', action: 'IN' }))
  })

  it('reports confirm_required so the tap queues offline or writes online', async () => {
    rpc.mockRejectedValueOnce(new Error('Session lookup timed out after 5000ms'))
    const { result } = setup()
    let out
    await act(async () => { out = await result.current.handleScan(BADGE) })
    expect(out).toEqual({ ok: false, reason: 'confirm_required', action: 'IN' })
  })

  it('still queues when the device is genuinely offline (timeout while offline)', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    rpc.mockRejectedValueOnce(new Error('Session lookup timed out after 5000ms'))
    rpc.mockRejectedValueOnce(new Error('Failed to fetch'))
    enqueueScan.mockResolvedValue({ ok: true, id: 'q-1' })
    const { result, showPopup } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    // A timeout while offline is "unknown", not "no session" — offer the
    // choice; the commit queues.
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'choose', action: 'IN' }))
    await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
    expect(enqueueScan).toHaveBeenCalledWith(expect.objectContaining({ badge: BADGE, action: 'IN' }))
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'queued' }))
  })

  it('surfaces a timeout on the post-Already-IN re-fetch instead of the dead end', async () => {
    rpc.mockResolvedValueOnce({ data: null }) // no open session
    rpc.mockRejectedValueOnce(new Error('Already IN')) // committed scan_in
    rpc.mockRejectedValueOnce(new Error('Session lookup timed out after 5000ms')) // re-fetch
    const { result, showPopup } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
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
    await act(async () => { await result.current.handleScan(BADGE) })
    let out
    await act(async () => { out = await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
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
    await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', message: 'Already checked IN — please OUT first. If this repeats for every badge, ask the ASO to apply the pending database migrations.' }))
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', message: expect.stringContaining('pending database migrations') }))
    expect(toast.error).toHaveBeenCalledWith('Already IN — OUT first')
  })

  // L-39: the Already-IN refetch path showed the forgot prompt (with its
  // ">12h open" pill and destructive "Close OUT then IN") for a session of
  // ANY age. A 2-minute session must get the plain Already-IN error instead.
  it('refetches a young session as plain Already-IN, not a forgot prompt', async () => {
    vi.useFakeTimers(); vi.setSystemTime(FIXED_NOW)
    rpc.mockResolvedValueOnce({ data: null }) // first lookup: no open session
    rpc.mockRejectedValueOnce(new Error('Already IN')) // committed scan_in
    rpc.mockResolvedValueOnce({ data: { open: { id: 'open-9', status: 'OPEN', ...istStamp(2, 'in') }, last_out: null } }) // refetch: 2h old
    const { result, showPopup } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    let out
    await act(async () => { out = await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
    expect(out.ok).toBe(false)
    expect(out.outTimeDefault).toBeUndefined()
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', message: 'Already checked IN — please OUT first' }))
    expect(showPopup).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'forgot' }))
  })
})

// ─── submitForgotOut offline parity (L-36) ───────────────────────────────
// The pages' forgot-OUT confirm used to call scan_out directly with a
// toast-only catch — the only scan path with no offline fallback. It now
// goes through the same RPC attempt + offline enqueue as the main OUT flow.
describe('submitForgotOut (L-36)', () => {
  const TS = '2026-09-24T09:05:00.000Z'

  it('closes online silently — the page owns the celebration + follow-up', async () => {
    rpc.mockResolvedValueOnce({ data: { ok: true }, error: null })
    const { result, showPopup, toast } = setup()
    let out
    await act(async () => { out = await result.current.submitForgotOut({ badge: BADGE, openId: 'open-1', ts: TS }) })
    expect(rpc).toHaveBeenCalledWith('scan_out', expect.objectContaining({ p_badge: BADGE, p_open_id: 'open-1', p_ts: TS }))
    expect(out).toEqual({ ok: true })
    expect(showPopup).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('reports server errors silently with a friendly message — the page keeps the form', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: new Error('OUT time must be after IN time') })
    const { result, showPopup, toast } = setup()
    let out
    await act(async () => { out = await result.current.submitForgotOut({ badge: BADGE, openId: 'open-1', ts: TS }) })
    expect(out).toEqual({ ok: false, reason: 'server', message: expect.any(String) })
    expect(showPopup).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('queues offline with the chosen ts + open_id and surfaces the queued UI', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    rpc.mockRejectedValueOnce(new Error('Failed to fetch'))
    enqueueScan.mockResolvedValue({ ok: true, id: 'q-f' })
    const { result, showPopup, onQueued } = setup()
    let out
    await act(async () => { out = await result.current.submitForgotOut({ badge: BADGE, openId: 'open-1', ts: TS }) })
    expect(enqueueScan).toHaveBeenCalledWith(expect.objectContaining({ badge: BADGE, action: 'OUT', ts: TS, open_id: 'open-1' }))
    expect(out).toEqual({ ok: false, reason: 'queued' })
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'queued' }))
    expect(onQueued).toHaveBeenCalled()
  })
})

// ─── D-3: the online scan_in carries the same nonce the drain will replay ──────
describe('idempotency nonce (D-3)', () => {
  it('passes a p_nonce on the committed ONLINE scan_in', async () => {
    rpc.mockResolvedValueOnce({ data: null })
    rpc.mockResolvedValueOnce({ data: { ok: true } })
    const { result } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
    const call = rpc.mock.calls.find(([name]) => name === 'scan_in')
    expect(call).toBeTruthy()
    expect(call[1].p_nonce).toEqual(expect.any(String))
    expect(call[1].p_nonce.length).toBeGreaterThan(8)
  })

  it('reuses that SAME nonce as the queued row id, so the drain replays it', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    // Commit-then-lost-response: scan_in rejects at the network, so the client
    // enqueues. The drain sends p_nonce: q.id — that id must be the online nonce.
    rpc.mockRejectedValueOnce(new Error('Failed to fetch')) // lookup
    rpc.mockRejectedValueOnce(new Error('Failed to fetch')) // committed scan_in
    enqueueScan.mockResolvedValue({ ok: true, id: 'q-1' })
    const { result } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
    const scanInArgs = rpc.mock.calls.find(([name]) => name === 'scan_in')[1]
    const queued = enqueueScan.mock.calls[0][0]
    expect(queued.id).toBe(scanInArgs.p_nonce)
  })

  it('gives each commit a fresh nonce', async () => {
    // Two full committed IN flows, each with its own lookup + scan_in.
    rpc.mockResolvedValueOnce({ data: null })
    rpc.mockResolvedValueOnce({ data: { ok: true } })
    rpc.mockResolvedValueOnce({ data: null })
    rpc.mockResolvedValueOnce({ data: { ok: true } })
    const { result } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
    await act(async () => { await result.current.handleScan(BADGE) })
    await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
    const nonces = rpc.mock.calls.filter(([n]) => n === 'scan_in').map(([, a]) => a.p_nonce)
    expect(nonces).toHaveLength(2)
    expect(nonces[0]).not.toBe(nonces[1])
  })
})

// ─── D-4: every exit resolves to { ok: boolean } ───────────────────────────────
describe('return contract (D-4)', () => {
  const OFFLINE = () => Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
  // Each case drives one exit and asserts the resolved shape. A bare `return`
  // (undefined) makes `const { ok } = await handleScan(x)` throw a TypeError.
  const CASES = [
    {
      name: 'busy (a scan is already in flight)',
      async drive({ result, first }) {
        // The busy exit needs a pending RPC: force online, because the
        // offline short-circuit answers without touching the network and
        // can never be "in flight".
        Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
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
        rpc.mockRejectedValue(new Error('Failed to fetch'))
        enqueueScan.mockResolvedValue({ ok: false, reason: 'unavailable' })
        await result.current.handleScan(BADGE) // lookup fails -> choose
        return { out: await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) }
      },
    },
    {
      name: 'OUT offline storage unavailable',
      async drive({ result }) {
        OFFLINE()
        // The commit pins no openId (lookup was unreachable), so scan_out
        // resolves the session itself — then fails to queue.
        rpc.mockRejectedValue(new Error('Failed to fetch'))
        enqueueScan.mockResolvedValue({ ok: false, reason: 'unavailable' })
        await result.current.handleScan(BADGE) // lookup fails -> choose
        return { out: await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'OUT', openId: null }) }
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

  it('a committed IN scan resolves ok === true', async () => {
    const ctx = setup()
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
    rpc.mockResolvedValueOnce({ data: null })
    rpc.mockResolvedValueOnce({ data: { ok: true } })
    await act(async () => { await ctx.result.current.handleScan(BADGE) })
    let out
    await act(async () => { out = await ctx.result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
    expect(out).toEqual({ ok: true })
  })

  it('a plain scan never resolves ok === true — it only offers the choice', async () => {
    const ctx = setup()
    rpc.mockResolvedValueOnce({ data: null })
    let out
    await act(async () => { out = await ctx.result.current.handleScan(BADGE) })
    expect(out).toEqual({ ok: false, reason: 'confirm_required', action: 'IN' })
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

  it('treats the legacy all-NULL row payload as NO session, and offers Mark IN', async () => {
    // PGRST202 -> the pre-v44 fallback -> get_open_session's real PostgREST shape
    rpc.mockResolvedValueOnce({ data: null, error: Object.assign(new Error('function get_scan_state does not exist'), { code: 'PGRST202' }) })
    rpc.mockResolvedValueOnce({ data: NULL_ROW })          // the real PostgREST shape
    rpc.mockResolvedValueOnce({ data: { ok: true } })      // committed scan_in
    const { result, showPopup } = setup()
    let out
    await act(async () => { out = await result.current.handleScan(BADGE) })
    expect(out).toEqual({ ok: false, reason: 'confirm_required', action: 'IN' })
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'choose', action: 'IN' }))
    expect(rpc).not.toHaveBeenCalledWith('scan_out', expect.anything())
    await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
    expect(rpc).toHaveBeenCalledWith('scan_in', expect.objectContaining({ p_badge: BADGE }))
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'in' }))
  })

  it('treats an empty array payload as NO session, and offers Mark IN', async () => {
    rpc.mockResolvedValueOnce({ data: [] })
    rpc.mockResolvedValueOnce({ data: { ok: true } })
    const { result, showPopup } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'choose', action: 'IN' }))
    expect(rpc).not.toHaveBeenCalledWith('scan_out', expect.anything())
    await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
    expect(rpc).toHaveBeenCalledWith('scan_in', expect.objectContaining({ p_badge: BADGE }))
  })

  it('still takes the OUT choice for a genuine open session', async () => {
    // 2h old: inside the 12h forgot threshold, so this is the plain Mark-OUT
    // choice. Fixed clock so it cannot drift.
    vi.useFakeTimers(); vi.setSystemTime(FIXED_NOW)
    rpc.mockResolvedValueOnce({ data: { open: { id: 'open-1', status: 'OPEN', ...istStamp(2, 'in') }, last_out: null } })
    rpc.mockResolvedValueOnce({ data: { ok: true } })      // committed scan_out
    const { result, showPopup } = setup()
    let out
    await act(async () => { out = await result.current.handleScan(BADGE) })
    expect(out).toEqual({ ok: false, reason: 'confirm_required', action: 'OUT' })
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'choose', action: 'OUT', openId: 'open-1' }))
    await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'OUT', openId: 'open-1' }) })
    expect(rpc).toHaveBeenCalledWith('scan_out', expect.objectContaining({ p_badge: BADGE, p_open_id: 'open-1' }))
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'out' }))
  })

  it('unwraps a single-element array of a real session', async () => {
    // PostgREST may serialise a function return as a 1-row set.
    vi.useFakeTimers(); vi.setSystemTime(FIXED_NOW)
    rpc.mockResolvedValueOnce({ data: [{ open: { id: 'open-9', status: 'OPEN', ...istStamp(2, 'in') }, last_out: null }] })
    rpc.mockResolvedValueOnce({ data: { ok: true } })
    const { result, showPopup } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'choose', action: 'OUT', openId: 'open-9' }))
    await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'OUT', openId: 'open-9' }) })
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
    await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
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
    await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
    const payload = showPopup.mock.calls[showPopup.mock.calls.length - 1][0]
    expect(payload.centre).toBeNull()
    expect(payload.centre).not.toBe('Bhati - Delhi MC')
  })

  it('resolves the OUT choice from the session row, not the venue', async () => {
    // The choice popup carries the identity BEFORE anything is written.
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
    const { result, showPopup } = setup({ deptNameById: new Map([['uuid-1', 'Traffic']]) })
    await act(async () => { await result.current.handleScan(BADGE) })
    const payload = showPopup.mock.calls[0][0]
    expect(payload).toEqual(expect.objectContaining({
      status: 'choose',
      action: 'OUT',
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
    await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
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
    await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
    const payload = showPopup.mock.calls[showPopup.mock.calls.length - 1][0]
    expect(payload.status).toBe('flagged')
    // Identity fields come from the scan; the FLAG text still names the
    // operator's own department, which is what that sentence means.
    expect(payload.deptName).toBe('Jal Vihar')
    expect(payload.flag).toContain('Traffic')
  })
})

// ═══ explicit choice (replaces the v44 1-hour confirm gate) ═══════════════
//
// A scan NEVER writes: it resolves state and offers the ONE valid direction.
// The invariant worth protecting is the NEGATIVE one: an uncommitted scan
// must write NOTHING. Every test below asserts the write RPC was never called,
// because a choice that still writes on the way to asking is worse than no
// choice at all.
describe('explicit IN/OUT choice', () => {
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
    it('offers Mark OUT (no write) even 10 min after the IN', async () => {
      rpc.mockResolvedValueOnce({ data: openSession(10 / 60) })  // 10 minutes
      const { result, showPopup } = setup()
      let out
      await act(async () => { out = await result.current.handleScan(BADGE) })
      expect(rpc).not.toHaveBeenCalledWith('scan_out', expect.anything())
      expect(rpc).not.toHaveBeenCalledWith('scan_in', expect.anything())
      expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({
        status: 'choose', action: 'OUT', badge: BADGE, openId: 'open-1',
      }))
      expect(out).toEqual({ ok: false, reason: 'confirm_required', action: 'OUT' })
    })

    it('offers Mark OUT (no write) when the IN is 2h old — the tap commits', async () => {
      rpc.mockResolvedValueOnce({ data: openSession(2) })
      rpc.mockResolvedValueOnce({ data: { ok: true } })
      const { result, showPopup } = setup()
      await act(async () => { await result.current.handleScan(BADGE) })
      expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'choose', action: 'OUT' }))
      await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'OUT', openId: 'open-1' }) })
      expect(rpc).toHaveBeenCalledWith('scan_out', expect.objectContaining({ p_open_id: 'open-1' }))
      expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'out' }))
    })

    it('Cancel is a no-op: nothing is written and the only popup is the question', async () => {
      rpc.mockResolvedValueOnce({ data: openSession(10 / 60) })
      const { result, showPopup, onAfterScan } = setup()
      await act(async () => { await result.current.handleScan(BADGE) })
      expect(rpc).toHaveBeenCalledTimes(1)          // the lookup only
      expect(showPopup).toHaveBeenCalledTimes(1)
      expect(showPopup.mock.calls[0][0].status).toBe('choose')
      // Nothing was written, so nothing needs refreshing.
      expect(onAfterScan).not.toHaveBeenCalled()
    })
  })

  describe('OUT → IN direction', () => {
    it('offers Mark IN (no write) even 15 min after the OUT', async () => {
      rpc.mockResolvedValueOnce({ data: closedSession(0.25) })
      const { result, showPopup } = setup()
      let out
      await act(async () => { out = await result.current.handleScan(BADGE) })
      expect(rpc).not.toHaveBeenCalledWith('scan_in', expect.anything())
      expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({
        status: 'choose', action: 'IN', badge: BADGE,
      }))
      expect(out).toEqual({ ok: false, reason: 'confirm_required', action: 'IN' })
    })

    it('resolves the choice identity from the last_out row', async () => {
      rpc.mockResolvedValueOnce({ data: closedSession(0.25, { sewadar_name: 'Sita Devi', sewadar_centre: 'DELHI-9', centre: 'Bhati - Delhi MC' }) })
      const { result, showPopup } = setup()
      await act(async () => { await result.current.handleScan(BADGE) })
      const p = showPopup.mock.calls[0][0]
      expect(p.name).toBe('Sita Devi')
      expect(p.centre).toBe('DELHI-9')       // home centre, never the venue
      expect(p.centre).not.toBe('Bhati - Delhi MC')
    })

    // ── v65: identity from the SOURCE TABLES, not session history ────────────
    // THE bug behind "my popup shows nothing": a badge that has never scanned
    // in this schedule has NO session row, so `last_out` was null and the IN
    // prompt resolved identity from a null payload — badge + clock, no name,
    // no centre, no department. `get_scan_state` now carries a `sewadar` key
    // read from `get_sewadar_by_badge` + `deployments`, which is available
    // with ZERO sessions.
    describe('v65 sewadar identity (fresh badge — the blank popup)', () => {
      const fresh = (extra = {}) => ({
        open: null,
        last_out: null,
        sewadar: {
          sewadar_name: 'Sita Devi',
          sewadar_centre: 'DELHI-9',
          sewadar_dept: 'uuid-1',
          dept_name: 'Traffic',
          is_vss: false,
          ...extra,
        },
      })

      it('shows name/centre/dept for a badge with NO sessions at all', async () => {
        rpc.mockResolvedValueOnce({ data: fresh() })
        const { result, showPopup } = setup()
        await act(async () => { await result.current.handleScan(BADGE) })
        const p = showPopup.mock.calls[0][0]
        expect(p.status).toBe('choose')
        expect(p.action).toBe('IN')
        expect(p.name).toBe('Sita Devi')
        expect(p.centre).toBe('DELHI-9')
        expect(p.deptName).toBe('Traffic')
        expect(p.centre).not.toBe('Bhati - Delhi MC')
      })

      it('stamps the moment with an IST date + HH:MM:SS on the IN choice', async () => {
        rpc.mockResolvedValueOnce({ data: fresh() })
        const { result, showPopup } = setup()
        await act(async () => { await result.current.handleScan(BADGE) })
        const p = showPopup.mock.calls[0][0]
        // FIXED_NOW = 2026-09-27T12:00:00Z = 17:30:00 IST
        expect(p.eventDate).toBe('2026-09-27')
        expect(p.eventTime).toBe('17:30:00')
      })

      it('stamps the OUT choice too, alongside its existing IN history line', async () => {
        rpc.mockResolvedValueOnce({ data: openSession(2, { sewadar_name: 'Ramesh Lal', sewadar_centre: 'DELHI-7', sewadar_dept: 'uuid-1' }) })
        const { result, showPopup } = setup({ deptNameById: new Map([['uuid-1', 'Traffic']]) })
        await act(async () => { await result.current.handleScan(BADGE) })
        const p = showPopup.mock.calls[0][0]
        expect(p.action).toBe('OUT')
        expect(p.openId).toBe('open-1')
        expect(p.openSince).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/) // the IN date+time
        expect(p.eventDate).toBe('2026-09-27')
        expect(p.eventTime).toBe('17:30:00')
      })

      it('prefers the live sewadar row over the session snapshot', async () => {
        // The open session was stamped with an older name; the live row wins,
        // so both directions name the sewadar the same way.
        rpc.mockResolvedValueOnce({
          data: {
            ...openSession(2, { sewadar_name: 'OLD NAME', sewadar_centre: 'OLD-CENTRE' }),
            sewadar: { sewadar_name: 'Sita Devi', sewadar_centre: 'DELHI-9', dept_name: 'Traffic' },
          },
        })
        const { result, showPopup } = setup()
        await act(async () => { await result.current.handleScan(BADGE) })
        const p = showPopup.mock.calls[0][0]
        expect(p.action).toBe('OUT')
        expect(p.name).toBe('Sita Devi')
        expect(p.centre).toBe('DELHI-9')
      })

      it('degrades to null identity when the key is absent (pre-v65 function)', async () => {
        // No `sewadar` key at all: the popup must still fire with the right
        // status/action rather than throwing — blank-but-present, not dead.
        rpc.mockResolvedValueOnce({ data: { open: null, last_out: null } })
        const { result, showPopup } = setup()
        await act(async () => { await result.current.handleScan(BADGE) })
        const p = showPopup.mock.calls[0][0]
        expect(p.status).toBe('choose')
        expect(p.action).toBe('IN')
        expect(p.name ?? null).toBeNull()
        expect(p.centre ?? null).toBeNull()
        expect(p.eventDate).toBe('2026-09-27')
      })

      it('yields null identity for an unknown badge (three JSON nulls), not a crash', async () => {
        rpc.mockResolvedValueOnce({ data: { open: null, last_out: null, sewadar: null } })
        const { result, showPopup } = setup()
        await act(async () => { await result.current.handleScan(BADGE) })
        const p = showPopup.mock.calls[0][0]
        expect(p.status).toBe('choose')
        expect(p.name ?? null).toBeNull()
        expect(p.centre ?? null).toBeNull()
        expect(p.deptName ?? null).toBeNull()
      })
    })

    it('commits the IN when the last OUT was 3h ago only after the tap', async () => {
      rpc.mockResolvedValueOnce({ data: closedSession(3) })
      rpc.mockResolvedValueOnce({ data: { ok: true } })
      const { result, showPopup } = setup()
      await act(async () => { await result.current.handleScan(BADGE) })
      expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'choose', action: 'IN' }))
      await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
      expect(rpc).toHaveBeenCalledWith('scan_in', expect.objectContaining({ p_badge: BADGE }))
      expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'in' }))
    })

    it('offers Mark IN (no write) for a sewadar who has never been scanned', async () => {
      rpc.mockResolvedValueOnce({ data: { open: null, last_out: null } })
      rpc.mockResolvedValueOnce({ data: { ok: true } })
      const { result, showPopup } = setup()
      let out
      await act(async () => { out = await result.current.handleScan(BADGE) })
      expect(out).toEqual({ ok: false, reason: 'confirm_required', action: 'IN' })
      expect(rpc).not.toHaveBeenCalledWith('scan_in', expect.anything())
      await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
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

    it('a committed IN writes directly with NO second lookup', async () => {
      rpc.mockResolvedValueOnce({ data: { ok: true } })  // only scan_in
      const { result, showPopup } = setup()
      await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
      expect(rpc).toHaveBeenCalledTimes(1)
      expect(rpc).not.toHaveBeenCalledWith('get_scan_state', expect.anything())
      expect(rpc).toHaveBeenCalledWith('scan_in', expect.objectContaining({ p_badge: BADGE }))
      expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'in' }))
    })

    it('a committed OUT with a null openId lets the server resolve the session', async () => {
      // The choice was offered while the lookup was unreachable (offline), so
      // no session id was pinned. scan_out resolves the open session itself.
      rpc.mockResolvedValueOnce({ data: { ok: true } })  // only scan_out
      const { result, showPopup } = setup()
      await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'OUT', openId: null }) })
      expect(rpc).toHaveBeenCalledTimes(1)
      expect(rpc).not.toHaveBeenCalledWith('get_scan_state', expect.anything())
      expect(rpc).toHaveBeenCalledWith('scan_out', expect.objectContaining({ p_badge: BADGE, p_open_id: null }))
      expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'out' }))
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

    it('a committed IN can NEVER write an OUT', async () => {
      // The operator tapped Mark IN. The commit authorises one fresh IN and
      // nothing else — even if the sewadar's state changed meanwhile, the
      // commit path cannot reach scan_out at all.
      rpc.mockResolvedValueOnce({ data: { ok: true } })
      const { result, showPopup } = setup()
      await act(async () => {
        await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN', openId: null })
      })
      expect(rpc).not.toHaveBeenCalledWith('scan_out', expect.anything())
      expect(rpc).toHaveBeenCalledWith('scan_in', expect.objectContaining({ p_badge: BADGE }))
      expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'in' }))
    })

    it('a committed OUT can NEVER write an IN', async () => {
      // Symmetric: a Mark OUT tap authorises closing the session only. The
      // server answers the write; no scan_in is reachable from this path.
      rpc.mockResolvedValueOnce({ data: { ok: true } })
      const { result, showPopup } = setup()
      await act(async () => {
        await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'OUT', openId: 'open-1' })
      })
      expect(rpc).not.toHaveBeenCalledWith('scan_in', expect.anything())
      expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'out' }))
    })

    it('an approval with no direction disarms nothing (fail-closed)', async () => {
      rpc.mockResolvedValueOnce({ data: { open: { id: 'open-1', status: 'OPEN', ...istStamp(0.2, 'in') }, last_out: null } })
      const { result, showPopup } = setup()
      await act(async () => { await result.current.handleScan(BADGE, { confirmed: true }) })
      expect(rpc).not.toHaveBeenCalledWith('scan_out', expect.anything())
      expect(rpc).not.toHaveBeenCalledWith('scan_in', expect.anything())
      expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'choose', action: 'OUT' }))
    })

    it('recovers to the forgot-OUT prompt when the post-Already-IN re-fetch finds the session', async () => {
      // The client thought there was no open session, the server disagreed.
      // The re-fetch turns that dead end back into a normal forgot-OUT prompt.
      rpc.mockResolvedValueOnce({ data: { open: null, last_out: null } })
      rpc.mockRejectedValueOnce(new Error('Already IN'))
      rpc.mockResolvedValueOnce({ data: { open: { id: 'open-1', status: 'OPEN', ...istStamp(20, 'in') }, last_out: null } })
      const { result, showPopup } = setup()
      await act(async () => { await result.current.handleScan(BADGE) })
      const out = await act(async () => result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }))
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
      await act(async () => { await result.current.handleScan(BADGE) })
      let out
      await act(async () => { out = await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
      expect(out.outTimeDefault).toBe('17:30')
    })
  })

  describe('pre-v44 fallback (v44 not applied yet)', () => {
    it('degrades to get_open_session on PGRST202 instead of failing every scan', async () => {
      rpc.mockResolvedValueOnce({ data: null, error: Object.assign(new Error('function get_scan_state does not exist'), { code: 'PGRST202' }) })
      rpc.mockResolvedValueOnce({ data: { id: 'open-1', status: 'OPEN', ...istStamp(2, 'in') } })
      rpc.mockResolvedValueOnce({ data: { ok: true } })
      const { result, showPopup } = setup()
      let out
      await act(async () => { out = await result.current.handleScan(BADGE) })
      expect(rpc).toHaveBeenCalledWith('get_open_session', { p_badge: BADGE, p_schedule: 'sched-1' })
      // The OUT choice still works — this is the whole point of the fallback.
      expect(out).toEqual({ ok: false, reason: 'confirm_required', action: 'OUT' })
      expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'choose', action: 'OUT', openId: 'open-1' }))
      await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'OUT', openId: 'open-1' }) })
      expect(rpc).toHaveBeenCalledWith('scan_out', expect.objectContaining({ p_open_id: 'open-1' }))
      expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'out' }))
    })
  })
})

// ─── V6: a busy-guard drop must SURFACE feedback (never swallow) ─────────────
// The old `if (busyRef.current) return { ok:false, reason:'busy' }` exit showed
// nothing: the operator held a badge at the lens, the scan died silently, and
// the retry looked like a dead scanner. It must toast + popup AND keep the
// distinct 'busy' reason so Track 4's camera suppressor (which must record
// lastScan only after onScan acceptance) can tell "retry me" apart.
describe('V6 busy-guard feedback', () => {
  it('V6 surfaces a toast + error popup on the dropped scan, keeping reason busy', async () => {
    let release
    rpc.mockImplementationOnce(() => new Promise((res) => { release = res }))
    const { result, showPopup, toast } = setup()
    let first
    act(() => { first = result.current.handleScan(BADGE) })
    expect(result.current.busy).toBe(true)
    let out
    await act(async () => { out = await result.current.handleScan(BADGE) })
    expect(out).toEqual({ ok: false, reason: 'busy' })
    expect(toast.warning).toHaveBeenCalledWith('Scanner busy — retry this badge')
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error', badge: BADGE, message: 'Scanner busy — retry this badge',
    }))
    expect(rpc).toHaveBeenCalledTimes(1) // the drop wrote nothing
    await act(async () => { release({ data: null }); await first })
  })

  it('V6 carries the badge on the busy popup so the operator knows WHAT to retry', async () => {
    let release
    rpc.mockImplementationOnce(() => new Promise((res) => { release = res }))
    const { result, showPopup } = setup()
    let first
    act(() => { first = result.current.handleScan('fb5971ga0002') })
    let out
    await act(async () => { out = await result.current.handleScan('fb5971ga0002') })
    expect(out.reason).toBe('busy')
    const payload = showPopup.mock.calls[showPopup.mock.calls.length - 1][0]
    expect(payload.badge).toBe('FB5971GA0002')
    await act(async () => { release({ data: null }); await first })
  })
})

// ─── V7: a busy-swallowed forgot-OUT follow-up must be DETECTABLE ────────────
// useScannerSession owns the 200ms re-IN after a forgot-OUT (this file may not
// touch it). The hook side of the contract: the follow-up re-IN returns the
// DISTINCT 'busy' reason when it races an inflight scan, so the caller can
// re-arm instead of assuming the IN landed (which would leave the OUT without
// its follow-up IN while the operator saw success).
describe('V7 forgot-OUT follow-up busy detectability', () => {
  it('V7 a follow-up re-IN racing an inflight scan resolves busy, not ok', async () => {
    let release
    rpc.mockImplementationOnce(() => new Promise((res) => { release = res }))
    const { result } = setup()
    let first
    act(() => { first = result.current.handleScan(BADGE) })
    let out
    await act(async () => {
      out = await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' })
    })
    // Neither success nor a re-prompt: distinctly busy, so the follow-up
    // caller knows the IN never ran and must re-arm.
    expect(out).toEqual({ ok: false, reason: 'busy' })
    expect(out.reason).not.toBe('confirm_required')
    await act(async () => { release({ data: null }); await first })
  })
})

// ─── V11: resolved-{error} arms + REAL withTimeout format ────────────────────
// Every scan RPC is read as `{ data, error }`, but until now every test
// exercised the error arms via REJECTION. A resolved `{ error }` takes the
// `if (error) throw error` arm instead — these prove that arm executes for
// both scan_in and the main-flow scan_out. Timeout strings are derived from
// the real withTimeout (imported above), never hardcoded.
describe('V11 resolved-error and real timeout format', () => {
  const realTimeoutMessage = (label, ms) =>
    withTimeout(new Promise(() => {}), ms, label).catch((e) => e.message)

  it('V11 scan_in: a resolved { error: Already IN } executes the throw arm and refetches', async () => {
    rpc.mockResolvedValueOnce({ data: { open: null, last_out: null } }) // lookup: no session
    rpc.mockResolvedValueOnce({ data: null, error: new Error('Already IN') }) // committed scan_in RESOLVED error
    rpc.mockResolvedValueOnce({ data: null, error: null }) // refetch: genuinely null
    const { result, showPopup, toast } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    let out
    await act(async () => { out = await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
    // Without `if (error) throw error` this would celebrate as a success.
    expect(rpc).toHaveBeenCalledWith('scan_in', expect.objectContaining({ p_badge: BADGE }))
    expect(rpc).toHaveBeenCalledTimes(3) // lookup + scan_in + refetch
    expect(showPopup).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'in' }))
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error', message: 'Already checked IN — please OUT first. If this repeats for every badge, ask the ASO to apply the pending database migrations.',
    }))
    expect(toast.error).toHaveBeenCalledWith('Already IN — OUT first')
    expect(out).toEqual({ ok: false })
  })

  it('V11 committed scan_out: a resolved { error } executes the throw arm', async () => {
    // A Mark OUT tap against the pinned session whose write the server
    // rejects — the throw arm must surface it, never celebrate 'OUT marked'.
    rpc.mockResolvedValueOnce({ data: null, error: new Error('boom') }) // scan_out RESOLVED error
    const { result, showPopup, toast } = setup()
    await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'OUT', openId: 'open-1' }) })
    expect(rpc).toHaveBeenCalledWith('scan_out', expect.objectContaining({ p_open_id: 'open-1' }))
    // Without `if (outError) throw outError` this would celebrate 'OUT marked'.
    expect(showPopup).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'out' }))
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', message: 'boom' }))
    expect(toast.error).toHaveBeenCalledWith('boom')
  })

  it('V11 drives the session-lookup timeout path with the REAL withTimeout message', async () => {
    const msg = await realTimeoutMessage('Session lookup', 20)
    expect(msg).toMatch(/timed out after \d+ms$/) // the format under test
    rpc.mockRejectedValueOnce(new Error(msg))
    const { result, showPopup } = setup()
    let out
    await act(async () => { out = await result.current.handleScan(BADGE) })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).not.toHaveBeenCalledWith('scan_in', expect.anything())
    expect(out).toEqual({ ok: false, reason: 'confirm_required', action: 'IN' })
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'choose' }))
  })
})

// ─── V14: clock-skew rejections surface the device-clock warning ─────────────
// The server rejects p_ts beyond now()+5min / before now()-30d (v26/v46). The
// client must translate that into 'Device clock looks wrong' — and must NOT
// rewrite the sent ts (warn-only; cf. resolveForgotOutTime which clamps).
describe('V14 device-clock warning', () => {
  it('V14 scan_in: a future-timestamp rejection warns about the device clock, not the raw text', async () => {
    rpc.mockResolvedValueOnce({ data: { open: null, last_out: null } })
    rpc.mockResolvedValueOnce({ data: null, error: new Error('Timestamp cannot be in the future') })
    const { result, showPopup, toast } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
    expect(rpc).toHaveBeenCalledWith('scan_in', expect.objectContaining({ p_badge: BADGE }))
    const payload = showPopup.mock.calls[showPopup.mock.calls.length - 1][0]
    expect(payload.status).toBe('error')
    expect(payload.message).toContain('Device clock looks wrong')
    expect(payload.message).not.toContain('Timestamp cannot be in the future')
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('Device clock looks wrong'))
  })

  it('V14 scan_out: a too-old-timestamp rejection warns about the device clock', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: new Error('Timestamp too old (more than 30 days)') })
    const { result, showPopup, toast } = setup()
    await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'OUT', openId: 'open-1' }) })
    expect(rpc).toHaveBeenCalledWith('scan_out', expect.objectContaining({ p_open_id: 'open-1' }))
    expect(showPopup).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'out' }))
    const payload = showPopup.mock.calls[showPopup.mock.calls.length - 1][0]
    expect(payload.message).toContain('Device clock looks wrong')
    expect(payload.message).not.toContain('Timestamp too old')
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('Device clock looks wrong'))
  })

  it('V14 still sends the server-accepted ts unchanged (warn-only, no clamping)', async () => {
    // A normal commit is unaffected: the ts goes out exactly as built, and a
    // non-clock error keeps its raw friendly text.
    rpc.mockResolvedValueOnce({ data: { open: null, last_out: null } })
    rpc.mockResolvedValueOnce({ data: null, error: new Error('Department quota already exhausted') })
    const { result, showPopup, toast } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
    const sent = rpc.mock.calls.find(([fn]) => fn === 'scan_in')[1]
    expect(typeof sent.p_ts).toBe('string')
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error', message: 'Department quota already exhausted',
    }))
    expect(toast.warning).not.toHaveBeenCalledWith(expect.stringContaining('Device clock'))
  })
})

describe('offline uncertainty flag + schedule-keyed dupe + full-queue banner (C6/key/cap)', () => {
  it('flags an offline IN uncertain when no pending local IN exists (C6)', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    rpc.mockRejectedValue(new Error('Failed to fetch'))
    getQueuedScans.mockResolvedValue([])
    enqueueScan.mockResolvedValue({ ok: true, id: 'q-u' })
    const { result } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
    expect(enqueueScan).toHaveBeenCalledWith(expect.objectContaining({ badge: BADGE, action: 'IN', uncertain: true }))
  })

  it('does NOT flag uncertain when a pending local IN already exists', async () => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
    // Online jammer: lookup fails, the committed scan_in attempt fails as
    // network — the IN path re-checks the local queue, which already holds
    // this badge's IN.
    rpc.mockRejectedValue(new Error('Failed to fetch'))
    getQueuedScans.mockResolvedValue([{ id: 'q-in', badge: BADGE, schedule_id: 'sched-1', action: 'IN', synced: false }])
    enqueueScan.mockResolvedValue({ ok: true, id: 'q-2' })
    const { result } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
    expect(enqueueScan).toHaveBeenCalledTimes(1)
    expect('uncertain' in enqueueScan.mock.calls[0][0]).toBe(false)
  })

  it('keys the offline dupe suppressor by schedule: same badge under a new schedule queues again', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    rpc.mockRejectedValue(new Error('Failed to fetch'))
    getQueuedScans.mockResolvedValue([])
    enqueueScan.mockResolvedValue({ ok: true, id: 'q-s' })
    const showPopup = vi.fn()
    const toast = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
    const view = renderHook(
      ({ scheduleId }) => useScanHandler({
        scheduleId, profile: { centre: 'DELHI' }, deptName: null,
        showPopup, toast, onQueued: vi.fn(), onAfterScan: vi.fn(),
      }),
      { initialProps: { scheduleId: 'sched-1' } },
    )
    await act(async () => { await view.result.current.handleScan(BADGE) })
    await act(async () => { await view.result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
    expect(enqueueScan).toHaveBeenCalledTimes(1)
    view.rerender({ scheduleId: 'sched-2' })
    await act(async () => { await view.result.current.handleScan(BADGE) })
    let second
    await act(async () => { second = await view.result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
    // A new schedule is a distinct intent — not a double tap.
    expect(second.ok).toBe(true)
    expect(enqueueScan).toHaveBeenCalledTimes(2)
    expect(enqueueScan.mock.calls[1][0]).toMatchObject({ schedule_id: 'sched-2', action: 'IN' })
  })

  it('still suppresses a same-schedule double tap within 2s', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    rpc.mockRejectedValue(new Error('Failed to fetch'))
    getQueuedScans.mockResolvedValue([])
    enqueueScan.mockResolvedValue({ ok: true, id: 'q-d' })
    const { result } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
    let second
    await act(async () => { second = await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
    expect(second).toEqual({ ok: false, reason: 'duplicate_queued' })
    expect(enqueueScan).toHaveBeenCalledTimes(1)
  })

  it('the full-queue refusal names the 2000 cap in an unmissable error popup + toast', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    rpc.mockRejectedValue(new Error('Failed to fetch'))
    enqueueScan.mockResolvedValue({ ok: false, reason: 'full' })
    const { result, showPopup, toast } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    let out
    await act(async () => { out = await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
    expect(out).toEqual({ ok: false, reason: 'offline_queue_full' })
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', message: expect.stringContaining('2000') }))
    expect(toast.error).toHaveBeenCalledWith('Offline queue is full')
  })
})

// ─── Mobile directory: offline-first identity (sewadarDirectory) ───
// The directory answers IDENTITY only — live RPC wins online, the cache
// fills offline gaps, and a definitely-offline scan never waits on the net.
describe('mobile directory identity', () => {
  const DIR = new Map([['FB5971GA0001', { badge: 'FB5971GA0001', name: 'Asha Verma', centre: 'DELHI-7', deptId: null }]])

  it('offline skips the lookup entirely — instant choose, zero RPC', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    const { result, showPopup } = setup({ directoryByBadge: DIR })
    let out
    await act(async () => { out = await result.current.handleScan(BADGE) })
    expect(rpc).not.toHaveBeenCalled()
    expect(out).toEqual({ ok: false, reason: 'confirm_required', action: 'IN' })
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({
      status: 'choose', name: 'Asha Verma', centre: 'DELHI-7',
    }))
  })

  it('offline with a pending queued IN offers OUT (never a duplicate IN)', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    getQueuedScans.mockResolvedValue([{ action: 'IN', badge: BADGE, schedule_id: 'sched-1' }])
    const { result, showPopup } = setup({ directoryByBadge: DIR })
    let out
    await act(async () => { out = await result.current.handleScan(BADGE) })
    expect(out).toEqual({ ok: false, reason: 'confirm_required', action: 'OUT' })
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'choose', action: 'OUT' }))
  })

  it('online timeout still names the sewadar from the directory', async () => {
    rpc.mockRejectedValueOnce(new Error('Session lookup timed out after 5000ms'))
    const { result, showPopup } = setup({ directoryByBadge: DIR })
    await act(async () => { await result.current.handleScan(BADGE) })
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({
      status: 'choose', name: 'Asha Verma', centre: 'DELHI-7',
    }))
  })

  it('live RPC identity beats the directory when both exist', async () => {
    rpc.mockResolvedValueOnce({ data: {
      open: null,
      last_out: null,
      sewadar: { sewadar_name: 'Live Name', sewadar_centre: 'LIVE-C', sewadar_dept: null, dept_name: null, is_vss: false },
    } })
    const { result, showPopup } = setup({ directoryByBadge: DIR })
    await act(async () => { await result.current.handleScan(BADGE) })
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({
      status: 'choose', name: 'Live Name', centre: 'LIVE-C',
    }))
  })

  it('no directory configured behaves exactly as before (null-safe)', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    const { result, showPopup } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    expect(rpc).not.toHaveBeenCalled()
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'choose', name: null }))
  })
})

// Branch-C + queued identity: same DIR fixture, separate block so each
// identity-carrying popup is pinned where it is produced.
describe('offline popup identity (branches C + queued)', () => {
  const DIR = new Map([['FB5971GA0001', { badge: 'FB5971GA0001', name: 'Asha Verma', centre: 'DELHI-7', deptId: null, deptName: null }]])

  it('names the sewadar on the error branch too (jammer with link up)', async () => {
    rpc.mockRejectedValueOnce(new Error('Failed to fetch'))
    const { result, showPopup } = setup({ directoryByBadge: DIR })
    await act(async () => { await result.current.handleScan(BADGE) })
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({
      status: 'choose', name: 'Asha Verma', centre: 'DELHI-7',
    }))
  })

  it('queued IN ack carries the confirmed identity (no blank offline ack)', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    rpc.mockRejectedValue(new Error('Failed to fetch'))
    enqueueScan.mockResolvedValue({ ok: true, id: 'q-1' })
    const { result, showPopup } = setup({ directoryByBadge: DIR })
    await act(async () => { await result.current.handleScan(BADGE) })
    await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({
      status: 'queued', action: 'IN', name: 'Asha Verma', centre: 'DELHI-7',
    }))
  })

  it('queued OUT ack carries the prior popup identity', async () => {
    // Confirmed OUT writes scan_out directly (no lookup) — fail that write.
    rpc.mockRejectedValueOnce(new Error('Failed to fetch'))
    const { result, showPopup } = setup()
    await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'OUT', openId: 'open-1', display: { name: 'Prior Name', centre: 'PRIOR-C', deptName: null } }) })
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({
      status: 'queued', action: 'OUT', name: 'Prior Name', centre: 'PRIOR-C',
    }))
  })
})

describe('owner-null enqueue honesty (D1a ack)', () => {
  it('an owner-null IN ack says it cannot auto-sync', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    rpc.mockRejectedValue(new Error('Failed to fetch'))
    enqueueScan.mockResolvedValue({ ok: true, id: 'q-1', owner: null })
    const { result, showPopup, toast } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({
      status: 'queued',
      action: 'IN',
      message: expect.stringMatching(/no owner/i),
    }))
    expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/no owner/i))
    expect(toast.success).not.toHaveBeenCalledWith(expect.stringMatching(/queued/i))
  })

  it('an owner-present IN ack keeps the will-sync promise', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    rpc.mockRejectedValue(new Error('Failed to fetch'))
    enqueueScan.mockResolvedValue({ ok: true, id: 'q-1', owner: 'user-A' })
    const { result, showPopup } = setup()
    await act(async () => { await result.current.handleScan(BADGE) })
    await act(async () => { await result.current.handleScan(BADGE, { confirmed: true, confirmFor: 'IN' }) })
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({
      status: 'queued',
      message: 'Queued offline — will sync when online',
    }))
  })
})

describe('submitForgotOut timeout on a stale-ts device (skew order)', () => {
  // Device clock far behind: the chosen ts is stale AND the RPC times out.
  // Offline-ness must win (the row queues); skew messaging is for errors
  // that are ONLY skew. Previously the skew arm ran first and the scan was
  // never enqueued — silent data loss on the forgot path.
  const STALE_TS = '2020-01-01T00:00:00.000Z'

  it('queues the OUT when the write times out despite a stale ts', async () => {
    rpc.mockRejectedValueOnce(new Error('Close OUT timed out after 8000ms'))
    enqueueScan.mockResolvedValue({ ok: true, id: 'q-f', owner: 'user-A' })
    const { result, showPopup } = setup()
    let out
    await act(async () => { out = await result.current.submitForgotOut({ badge: BADGE, openId: 'open-1', ts: STALE_TS }) })
    expect(enqueueScan).toHaveBeenCalledWith(expect.objectContaining({ badge: BADGE, action: 'OUT', ts: STALE_TS }))
    expect(out).toEqual({ ok: false, reason: 'queued' })
    expect(showPopup).toHaveBeenCalledWith(expect.objectContaining({ status: 'queued' }))
  })

  it('still reports pure skew without queueing', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: new Error('Timestamp cannot be in the future') })
    const { result, showPopup } = setup()
    let out
    await act(async () => { out = await result.current.submitForgotOut({ badge: BADGE, openId: 'open-1', ts: STALE_TS }) })
    expect(enqueueScan).not.toHaveBeenCalled()
    expect(out).toEqual({ ok: false, reason: 'server', message: expect.any(String) })
    expect(showPopup).not.toHaveBeenCalled()
  })
})
