/**
 * useScanHandler — shared scan-in/scan-out logic used by both ScannerPage
 * and DeptInchargePage. Eliminates code duplication and ensures consistent
 * timeout, busy-flag safety, and error handling.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { BADGE_REGEX, sanitizeScannedBadge } from '../lib/logic'
import { scanDisplay } from '../lib/scanDisplay'
import { enqueueScan, getQueuedScans } from '../lib/offlineQueue'
import {
  friendly,
  withTimeout,
  SCAN_RPC_TIMEOUT,
  SESSION_RPC_TIMEOUT,
  getBusySafetyTimeout,
  resolveForgotOutTime,
  isTimestampStale,
  todayStrIST,
  hmsIST,
} from '../lib/scannerUtils'

/**
 * Network/timeout-type errors only — these may fall through to scan_in.
 * Anything else (auth/RLS/permission/validation) must surface directly.
 * Supabase JS errors carry { message, code, hint }; when in doubt, surface
 * rather than swallow.
 */
function isNetworkOrTimeoutError(e) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true
  const msg = String(e?.message || '')
  return msg.includes('Failed to fetch') || msg.includes('Load failed') || msg.includes('timed out')
    || msg.includes('NetworkError') || msg.includes('Network request failed')
    || e?.name === 'TimeoutError'
}

/** Auth/RLS-type errors — never swallowed, surfaced with their message. */
function isAuthError(e) {
  const code = String(e?.code || '')
  const msg = String(e?.message || '')
  return code === '401' || code === '403' || code === '42501'
    || code.startsWith('PGRST3')
    || /jwt|auth|permission|not authorized|row-level|rls|policy/i.test(msg)
}

/**
 * A LOCAL timeout, raised by `withTimeout`'s own AbortController.
 *
 * This is the one class of failure the scan flow must never treat as "no open
 * session": `withTimeout` abandons the race without cancelling the in-flight
 * request, so at the moment this throws the sewadar's real session state is
 * UNKNOWN — they may well be checked in. Proceeding to `scan_in` on that
 * assumption produces the 'Already IN' dead end, and the operator has no
 * session id and no way to close the session. Matched on the message
 * `withTimeout` builds; the alternative (editing scannerUtils) is out of scope.
 */
function isTimeoutError(e) {
  return /timed out after \d+ms$/i.test(String(e?.message || ''))
}

/**
 * V14: clock-skew rejections from `scan_in`/`scan_out` (v26/v46 guards:
 * 'Timestamp cannot be in the future' past now()+5min, 'Timestamp too old'
 * before now()-30d). The device clock disagrees with the server clock, so
 * the raw text is replaced with the device-clock warning — warn-only, the
 * ts that was sent is never rewritten (cf. resolveForgotOutTime clamping).
 */
const CLOCK_SKEW_MESSAGE = 'Device clock looks wrong — check the date/time and retry the scan'
function isClockSkewMessage(msg) {
  const s = String(msg || '')
  return s.includes('Timestamp cannot be in the future') || s.includes('Timestamp too old')
}
/**
 * True when the failure is a clock-skew rejection: either the server said so
 * explicitly, or the ts we sent is itself outside the budget the server
 * enforces (same 5min/30d window via isTimestampStale — e.g. a replayed or
 * caller-supplied ts that could never be accepted).
 */
function isClockSkewed(msg, ts) {
  return isClockSkewMessage(msg) || isTimestampStale(Date.parse(ts))
}

/**
 * Client-generated idempotency nonce for one scan attempt.
 *
 * The offline drain re-issues a scan with `p_nonce: q.id` (offlineQueue.js), so
 * the SAME value must be used online — otherwise a commit whose RESPONSE was
 * lost gets a fresh nonce on retry, which is the one value the server could
 * have deduped on. `enqueueScan` honours an incoming `scan.id`, so this single
 * id serves as both the online `p_nonce` and the queued row's id.
 */
