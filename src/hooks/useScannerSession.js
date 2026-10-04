import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { getQueuedScans, installDrainListeners } from '../lib/offlineQueue'
import { useScanHandler } from './useScanHandler'
import { isDecisionPopup, resolveForgotOutTime } from '../lib/scannerUtils'
import { vibrate } from '../lib/mobile'

/**
 * useScannerSession — the scan-session bundle shared by ScannerPage and
 * DeptInchargePage (extracted Phase B task 5: the two pages carried
 * near-identical popup/queue/forgot wiring and had already drifted once —
 * `in_date`-only vs event-date `or()`).
 *
 * Owns: popup + auto-dismiss, outTime, queued/syncing + the drain
 * subscription, the scan entry points (handleScan / handleCameraScan /
 * commitScan / confirmForgot), and the camera pause/resume effect (L-46).
 * Pages own their loads, lists, tabs, exports, and render.
 *
 * @param {object} cfg
 * @param {string} cfg.scheduleId
 * @param {object} cfg.profile
 * @param {string|null} cfg.deptName
 * @param {Map} cfg.deptNameById
 * @param {Map|null} cfg.directoryByBadge — mobile offline-first directory
 *   (see sewadarDirectory); forwarded to useScanHandler, null on desktop.
 * @param {object} cfg.toast — { success, error, warning, info }
 * @param {() => Promise<void>} cfg.onAfterScan — page refresh after a scan
 * @param {string} cfg.forgotSuccessToast — page-specific celebration text
 * @param {() => void} cfg.clearManual — clear the page's manual input
 */