function newNonce() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch { /* fall through to the manual nonce */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

/**
 * The date/time row the scan popup renders for the event it is describing.
 *
 * IST, not the device zone — the same reason `hhmmIST` exists: every stamp this
 * app writes or reads is IST (`in_date`/`in_time` are bare columns fed by
 * `(p_ts AT TIME ZONE 'Asia/Kolkata')::time`). Seconds are kept so the popup
 * agrees with those columns instead of rounding to a minute.
 *
 * "The moment" is right for every direction: for a `choose` popup it is the
 * time the pending write WILL record, and for an `in`/`out` result it is the
 * time that was just recorded (`p_ts` is always `new Date().toISOString()`),
 * so the two differ only by the tap latency.
 *
 * @returns {{eventDate: string, eventTime: string}} YYYY-MM-DD + HH:MM:SS in IST
 */
function eventStamp() {
  const now = new Date()
  return { eventDate: todayStrIST(now), eventTime: hmsIST(now) }
}

/**
 * `get_scan_state` (v44) that keeps a TIMEOUT distinguishable from a genuine
 * "no open session" and from a PostgREST failure — the three states the scan
 * flow reacts to completely differently.
 *
 * One round trip answers three questions: is there an OPEN session, when did
 * this sewadar last go OUT, and — since v65 — who this sewadar is. The third
 * is what makes the IN-side prompt show a name at all for a badge that has
 * never scanned in this schedule, and it is read from the source tables
 * (`get_sewadar_by_badge` + `deployments`), not from session history, so it is
 * never null just because sessions are.
 *
 * @returns {Promise<{kind:'ok', open:object|null, lastOut:object|null, sewadar:object|null} | {kind:'timeout', error:Error} | {kind:'error', error:any}>}
 */
async function lookupScanState(badge, scheduleId) {
  try {
    const { data, error } = await withTimeout(
      supabase.rpc('get_scan_state', { p_badge: badge, p_schedule: scheduleId }),
      SESSION_RPC_TIMEOUT,
      'Session lookup'
    )
    if (error) {
      // v44 not applied yet (PGRST202). Degrade instead of killing the scanner:
      // the v40 function still answers "is there an open session", so the whole
      // OUT ladder keeps working. Only the "recently OUT" half of the confirm
      // guard goes inert, which is a far better failure than every scan in the
      // field reporting "session lookup failed".
      if (String(error?.code) === 'PGRST202') return lookupOpenSessionLegacy(badge, scheduleId)
      return { kind: 'error', error }
    }
    // `get_open_session` returns a TABLE ROW TYPE, and plpgsql's
    // `SELECT * INTO v_row … LIMIT 1` + `RETURN v_row` yields an ALL-NULL
    // record when there is no session — verified on PG 15:
    // `to_jsonb(fn())` is `{"id": null, "status": null, …}`, a truthy JSON
    // OBJECT, not `null`. PostgREST serialises the composite that way, so the
    // old `data || null` reported "a session exists" for every sewadar: the
    // client always took the OUT branch, `open.id` was null, `scan_out` fell
    // back to its own lookup, found nothing open and answered "No open session
    // to close" for a sewadar who had never scanned IN. The IN branch was
    // unreachable. Unwrap a 1-row set (PostgREST may serialise a composite
    // return either way) and require a real id.
    const row = Array.isArray(data) ? data[0] : data
    // v65: `sewadar` is the identity, present even for a badge with zero
    // session rows. Pre-v65 the key is absent — `?? null` keeps the old
    // behaviour (fall back to `lastOut`) rather than throwing.
    return {
      kind: 'ok',
      open: row?.open?.id ? row.open : null,
      lastOut: row?.last_out || null,
      sewadar: row?.sewadar ?? null,
    }
  } catch (e) {
    // A timeout means "unknown", never "no session" — keep it its own kind.
    if (isTimeoutError(e)) return { kind: 'timeout', error: e }
    return { kind: 'error', error: e }
  }
}

/**
 * Pre-v44 fallback, used only when `get_scan_state` is missing (PGRST202).
 *
 * `get_open_session` returns a TABLE ROW TYPE, and plpgsql's
 * `SELECT * INTO v_row … LIMIT 1` + `RETURN v_row` yields an ALL-NULL record
 * when there is no session — verified on PG 15: `to_jsonb(fn())` is
 * `{"id": null, "status": null, …}`, a truthy JSON OBJECT, not `null`. Unwrap a
 * 1-row set (PostgREST may serialise a composite return either way) and require
 * a real id. `lastOut` is null, so the IN-side guard is simply skipped.
 *
 * @returns {Promise<{kind:'ok', open:object|null, lastOut:null, sewadar:null} | {kind:'timeout', error:Error} | {kind:'error', error:any}>}
 */
async function lookupOpenSessionLegacy(badge, scheduleId) {
  try {
    const { data, error } = await withTimeout(
      supabase.rpc('get_open_session', { p_badge: badge, p_schedule: scheduleId }),
      SESSION_RPC_TIMEOUT,
      'Session lookup'
    )
    if (error) return { kind: 'error', error }
    const row = Array.isArray(data) ? data[0] : data
    return { kind: 'ok', open: row?.id ? row : null, lastOut: null, sewadar: null }
  } catch (e) {
    if (isTimeoutError(e)) return { kind: 'timeout', error: e }
    return { kind: 'error', error: e }
  }
}

/**
 * @param {object} opts
 * @param {string} opts.scheduleId
 * @param {object} opts.profile — { centre }
 * @param {string} opts.deptName — current department name (for DeptInchargePage).
 *   NOTE: this is the OPERATOR's own dept filter, NOT the scanned sewadar's
 *   department. It stays semantically correct only in the "Not deployed to
 *   <deptName>" flag text; popup identity fields come from `scanDisplay`.
 * @param {Map<string,string>} [opts.deptNameById] — optional
 *   Map<department_id, department_name> (as `deptNameMap` builds) used to
 *   resolve a session row's `sewadar_dept` id snapshot into a NAME. Optional:
 *   the hook never fetches departments itself, and without it `scanDisplay`
 *   yields `deptName: null` — the v43 RPC's own `dept_name` still populates
 *   the IN/OUT popup.
 * @param {Map<string,{badge,name,centre,deptId}>} [opts.directoryByBadge] —
 *   optional mobile offline-first directory (see `sewadarDirectory`): identity
 *   ONLY, never session state. Sits between the live `sewadar` key and the
 *   session snapshot (`sewadar || directory || session`), so a cached name
 *   fills offline/stale gaps while live data always wins online.
 * @param {Function} opts.showPopup — (data) => void
 * @param {Function} opts.toast — toast object { success, error, warning }
 * @param {Function} opts.onQueued — called after enqueue (to refresh queue count)
 * @param {Function} opts.onAfterScan — called after scan completes (to refresh sessions)
 * @returns {{ handleScan: (badge: string, opts?: {confirmed?: boolean, confirmFor?: 'OUT'|'IN'|null, openId?: string|null, display?: object|null}) => Promise<{ok: boolean, reason?: string, outTimeDefault?: string}>, busy: boolean, getBusy: () => boolean, resetBusy: () => void }}
 *
 * `handleScan(badge, opts)`:
 *  - Plain call (no `confirmed`): LOOKUP ONLY, never writes. Resolves the
 *    sewadar's state and shows a `choose` popup — the details plus the ONE
 *    valid direction (Mark IN when no session is open, Mark OUT when one is
 *    open and ≤12h old) — and returns `{ ok: false, reason:
 *    'confirm_required', action }`. The write happens only via a confirmed
 *    callback below, i.e. after the operator taps the button.
 *  - `opts.confirmed` + `opts.confirmFor` — the operator tapped Mark IN /
 *    Mark OUT on a `choose` popup. The approval is SCOPED to one direction:
 *    `confirmFor: 'OUT'` authorises closing the session, `'IN'` authorises
 *    one fresh IN. An approval whose direction does not match the next entry
 *    re-asks instead of writing, because between the question and the click
 *    the sewadar's state can change. Omitting `confirmFor` disarms nothing
 *    (fail-closed).
 *  - `opts.openId` — the exact session a `choose`/OUT prompt was raised for.
 *    When set with `confirmed` + `confirmFor: 'OUT'`, `scan_out` is issued
 *    straight against that id with NO re-lookup, so a session closed by another
 *    operator in the meantime surfaces as v41's mismatch/no-session error
 *    instead of silently toggling whatever the sewadar's state has become.
 *    Null `openId` (offline-chosen OUT) lets `scan_out` resolve the open
 *    session itself.
 *  - `opts.display` — the identity already resolved for the prompt, reused to
 *    label the resulting popup without a second lookup.
 *
  * EVERY exit of handleScan resolves to an object carrying a boolean `ok` —
  * callers may destructure the result without a TypeError. `outTimeDefault` is
  * present only on the forgot-OUT prompt, where the scan is not yet written.
  *
  * V6 (busy): a call arriving while another scan is in flight is DROPPED with
  * `{ ok: false, reason: 'busy' }` — plus a visible error popup + warning toast
  * so the operator retries the badge. The reason is DISTINCT on purpose (see
  * the camera-suppressor contract at the busy guard): a 'busy' means "this
  * scan never ran", which is different from every other ok:false outcome.
  *
  * V7 (forgot-OUT follow-up): the 200ms re-IN that follows a forgot-OUT lives
  * in useScannerSession (NOT in this hook) and fires blind — if it races an
  * inflight scan it is dropped as `{ ok: false, reason: 'busy' }`. The caller
  * MUST inspect the returned `{ ok, reason }`: on `ok: false` (notably
  * `reason: 'busy'`) it must re-arm/retry instead of assuming the IN landed,
  * or the OUT is left without its follow-up IN while the operator saw success.
  * The hook side of that contract is this distinct 'busy' reason — verified by
  * the V7 test pinning it for a confirm-scoped follow-up re-IN.
  */
export function useScanHandler({ scheduleId, profile, deptName, deptNameById, directoryByBadge, showPopup, toast, onQueued, onAfterScan }) {
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const safetyTimerRef = useRef(null)
  // Busy-notify throttle: while busy the camera re-offers the same badge every
  // confirmed frame (T11 contract — declined scans must stay re-offerable), so
  // an unthrottled popup + toast here mounts per frame for the whole RPC. The
  // decline itself stays immediate; only the user-visible notify is damped.
  const busyNotifyRef = useRef({ badge: null, time: 0 })
  const BUSY_NOTIFY_MS = 2000
  // A2 (L-09): last successful OFFLINE enqueue per badge+action. A double tap,
  // a badge held in front of the lens, or a manual double-submit while
  // offline would otherwise queue duplicate rows — the camera's 2s suppressor
  // does not cover the manual path or cross-path (C4 OUT then IN) races.
  const lastQueuedAtRef = useRef(new Map())
  const OFFLINE_DUPE_MS = 2000
  const noteQueuedOffline = useCallback((badge, action) => {
    // The dupe key includes the schedule: the same badge scanned under two
    // schedules within 2s is two distinct intents, not a double tap.
    lastQueuedAtRef.current.set(`${scheduleId}:${badge}:${action}`, Date.now())
  }, [scheduleId])
  const isOfflineDupe = useCallback((badge, action) => {
    const at = lastQueuedAtRef.current.get(`${scheduleId}:${badge}:${action}`)
    return at !== undefined && Date.now() - at < OFFLINE_DUPE_MS
  }, [scheduleId])
  // A2 (L-01): belt-and-braces. A1 made the real enqueueScan never reject,
  // but if any future change (or a test double) throws, the rejection must
  // still surface as a write-failed outcome — never escape handleScan, whose
  // outer try has only a finally and would turn it into silent data loss.
  const tryEnqueue = useCallback(async (args) => {
    try {
      return await enqueueScan(args)
    } catch (e) {
      return { ok: false, reason: 'write-failed', error: e }
    }
  }, [])
  const offlineEnqueueFailed = useCallback((res, badge) => {
    const time = new Date().toLocaleTimeString()
    if (res.reason === 'full') {
      showPopup({ status: 'error', badge, message: 'Offline queue is full (2000 scans) — sync when online, or clear queued scans', time })
      toast.error('Offline queue is full')
      return { ok: false, reason: 'offline_queue_full' }
    }
    if (res.reason === 'write-failed') {
      showPopup({ status: 'error', badge, message: 'Offline queue write failed — please retry the scan', time })
      toast.error('Offline queue write failed')
      return { ok: false, reason: 'offline_queue_write_failed' }
    }
    showPopup({ status: 'error', badge, message: 'Offline storage unavailable — please enter manually when online', time })
    toast.error('Offline storage unavailable')
    return { ok: false, reason: 'offline_storage_unavailable' }
  }, [showPopup, toast])

  // Network/timeout failures are the ONLY ones that may fall through to an
  // offline enqueue — auth/RLS/validation errors must surface (the file's
  // header contract). Shared by the main OUT flow, submitForgotOut and the IN
  // write. Matches the header isNetworkOrTimeoutError plus Safari's
  // 'Load failed' — a jammer/filtered uplink keeps navigator.onLine true, so
  // link state alone can never be the gate.
  const isOfflineLike = (msg) => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true
    const m = String(msg || '')
    return m.includes('Failed to fetch') || m.includes('Load failed') || m.includes('timed out')
      || m.includes('NetworkError') || m.includes('Network request failed')
  }

  // Identity resolvers, declared before the enqueue helpers that list them
  // as deps (a useCallback deps array evaluates at declaration — referencing
  // these below their declaration is a TDZ crash on every render).
  const displayOf = useCallback(
    (payload) => scanDisplay(payload, deptNameById),
    [deptNameById]
  )

  /**
   * Directory identity as an RPC-shaped payload for scanDisplay: the cached
   * name/home-centre/effective-dept (id via sewadar_dept resolved through
   * deptNameById, or a VSS roster NAME via dept_name). Null on any miss — the
   * merge falls through to the session snapshot exactly as before.
   */
  const dirFor = useCallback(
    (badge) => {
      const key = String(badge ?? '').trim().toUpperCase()
      if (!key || !directoryByBadge || typeof directoryByBadge.get !== 'function') return null
      const e = directoryByBadge.get(key)
      if (!e) return null
      return { sewadar_name: e.name ?? null, sewadar_centre: e.centre ?? null, sewadar_dept: e.deptId ?? null, dept_name: e.deptName ?? null }
    },
    [directoryByBadge]
  )

  // L-36 core: attempt an OUT write, falling back to the offline queue.
  // Returns { handled, outcome } so each caller keeps its own success UX:
  // the main flow celebrates inline, the forgot flow stays silent for the
  // page to celebrate (it must keep its form on error).
  const enqueueOutFallback = useCallback(async ({ b, ts, openId, manual, display }, msg) => {
    if (!isOfflineLike(msg)) return { handled: false }
    if (isOfflineDupe(b, 'OUT')) {
      toast.warning('Already queued — ignoring duplicate scan')
      return { handled: true, outcome: { ok: false, reason: 'duplicate_queued' } }
    }
    const queuedRes = await tryEnqueue({ badge: b, schedule_id: scheduleId, action: 'OUT', ts, open_id: openId, centre: profile?.centre, is_manual: manual === true })
    if (!queuedRes.ok) return { handled: true, outcome: offlineEnqueueFailed(queuedRes, b) }
    noteQueuedOffline(b, 'OUT')
    // Identity survives queueing: the forgot popup named the sewadar, else the
    // directory — a queued ack with no name reads as a lost scan.
    const dirQ = displayOf(dirFor(b))
    showPopup({ status: 'queued', action: 'OUT', badge: b, name: display?.name ?? dirQ.name, centre: display?.centre ?? dirQ.centre, deptName: display?.deptName ?? dirQ.deptName, time: new Date().toLocaleTimeString(), ...eventStamp(), message: 'Queued offline — will sync when online' })
    toast.success(`OUT queued (offline) ${b}`)
    onQueued?.()
    return { handled: true, outcome: { ok: false, reason: 'queued' } }
  }, [scheduleId, profile, showPopup, toast, onQueued, isOfflineDupe, tryEnqueue, noteQueuedOffline, offlineEnqueueFailed, displayOf, dirFor])

  // L-36: the forgot-OUT confirm path with the same offline parity as the
  // main OUT flow. Silent on online paths — the page keeps its form on
  // error and celebrates + follows up on success. Loud only on the offline
  // paths the page cannot produce itself (queued UI + distinct queue errors).
  const submitForgotOut = useCallback(async ({ badge, openId, ts, display }) => {
    try {
      const { error } = await withTimeout(
        // v67: the forgot time is operator-entered, so the close is manual.
        supabase.rpc('scan_out', { p_badge: badge, p_schedule: scheduleId, p_ts: ts, p_open_id: openId, p_is_manual: true }),
        SCAN_RPC_TIMEOUT,
        'Close OUT'
      )
      if (error) throw error
      return { ok: true }
    } catch (e) {
      const msg = String(e.message || '')
      // V14: a clock-skew rejection keeps the page's form AND names the cause.
      if (isClockSkewed(msg, ts)) return { ok: false, reason: 'server', message: CLOCK_SKEW_MESSAGE }
      const fb = await enqueueOutFallback({ b: badge, ts, openId, manual: true, display }, msg)
      if (fb.handled) return fb.outcome
      return { ok: false, reason: 'server', message: friendly(msg) }
    }
  }, [enqueueOutFallback, scheduleId])

  /**
   * The ONE resolver for popup identity fields. Since v40 a session row's
   * `centre` is a scan VENUE, so `scanDisplay` reads `sewadar_centre` only —
   * routing every sewadar-bearing popup through it means the venue can never
   * be labelled as a sewadar's centre again. Absent keys (a pre-v43 RPC, or a
   * session row without a dept snapshot) resolve to null rather than throwing.
   * (displayOf/dirFor live above, beside the enqueue helpers that dep on them.)
   */

  const getBusy = useCallback(() => busyRef.current, [])

  const resetBusy = useCallback(() => {
    busyRef.current = false
    setBusy(false)
    if (safetyTimerRef.current) { clearTimeout(safetyTimerRef.current); safetyTimerRef.current = null }
  }, [])

  const setBusySafe = useCallback(() => {
    busyRef.current = true
    setBusy(true)
    // Safety: auto-reset after BUSY_SAFETY_TIMEOUT if handleScan hangs
    if (safetyTimerRef.current) clearTimeout(safetyTimerRef.current)
    safetyTimerRef.current = setTimeout(() => {
      if (busyRef.current) {
        console.warn('[Scanner] busy flag auto-reset after safety timeout')
        busyRef.current = false
        setBusy(false)
      }
    }, getBusySafetyTimeout())
  }, [])

  // Clear the busy safety timer on unmount — no setBusy after unmount.
  useEffect(() => () => {
    if (safetyTimerRef.current) { clearTimeout(safetyTimerRef.current); safetyTimerRef.current = null }
  }, [])

  const handleScan = useCallback(async (badge, scanOpts = {}) => {
    const { confirmed = false, confirmFor = null, openId = null, display = null, manual = false } = scanOpts
    /**
     * An approval authorises exactly ONE direction — the one the question was
     * asked about. A single `confirmed` boolean that disarmed both gates was a
     * real defect: `confirm_in` carries no `openId`, so it cannot take the
     * fast-path, re-runs the lookup, and if another operator has meanwhile
     * marked the sewadar IN it fell straight past the OUT guard and closed that
     * session — authoring the exact 90-second entry the gate exists to prevent.
     * An approval with no direction (or a mismatched one) disarms NOTHING, so a
     * caller that forgets `confirmFor` re-asks rather than writing blind.
     */
    const isConfirmed = (dir) => confirmed === true && confirmFor === dir
    // V6: a busy-guard drop must SURFACE feedback — the old silent return left
    // the operator holding a badge at a seemingly dead scanner. Toast + error
    // popup name the badge so the retry is obvious. The reason stays the
    // DISTINCT 'busy' (never folded into another reason): callers — notably
    // the camera's 2s duplicate-suppressor (Track 4) — rely on it to tell "this
    // scan never ran, retry me" apart from a real outcome. CAMERA SUPPRESSOR
    // CONTRACT (Track 4 owns BarcodeScanner.jsx — NOT touched here):
    // BarcodeScanner must record its `lastScan` suppressor entry only AFTER
    // onScan acceptance, i.e. only when this hook did NOT answer 'busy'.
    // Recording it before the call burns the 2s window on a scan that never
    // ran, so the operator's retry is swallowed as a duplicate.
    if (busyRef.current) {
      const bBusy = String(badge ?? '').trim().toUpperCase()
      // Throttled notify: same badge within the window stays a silent decline
      // (still returns busy/false so the camera keeps re-offering per T11).
      const nowBusy = Date.now()
      if (busyNotifyRef.current.badge !== bBusy || nowBusy - busyNotifyRef.current.time >= BUSY_NOTIFY_MS) {
        busyNotifyRef.current = { badge: bBusy, time: nowBusy }
        showPopup({ status: 'error', badge: bBusy, message: 'Scanner busy — retry this badge', time: new Date().toLocaleTimeString() })
        toast.warning('Scanner busy — retry this badge')
      }
      return { ok: false, reason: 'busy' }
    }
    // Sanitise BEFORE validation so a recoverable noisy read (stray guards,
    // spaces, case, positional confusions) is accepted instead of rejected.
    // Clean values pass through unchanged (sanitizeScannedBadge is idempotent).
    const b = sanitizeScannedBadge(badge)
    if (!b) return { ok: false, reason: 'empty' }
    if (!BADGE_REGEX.test(b)) {
      showPopup({ status: 'error', badge: b, message: 'Invalid badge format — check FB/BH/VS', time: new Date().toLocaleTimeString() })
      return { ok: false, reason: 'invalid_badge' }
    }

    setBusySafe()
    let scanOk = false
    // One nonce per attempt: online p_nonce AND the queued row's id (D-3).
    const nonce = newNonce()
    try {
      // ── Commit path: the operator tapped Mark OUT on a `choose` popup ──
      // Act on the pinned session id directly and skip the lookup: a re-lookup
      // would read whatever the sewadar's state has become in the meantime, and
      // could mark a fresh IN against a different session. scan_out (v41) already
      // raises on a stale or mismatched p_open_id, so a race surfaces honestly.
      // A null openId (OUT chosen while the lookup was unreachable) lets
      // scan_out resolve the open session itself.
      if (isConfirmed('OUT')) {
        const tsFast = new Date().toISOString()
        try {
          const { data: outFastData, error: outFastError } = await withTimeout(
            // v67: manual badge entry marks the close, like scan_in.
            supabase.rpc('scan_out', { p_badge: b, p_schedule: scheduleId, p_ts: tsFast, p_open_id: openId || null, p_is_manual: manual }),
            SCAN_RPC_TIMEOUT,
            'Scan OUT'
          )
          if (outFastError) throw outFastError
          // I3: the server answers ok/dedup when the pinned session was
          // already closed (someone else closed it after the prompt). That is
          // NOT a fresh OUT — say so honestly instead of "OUT marked", or the
          // operator walks away while the sewadar may still be checked in.
          if (outFastData?.dedup) {
            showPopup({
              status: 'out', badge: b,
              name: display?.name ?? null, centre: display?.centre ?? null, deptName: display?.deptName ?? null,
              time: new Date().toLocaleTimeString(), message: 'OUT already recorded — no change',
              ...eventStamp(),
            })
            toast.warning(`OUT already recorded ${b}`)
            scanOk = true
          } else {
          showPopup({
            status: 'out', badge: b,
            name: display?.name ?? null, centre: display?.centre ?? null, deptName: display?.deptName ?? null,
            time: new Date().toLocaleTimeString(), message: 'OUT marked',
            ...eventStamp(),
          })
          toast.success(`OUT ${b}`)
          scanOk = true
          }
        } catch (e) {
          const msg = String(e.message || '')
          // A LOCAL withTimeout abort lands here too (the race is abandoned,
          // not cancelled, so the write may still complete server-side).
          // Queueing anyway is safe, not sloppy: the drain replays the same
          // p_open_id, and v41 answers ok/dedup when the session is already
          // CLOSED — so the worst case is a phantom queue row, never a second
          // session. This mirrors the normal OUT path on purpose; do not
          // "fix" the fast-path alone or the two paths diverge.
          if (isOfflineLike(msg)) {
            if (isOfflineDupe(b, 'OUT')) {
              toast.warning('Already queued — ignoring duplicate scan')
              return { ok: false, reason: 'duplicate_queued' }
            }
            const queuedRes = await tryEnqueue({ badge: b, schedule_id: scheduleId, action: 'OUT', ts: tsFast, open_id: openId || null, centre: profile?.centre, is_manual: manual })
            if (!queuedRes.ok) return offlineEnqueueFailed(queuedRes, b)
            noteQueuedOffline(b, 'OUT')
            // The OUT choice named the sewadar (live, directory or snapshot) —
            // carry it into the ack, else the queued popup blanks (dir fallback
            // covers a choice that itself came from a blank error branch).
            const dirQO = displayOf(dirFor(b))
            showPopup({ status: 'queued', action: 'OUT', badge: b, name: display?.name ?? dirQO.name, centre: display?.centre ?? dirQO.centre, deptName: display?.deptName ?? dirQO.deptName, time: new Date().toLocaleTimeString(), ...eventStamp(), message: 'Queued offline — will sync when online' })
            toast.success(`OUT queued (offline) ${b}`)
            scanOk = true
            onQueued?.()
          } else if (isClockSkewed(msg, tsFast)) {
            // V14: the device clock disagrees with the server — say so instead
            // of the raw 'Timestamp …' text. Warn-only: tsFast is sent unchanged.
            showPopup({ status: 'error', badge: b, message: CLOCK_SKEW_MESSAGE, time: new Date().toLocaleTimeString() })
            toast.warning(CLOCK_SKEW_MESSAGE)
          } else {
            showPopup({ status: 'error', badge: b, message: friendly(msg), time: new Date().toLocaleTimeString() })
            toast.error(friendly(msg))
          }
        }
        onAfterScan?.()
        return { ok: scanOk }
      }

      // Step 1: resolve the sewadar's scan state in one round trip, keeping a
      // timeout distinct from "no open session" (D-1) and surfacing PostgREST
      // errors (D-2). A committed IN (the operator tapped Mark IN) skips the
      // re-lookup and writes directly — symmetric with the OUT fast-path
      // above. The server is authoritative: a concurrent IN surfaces as
      // Already IN in the write below, with the same refetch handling.
      // Offline short-circuit: with no link a lookup can only time out after
      // 5s, so skip it and go straight to the queueable choice — the popup is
      // instant and the directory (when loaded) still names the sewadar.
      const offlineFast = !isConfirmed('IN') && typeof navigator !== 'undefined' && navigator.onLine === false
      const lookup = isConfirmed('IN') ? { kind: 'committed' } : offlineFast ? { kind: 'offline' } : await lookupScanState(b, scheduleId)
      let open = null
      let lastOut = null
      // v65: the sewadar's own identity, resolved from the source tables so a
      // badge with no session history still renders a name in the prompt.
      let sewadar = null
      if (lookup.kind === 'timeout' || lookup.kind === 'offline') {
        // Session state UNKNOWN — and on timeout, reachability unknown too: a
        // jammer or filtered uplink keeps navigator.onLine true while nothing
        // completes, so link state can never gate this. Offer the same
        // queueable explicit choice as the error branch (with the pending-IN
        // probe, so a second scan of a badge with an unsynced IN offers OUT,
        // never a duplicate IN). Nothing is auto-written; tapping queues
        // offline or writes online. The mobile directory names the sewadar
        // here when the server cannot be reached at all.
        let pendingIn = false
        try {
          const queued = await getQueuedScans()
          pendingIn = (queued || []).some(q =>
            q && q.synced !== true && q.failed !== true && q.status !== 'failed'
            && q.action === 'IN' && q.badge === b && q.schedule_id === scheduleId)
        } catch { /* queue unreadable — default to the IN choice below */ }
        const dir = displayOf(dirFor(b))
        const timedOut = lookup.kind === 'timeout'
        console.warn(timedOut ? '[Scanner] session lookup timed out, offering explicit choice' : '[Scanner] offline — offering explicit choice without lookup')
        showPopup({
          status: 'choose', action: pendingIn ? 'OUT' : 'IN', badge: b, manual,
          name: dir.name, centre: dir.centre, deptName: dir.deptName,
          message: pendingIn
            ? (timedOut
              ? 'Session lookup timed out — a local IN is still queued, so this looks like the OUT. Tap to queue it.'
              : 'Offline — a local IN is still queued, so this looks like the OUT. Tap to queue it.')
            : (timedOut
              ? 'Session lookup timed out — tap to queue, it will sync when online.'
              : 'Offline — tap to queue, it will sync when online.'),
        })
        return { ok: false, reason: 'confirm_required', action: pendingIn ? 'OUT' : 'IN' }
      } else if (lookup.kind === 'error') {
        const e = lookup.error
        if (isNetworkOrTimeoutError(e) && !isAuthError(e)) {
          // Network/timeout only — server state is UNKNOWN, not "no open
          // session", so nothing may be auto-written. Offer the explicit
          // choice instead: C4 — when this device already holds an unsynced
          // IN for the badge, this scan is almost certainly the OUT, so the
          // single valid button is Mark OUT (open_id null: scan_out resolves
          // the open session itself, and the drain replays the earlier IN
          // first by createdAt). Otherwise the button is Mark IN. Tapping it
          // queues when still offline, writes when back online.
          let pendingIn = false
          try {
            const queued = await getQueuedScans()
            pendingIn = (queued || []).some(q =>
              q && q.synced !== true && q.failed !== true && q.status !== 'failed'
              && q.action === 'IN' && q.badge === b && q.schedule_id === scheduleId)
          } catch { /* queue unreadable — default to the IN choice below */ }
          console.warn('[Scanner] get_scan_state failed, offering explicit choice:', e.message)
          // Same directory identity as the offline/timeout branch above — a
          // jammer/filtered uplink lands here (not there) while onLine stays
          // true, and must name the sewadar identically.
          const dirErr = displayOf(dirFor(b))
          showPopup({
            status: 'choose', action: pendingIn ? 'OUT' : 'IN', badge: b, manual,
            name: dirErr.name, centre: dirErr.centre, deptName: dirErr.deptName,
            message: pendingIn
              ? 'Session lookup unreachable — a local IN is still queued, so this looks like the OUT. Tap to queue it.'
              : 'Session lookup unreachable — tap to queue, it will sync when online.',
          })
          return { ok: false, reason: 'confirm_required', action: pendingIn ? 'OUT' : 'IN' }
        } else {
          // Auth/RLS (or anything else) — surface directly, no scan_in fall-through
          const msg = String(e.message || '')
          showPopup({ status: 'error', badge: b, message: friendly(msg), time: new Date().toLocaleTimeString() })
          toast.error(friendly(msg))
          return { ok: false, reason: 'session_lookup_failed' }
        }
      } else {
        open = lookup.open
        lastOut = lookup.lastOut
        sewadar = lookup.sewadar ?? null
      }
      if (open) {
        // ── OUT flow ──────────────────────────────────────────────
        const inTs = new Date(`${open.in_date}T${open.in_time}+05:30`).getTime()
        const hrs = (Date.now() - inTs) / 3600000
        if (hrs > 12) {
          // v65: forgot prompt uses the SAME live identity as choose —
          // sewadar row first, directory second, session snapshot only as
          // fallback. A pre-v43 session row has no sewadar_centre/dept
          // snapshot, so displayOf(open) alone blanked name/centre/dept here
          // while choose showed them.
          const dispOpen = displayOf(sewadar || dirFor(b) || open)
          // Pre-fill in IST, clamped into the window scan_out actually accepts.
          // `getHours()` read the DEVICE's zone, so any scanner not set to IST
          // pre-filled a time off by its own UTC offset; and a device whose
          // clock runs fast pre-filled a FUTURE out_time, writing a session
          // that can never be closed and dooming the follow-up re-IN (v46
          // raises 'Timestamp cannot be in the future' at scan_in).
          const forgot = resolveForgotOutTime({ inDate: open.in_date, inTime: open.in_time })
          showPopup({
            status: 'forgot', badge: b, name: dispOpen.name, centre: dispOpen.centre,
            openSince: `${open.in_date} ${open.in_time}`, openId: open.id,
            in_date: open.in_date, in_time: open.in_time,
            deptName: dispOpen.deptName,
          })
          return { outTimeDefault: forgot.value, ok: true }
        }

        // ── Explicit choice ────────────────────────────────────────
        // No auto-OUT: show the sewadar's details with the single valid
        // action. Tapping Mark OUT commits via the pinned-session fast-path
        // above; Cancel writes nothing. (>12h already became the forgot-OUT
        // prompt above.)
        if (!isConfirmed('OUT')) {
          // v65: identity prefers the LIVE sewadar row over the session's
          // snapshot — same source the IN-side prompt uses, so both directions
          // name the sewadar identically. The mobile directory sits between
          // (live || directory || session): cached identity fills offline and
          // stale gaps while live data always wins. `|| open` keeps this
          // working before v65 is applied (no `sewadar` key), where the open
          // session row is the only identity available.
          const dispChoose = displayOf(sewadar || dirFor(b) || open)
          showPopup({
            status: 'choose', action: 'OUT', badge: b,
            name: dispChoose.name, centre: dispChoose.centre, deptName: dispChoose.deptName,
            openId: open.id, openSince: `${open.in_date} ${open.in_time}`, manual,
            time: new Date().toLocaleTimeString(),
            ...eventStamp(),
          })
          return { ok: false, reason: 'confirm_required', action: 'OUT' }
        }
        // Confirmed OUT always returns via the fast-path above; reaching here
        // means a caller bug — re-ask rather than writing blind.
        showPopup({ status: 'error', badge: b, message: 'Session lookup timed out — nothing was changed. Please retry the scan.', time: new Date().toLocaleTimeString() })
        return { ok: false, reason: 'session_lookup_timeout' }
      } else {
        // ── Explicit choice ────────────────────────────────────────
        // No auto-IN: show the sewadar's details (from their last OUT when
        // known — null-safe for a first-ever scan) with the single valid
        // action. Tapping Mark IN commits below; Cancel writes nothing.
        if (!isConfirmed('IN')) {
          // THE BUG THIS FIXES: this used to be `displayOf(lastOut)`, so a
          // badge that had never scanned OUT in this schedule — i.e. every
          // first scan of a visit — resolved identity from a null payload and
          // the popup showed a badge number and a clock and nothing else.
          // v65's `sewadar` key answers from the source tables instead;
          // the mobile directory answers when neither lookup ran (offline)
          // or the server predates v65; `|| lastOut` preserves the old source
          // when it is missing (pre-v65 function) or when the badge is
          // unknown to both (all fields null, which the popup simply does
          // not render).
          const dispChoose = displayOf(sewadar || dirFor(b) || lastOut)
          showPopup({
            status: 'choose', action: 'IN', badge: b,
            name: dispChoose.name, centre: dispChoose.centre, deptName: dispChoose.deptName,
            manual, time: new Date().toLocaleTimeString(),
            ...eventStamp(),
          })
          return { ok: false, reason: 'confirm_required', action: 'IN' }
        }

        // ── IN flow (committed via the choice above) ───────────────
        const ts = new Date().toISOString()
        try {
          const { data, error } = await withTimeout(
            // M3: manual-entry scans carry p_is_manual so the audit trail can
            // tell a hand-typed correction from a camera scan (server stores
            // it in dp_attendance_sessions.is_manual; Scanner Ops reports it).
            supabase.rpc('scan_in', { p_badge: b, p_schedule: scheduleId, p_ts: ts, p_centre: profile?.centre, p_nonce: nonce, p_is_manual: manual }),
            SCAN_RPC_TIMEOUT,
            'Scan IN'
          )
          if (error) throw error
          // The v43 scan_in jsonb carries sewadar_name / sewadar_centre /
          // dept_name. Pre-v43 (or a v43 whose joins found nothing) these
          // resolve to null and the popup simply shows fewer fields.
          const dispIn = displayOf(data)
          const flag = data?.undeployed ? ' Flagged: not deployed' : ''
          showPopup({
            status: data?.undeployed ? 'flagged' : 'in',
            badge: b, name: dispIn.name, centre: dispIn.centre, deptName: dispIn.deptName,
            time: new Date().toLocaleTimeString(),
            ...eventStamp(),
            flag: data?.undeployed ? `Not deployed to ${deptName || 'your dept'} — flagged` : null,
            message: `IN marked${flag}`,
          })
          toast[data?.undeployed ? 'warning' : 'success'](`IN ${b}${flag}`)
          scanOk = true
        } catch (e) {
          const msg = String(e.message || '')
          if (msg.includes('Already IN')) {
            // Re-fetch to get the open session for the forgot-out flow. The
            // error field is captured, not dropped: a PGRST202 / permission
            // failure is NOT the same as "no open session" (D-2), and neither
            // is a timeout (D-1).
            const fresh = await lookupScanState(b, scheduleId)
            if (fresh.kind === 'ok' && fresh.open) {
              // L-39: the forgot prompt (with its ">12h open" pill and the
              // destructive "Close OUT then IN") is only honest past 12h — the
              // primary path gates it at hrs > 12, and this refetch must too.
              // A young session gets the plain Already-IN error instead.
              const freshInTs = new Date(`${fresh.open.in_date}T${fresh.open.in_time}+05:30`).getTime()
              if ((Date.now() - freshInTs) / 3600000 > 12) {
                // Same live-identity preference as the primary forgot path above.
                const dispFresh = displayOf(fresh.sewadar || dirFor(b) || fresh.open)
                const forgot = resolveForgotOutTime({ inDate: fresh.open.in_date, inTime: fresh.open.in_time })
                showPopup({
                  status: 'forgot', badge: b, name: dispFresh.name, centre: dispFresh.centre, deptName: dispFresh.deptName,
                  openSince: `${fresh.open.in_date} ${fresh.open.in_time}`, openId: fresh.open.id,
                  in_date: fresh.open.in_date, in_time: fresh.open.in_time,
                })
                return { outTimeDefault: forgot.value, ok: true }
              }
              showPopup({ status: 'error', badge: b, message: 'Already checked IN — please OUT first', time: new Date().toLocaleTimeString() })
              toast.error('Already IN — OUT first')
              return { ok: false, reason: 'already_in' }
            }
            // The sewadar IS checked in, but we could not read the session:
            // say which failure it was instead of a bare dead end, so the
            // operator knows to retry rather than hunt for a missing OUT.
            if (fresh.kind === 'timeout') {
              showPopup({ status: 'error', badge: b, message: 'Already checked IN, but the session lookup timed out — please retry the scan.', time: new Date().toLocaleTimeString() })
              toast.error('Already IN — session lookup timed out, retry')
              return { ok: false, reason: 'session_lookup_timeout' }
            }
            if (fresh.kind === 'error') {
              const emsg = friendly(String(fresh.error?.message || ''))
              showPopup({ status: 'error', badge: b, message: `Already checked IN, but the session lookup failed: ${emsg}`, time: new Date().toLocaleTimeString() })
              toast.error(`Already IN — ${emsg}`)
              return { ok: false, reason: 'session_lookup_failed' }
            }
            // Genuine null: the session closed between the two lookups, so the
            // original 'Already IN' is still the honest message. But the same
            // shape is produced by a stale server scan_in (pre-v56 `IF FOUND`
            // raises Already IN with no open session at all, for EVERY badge)
            // — so point the operator at the one action that fixes that case.
            showPopup({ status: 'error', badge: b, message: 'Already checked IN — please OUT first. If this repeats for every badge, ask the ASO to apply the pending database migrations.', time: new Date().toLocaleTimeString() })
            toast.error('Already IN — OUT first')
          } else if (isOfflineLike(msg)) {
            if (isOfflineDupe(b, 'IN')) {
              toast.warning('Already queued — ignoring duplicate scan')
              return { ok: false, reason: 'duplicate_queued' }
            }
            // C6: flag the row uncertain when this device holds no pending
            // local IN for the badge+schedule — the lookup failed, so server
            // state is unknown and a second scan of the same badge may be the
            // OUT. At drain, an uncertain IN answered 'Already IN' attempts
            // the OUT flow instead of being silently dropped.
            let uncertainIn = false
            try {
              const queued = await getQueuedScans()
              uncertainIn = !(queued || []).some(q =>
                q && q.synced !== true && q.failed !== true && q.status !== 'failed'
                && q.action === 'IN' && q.badge === b && q.schedule_id === scheduleId)
            } catch { uncertainIn = false }
            const queuedRes = await tryEnqueue({ badge: b, schedule_id: scheduleId, action: 'IN', ts, centre: profile?.centre, dept: deptName, id: nonce, is_manual: manual, ...(uncertainIn ? { uncertain: true } : {}) })
            if (!queuedRes.ok) return offlineEnqueueFailed(queuedRes, b)
            noteQueuedOffline(b, 'IN')
            // Same identity carry as the OUT ack above (confirmed display
            // first, directory fallback) — the IN choice named the sewadar.
            const dirQI = displayOf(dirFor(b))
            showPopup({ status: 'queued', action: 'IN', badge: b, name: display?.name ?? dirQI.name, centre: display?.centre ?? dirQI.centre, deptName: display?.deptName ?? dirQI.deptName, time: new Date().toLocaleTimeString(), ...eventStamp(), message: 'Queued offline — will sync when online' })
            toast.success(`IN queued (offline) ${b}`)
            scanOk = true
            onQueued?.()
          } else if (isClockSkewed(msg, ts)) {
            // V14: device clock vs server clock — warn instead of the raw
            // 'Timestamp …' text. Warn-only: ts is sent unchanged.
            showPopup({ status: 'error', badge: b, message: CLOCK_SKEW_MESSAGE, time: new Date().toLocaleTimeString() })
            toast.warning(CLOCK_SKEW_MESSAGE)
          } else {
            showPopup({ status: 'error', badge: b, message: friendly(msg), time: new Date().toLocaleTimeString() })
            toast.error(friendly(msg))
          }
        }
      }
      onAfterScan?.()
      return { ok: scanOk }
    } finally {
      resetBusy()
    }
  }, [scheduleId, profile, deptName, displayOf, dirFor, showPopup, toast, onQueued, onAfterScan, setBusySafe, resetBusy, offlineEnqueueFailed, isOfflineDupe, noteQueuedOffline, tryEnqueue])

  return { handleScan, busy, getBusy, resetBusy, submitForgotOut }
}