export function useScannerSession({
  scheduleId, profile, deptName, deptNameById, directoryByBadge, toast,
  onAfterScan, forgotSuccessToast, clearManual,
}) {
  const [popup, setPopup] = useState(null)
  const [outTime, setOutTime] = useState('')
  const [queued, setQueued] = useState([])
  const [syncing, setSyncing] = useState(false)
  const dismissTimerRef = useRef(null)
  const followUpRef = useRef(null)
  const scannerRef = useRef(null)
  const wasDecisionRef = useRef(false)

  const closePopup = useCallback(() => setPopup(null), [])
  const showPopup = useCallback((data) => {
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
    // V15: the popup belongs to the schedule it was scanned under — stamping
    // it lets the confirm paths refuse a stale popup after a schedule switch.
    // A caller-supplied stamp wins (spread last) so a stale popup keeps its
    // original schedule instead of being re-keyed to the new one.
    setPopup(data && typeof data === 'object' ? { scheduleId, ...data } : data)
    // `queued` is a transient ack like in/out/flagged — it dismisses itself
    // instead of hanging until the next scan replaces it (L-48). `error`
    // deliberately stays: those paths ask the operator to retry the scan.
    if (data.status === 'in' || data.status === 'out' || data.status === 'flagged' || data.status === 'queued') {
      // Haptic confirmation, keyed to the outcome so a glance-free operator
      // still knows what happened. Skipped when the OS asks for reduced
      // motion, and a no-op where the Vibration API is absent.
      try {
        if (typeof window !== 'undefined'
          && !(typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
          if (data.status === 'flagged') vibrate([30, 40, 30])
          else if (data.status === 'queued') vibrate(15)
          else vibrate(40)
        }
      } catch { /* ignore */ }
      dismissTimerRef.current = setTimeout(() => setPopup(null), 2500)
    }
  }, [scheduleId])

  // V15: a schedule switch clears a stale decision popup (and any re-scan
  // timer) so Confirm can never write the old badge against the new schedule.
  // The confirm paths below re-check the stamp as defense in depth.
  const scheduleIdRef = useRef(scheduleId)
  useEffect(() => {
    if (scheduleIdRef.current === scheduleId) return
    scheduleIdRef.current = scheduleId
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
    if (followUpRef.current) clearTimeout(followUpRef.current)
    setPopup(null)
    setOutTime('')
  }, [scheduleId])

  // L-44: queue progress owns the syncing flag — a draining queue shows the
  // spinner instead of a static WifiOff. Raised here (rows pending), lowered
  // by onDrainProgress (queue clean). V16: assign the flag from the pending
  // count (not raise-only) so the spinner reliably clears when the queue
  // empties instead of sticking on after a drain.
  const refreshQueue = useCallback(() => getQueuedScans()
    .then(q => {
      const list = Array.isArray(q) ? q : []
      setQueued(list)
      setSyncing(list.some(x => !x.synced && !x.failed))
    })
    .catch(e => console.warn('[Scanner] queue refresh failed:', e?.message)), [])

  const drainProgressAtRef = useRef(0)
  const onDrainProgress = useCallback(() => {
    // Called per queued item — refresh queue count after each sync.
    // V15: the drain fires per item on a background subscription; a failing
    // IndexedDB read must not surface as an unhandled rejection.
    // Throttle: each refresh is getSession() + full-store getAll() + setState.
    // At one refresh per drained row the queue gets SLOWER the more it drains
    // (O(n²) storm). 750ms coalescing keeps the spinner honest without it.
    const now = Date.now()
    if (now - drainProgressAtRef.current < 750) return
    drainProgressAtRef.current = now
    getQueuedScans()
      .then(q => {
        const list = Array.isArray(q) ? q : []
        setQueued(list)
        if (!list.some(x => !x.synced && !x.failed)) setSyncing(false)
      })
      .catch(e => console.warn('[Scanner] drain progress refresh failed:', e?.message))
  }, [])

  useEffect(() => {
    const off = installDrainListeners(supabase, onDrainProgress)
    return () => {
      off()
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
      if (followUpRef.current) clearTimeout(followUpRef.current)
    }
  }, [onDrainProgress])

  const { handleScan: rawHandleScan, busy, getBusy, resetBusy, submitForgotOut } = useScanHandler({
    scheduleId,
    profile,
    deptName,
    deptNameById,
    directoryByBadge,
    showPopup,
    toast,
    onQueued: refreshQueue,
    onAfterScan,
  })

  const handleScan = useCallback(async (badge, scanOpts) => {
    // V15: a scan (camera OR manual) must not silently replace an open
    // decision popup — the operator's action click is aimed at the dialog
    // they see, and swapping it underneath writes the wrong sewadar. Confirmed
    // follow-ups (commitScan / confirmForgot's follow-up IN) carry
    // `confirmed: true` and bypass this gate.
    if (!scanOpts?.confirmed && isDecisionPopup(popup?.status)) {
      toast.warning('Answer the pending prompt first — scan paused')
      return { ok: false, reason: 'decision-pending' }
    }
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
    const result = await rawHandleScan(badge, scanOpts)
    if (result?.outTimeDefault) setOutTime(result.outTimeDefault)
    // Clear the manual input only on a successful scan — keep it on failure
    // so the user can retry without retyping. A `confirm_required` return is
    // neither: the operator still has a popup to answer.
    if (result?.ok || result?.outTimeDefault) clearManual?.()
    // T11(b): the forgot-OUT follow-up inspects this result — a wrapper that
    // swallows it would turn a busy-dropped re-IN into a silent success.
    return result
  }, [rawHandleScan, clearManual, popup, toast])

  // The camera fires on its own — a second badge scanned behind an open
  // decision popup must not silently replace the question the operator is
  // answering (their Confirm click is aimed at the dialog they see). While a
  // confirm/forgot popup is open, camera scans are dropped with a hint;
  // answering it resumes the camera. V15: manual entry is gated the same way
  // (inside handleScan) — it used to be the deliberate escape hatch, but a
  // manual submit equally swapped the dialog underneath the Confirm click.
  const handleCameraScan = useCallback((code) => {
    if (isDecisionPopup(popup?.status)) {
      toast.warning('Answer the pending prompt first — camera paused')
      return false
    }
    // T11(a) camera-suppressor contract (see the busy guard in
    // useScanHandler.js): the decline must read as declined SYNCHRONOUSLY —
    // BarcodeScanner records its 2s suppressor only when this did NOT return
    // `false`. Anything else (a promise, true) is acceptance.
    if (getBusy()) {
      toast.warning('Scanner busy — retry this badge')
      return false
    }
    return handleScan(code)
  }, [popup, handleScan, toast, getBusy])

  // Explicit choice commit — the operator tapped Mark IN / Mark OUT on a
  // `choose` popup. `confirmFor` scopes the approval to the direction the
  // choice offered, and `openId` pins an OUT to the exact session the prompt
  // named, so a state change in between re-asks instead of writing the wrong
  // entry. `manual` carries through so a hand-typed correction keeps its
  // audit flag (p_is_manual).
  const commitScan = useCallback(async () => {
    const p = popup
    if (!p || p.status !== 'choose') return
    // V15: a popup that survived a schedule switch must never write against
    // the new schedule — drop it loudly instead of committing.
    if (p.scheduleId && p.scheduleId !== scheduleId) {
      toast.warning('Schedule changed — scan the badge again')
      setPopup(null)
      return
    }
    await handleScan(p.badge, {
      confirmed: true,
      confirmFor: p.action === 'OUT' ? 'OUT' : 'IN',
      openId: p.openId || null,
      display: { name: p.name, centre: p.centre, deptName: p.deptName },
      manual: p.manual === true,
    })
  }, [popup, handleScan, scheduleId, toast])

  const confirmForgot = useCallback(async () => {
    if (!popup || popup.status !== 'forgot') return
    // V15: same schedule-stamp guard as commitScan — a stale forgot form must
    // never close a session on the new schedule.
    if (popup.scheduleId && popup.scheduleId !== scheduleId) {
      toast.warning('Schedule changed — scan the badge again')
      setPopup(null)
      return
    }
    // Format, then range/order vs IN. The regex alone let a future or pre-IN
    // time through to a scan_out that raises ('OUT time must be after IN time',
    // v41) or writes a session that can never be closed.
    const out = resolveForgotOutTime({ inDate: popup.in_date, inTime: popup.in_time, value: outTime })
    if (out.invalid) { toast.error('Pick a valid OUT time'); return }
    if (out.clamped) {
      setOutTime(out.value)
      toast.warning(out.clamped === 'future'
        ? `OUT time was ahead of the scanner clock — using ${out.value} IST`
        : `OUT time was before the IN — using ${out.value} IST`)
    }
    const ts = new Date(out.ts).toISOString()
    // L-36: the OUT write goes through the hook's submitForgotOut — the same
    // RPC attempt + offline enqueue as the main OUT flow. The popup's identity
    // rides along so a queued forgot-OUT still names the sewadar.
    const r = await submitForgotOut({ badge: popup.badge, openId: popup.openId, ts, display: { name: popup.name ?? null, centre: popup.centre ?? null, deptName: popup.deptName ?? null } })
    if (!r.ok && r.reason === 'server') { toast.error(r.message); return }
    if (!r.ok) return // queued/duplicate/queue errors already surfaced; no follow-up while the OUT hasn't synced
    toast.success(forgotSuccessToast)
    setPopup(null)
    setOutTime('')
    // `confirmFor: 'IN'` — the operator already decided this OUT, and the next
    // entry is the fresh IN. Scoped to 'IN' so the approval cannot also
    // authorise closing a session that appeared in the 200ms window.
    // T11(b): the follow-up result MUST be inspected (see the V7 contract in
    // useScanHandler.js) — a re-IN racing an inflight scan is dropped as
    // `{ ok: false, reason: 'busy' }`, and showing nothing would leave the OUT
    // without its IN while the operator saw success.
    if (followUpRef.current) clearTimeout(followUpRef.current)
    const badge = popup.badge
    followUpRef.current = setTimeout(() => {
      ;(async () => {
        let r
        try {
          r = await handleScan(badge, { confirmed: true, confirmFor: 'IN' })
        } catch {
          r = { ok: false }
        }
        if (r && r.ok === false) {
          showPopup({ status: 'error', badge, message: 'follow-up IN did not land — re-scan', time: new Date().toLocaleTimeString() })
          toast.warning('follow-up IN did not land — re-scan')
        }
      })()
    }, 200)
  }, [popup, outTime, toast, submitForgotOut, forgotSuccessToast, handleScan, scheduleId, showPopup])

  // L-46: make "camera paused" true. While a decision prompt is open the
  // decode loop halts (the preview keeps its last frame); resolving the
  // prompt resumes. Track the transition explicitly so mount (popup null,
  // camera never started) never triggers a spurious resume→start.
  useEffect(() => {
    const sc = scannerRef.current
    const isDec = isDecisionPopup(popup?.status)
    if (isDec) {
      wasDecisionRef.current = true
      sc?.pause?.()
    } else if (wasDecisionRef.current) {
      wasDecisionRef.current = false
      sc?.resume?.()
    }
  }, [popup])

  return {
    popup, outTime, setOutTime, showPopup, closePopup,
    handleScan, handleCameraScan, commitScan, confirmForgot,
    busy, resetBusy,
    queued, syncing, refreshQueue, scannerRef,
  }
}
