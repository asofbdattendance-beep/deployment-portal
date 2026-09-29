/**
 * useScanHandler — shared scan-in/scan-out logic used by both ScannerPage
 * and DeptInchargePage. Eliminates code duplication and ensures consistent
 * timeout, busy-flag safety, and error handling.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { BADGE_REGEX } from '../lib/logic'
import { scanDisplay } from '../lib/scanDisplay'
import { enqueueScan, getQueuedScans } from '../lib/offlineQueue'
import {
  friendly,
  withTimeout,
  SCAN_RPC_TIMEOUT,
  SESSION_RPC_TIMEOUT,
  getBusySafetyTimeout,
  withinToggleGuard,
  minutesSince,
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
  return msg.includes('Failed to fetch') || msg.includes('timed out')
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
 * `get_scan_state` (v44) that keeps a TIMEOUT distinguishable from a genuine
 * "no open session" and from a PostgREST failure — the three states the scan
 * flow reacts to completely differently.
 *
 * One round trip answers both questions the ladder needs: is there an OPEN
 * session, and — when there is not — when did this sewadar last go OUT. The
 * second answer is what the IN-side confirm guard is built on.
 *
 * @returns {Promise<{kind:'ok', open:object|null, lastOut:object|null} | {kind:'timeout', error:Error} | {kind:'error', error:any}>}
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
    return { kind: 'ok', open: row?.open?.id ? row.open : null, lastOut: row?.last_out || null }
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
 * @returns {Promise<{kind:'ok', open:object|null, lastOut:null} | {kind:'timeout', error:Error} | {kind:'error', error:any}>}
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
    return { kind: 'ok', open: row?.id ? row : null, lastOut: null }
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
 * @param {Function} opts.showPopup — (data) => void
 * @param {Function} opts.toast — toast object { success, error, warning }
 * @param {Function} opts.onQueued — called after enqueue (to refresh queue count)
 * @param {Function} opts.onAfterScan — called after scan completes (to refresh sessions)
 * @returns {{ handleScan: (badge: string, opts?: {confirmed?: boolean, confirmFor?: 'OUT'|'IN'|null, openId?: string|null, display?: object|null}) => Promise<{ok: boolean, reason?: string, outTimeDefault?: string}>, busy: boolean, getBusy: () => boolean, resetBusy: () => void }}
 *
 * `handleScan(badge, opts)`:
 *  - `opts.confirmed` + `opts.confirmFor` — the operator pressed Confirm on a
 *    confirm-gate popup. The approval is SCOPED to one direction: `confirmFor:
 *    'OUT'` disarms only the OUT gate, `'IN'` only the IN gate. An approval
 *    whose direction does not match the next entry re-asks instead of writing,
 *    because between the question and the click the sewadar's state can change.
 *    Omitting `confirmFor` disarms nothing (fail-closed).
 *  - `opts.openId` — the exact session a `confirm_out` prompt was raised for.
 *    When set with `confirmed` + `confirmFor: 'OUT'`, `scan_out` is issued
 *    straight against that id with NO re-lookup, so a session closed by another
 *    operator in the meantime surfaces as v41's mismatch/no-session error
 *    instead of silently toggling whatever the sewadar's state has become.
 *  - `opts.display` — the identity already resolved for the prompt, reused to
 *    label the resulting OUT popup without a second lookup.
 *
 * EVERY exit of handleScan resolves to an object carrying a boolean `ok` —
 * callers may destructure the result without a TypeError. `outTimeDefault` is
 * present only on the forgot-OUT prompt, where the scan is not yet written.
 */
export function useScanHandler({ scheduleId, profile, deptName, deptNameById, showPopup, toast, onQueued, onAfterScan }) {
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const safetyTimerRef = useRef(null)

  /**
   * The ONE resolver for popup identity fields. Since v40 a session row's
   * `centre` is a scan VENUE, so `scanDisplay` reads `sewadar_centre` only —
   * routing every sewadar-bearing popup through it means the venue can never
   * be labelled as a sewadar's centre again. Absent keys (a pre-v43 RPC, or a
   * session row without a dept snapshot) resolve to null rather than throwing.
   */
  const displayOf = useCallback(
    (payload) => scanDisplay(payload, deptNameById),
    [deptNameById]
  )

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
    if (busyRef.current) return { ok: false, reason: 'busy' }
    const b = String(badge).trim().toUpperCase()
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
      // ── Confirm fast-path (v44) ──────────────────────────────────
      // The operator pressed Confirm on a `confirm_out` prompt raised against a
      // SPECIFIC session. Act on that id directly and skip the lookup: a re-lookup
      // would read whatever the sewadar's state has become in the meantime, and
      // could mark a fresh IN against a different session. scan_out (v41) already
      // raises on a stale or mismatched p_open_id, so a race surfaces honestly.
      if (isConfirmed('OUT') && openId) {
        const tsFast = new Date().toISOString()
        try {
          const { data: outFastData, error: outFastError } = await withTimeout(
            supabase.rpc('scan_out', { p_badge: b, p_schedule: scheduleId, p_ts: tsFast, p_open_id: openId }),
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
            })
            toast.warning(`OUT already recorded ${b}`)
            scanOk = true
          } else {
          showPopup({
            status: 'out', badge: b,
            name: display?.name ?? null, centre: display?.centre ?? null, deptName: display?.deptName ?? null,
            time: new Date().toLocaleTimeString(), message: 'OUT marked',
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
          if (!navigator.onLine || msg.includes('Failed to fetch') || msg.includes('timed out')) {
            const queued = await enqueueScan({ badge: b, schedule_id: scheduleId, action: 'OUT', ts: tsFast, open_id: openId, centre: profile?.centre })
            if (!queued) {
              showPopup({ status: 'error', badge: b, message: 'Offline storage unavailable — please enter manually when online', time: new Date().toLocaleTimeString() })
              toast.error('Offline storage unavailable')
              return { ok: false, reason: 'offline_storage_unavailable' }
            }
            showPopup({ status: 'queued', badge: b, time: new Date().toLocaleTimeString(), message: 'Queued offline — will sync when online' })
            toast.success(`OUT queued (offline) ${b}`)
            scanOk = true
            onQueued?.()
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
      // errors (D-2).
      const lookup = await lookupScanState(b, scheduleId)
      let open = null
      let lastOut = null
      if (lookup.kind === 'timeout' && navigator.onLine !== false) {
        // UNKNOWN session state while we clearly have a network. Nothing was
        // written — say so, and let the operator retry the same badge.
        showPopup({ status: 'error', badge: b, message: 'Session lookup timed out — nothing was changed. Please retry the scan.', time: new Date().toLocaleTimeString() })
        toast.error('Session lookup timed out — please retry')
        return { ok: false, reason: 'session_lookup_timeout' }
      } else if (lookup.kind === 'error') {
        const e = lookup.error
        if (isNetworkOrTimeoutError(e) && !isAuthError(e)) {
          // Network/timeout only — server state is UNKNOWN, not "no open
          // session". C4: when this device already holds an unsynced IN for
          // the badge, this scan is almost certainly the OUT — queue it as
          // OUT (open_id null: scan_out resolves the open session itself, and
          // the drain replays the earlier IN first by createdAt). Assuming IN
          // here used to orphan the session with a success popup.
          if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            try {
              const queued = await getQueuedScans()
              const pendingIn = (queued || []).some(q =>
                q && q.synced !== true && q.failed !== true && q.status !== 'failed'
                && q.action === 'IN' && q.badge === b && q.schedule_id === scheduleId)
              if (pendingIn) {
                const outId = await enqueueScan({ badge: b, schedule_id: scheduleId, action: 'OUT', ts: new Date().toISOString(), open_id: null, centre: profile?.centre })
                if (outId) {
                  showPopup({ status: 'queued', badge: b, time: new Date().toLocaleTimeString(), message: 'Queued offline — will sync when online' })
                  toast.success(`OUT queued (offline) ${b}`)
                  scanOk = true
                  onQueued?.()
                  onAfterScan?.()
                  return { ok: scanOk }
                }
              }
            } catch { /* queue unreadable — fall through to the IN path below */ }
          }
          // Network/timeout only — treat as "no open session", try scan_in
          console.warn('[Scanner] get_scan_state failed, proceeding with scan_in:', e.message)
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
      }
      // `out_date` + `out_time` are bare columns, so the client owns the
      // +05:30 conversion — exactly as the IN branch already does. NaN when the
      // sewadar has never been scanned, or under the pre-v44 fallback; the guard
      // treats NaN as "not guarded" so a first-ever scan is never prompted.
      const lastOutTs = lastOut?.out_date && lastOut?.out_time
        ? Date.parse(`${lastOut.out_date}T${lastOut.out_time}+05:30`)
        : NaN

      if (open) {
        // ── OUT flow ──────────────────────────────────────────────
        const inTs = new Date(`${open.in_date}T${open.in_time}+05:30`).getTime()
        const hrs = (Date.now() - inTs) / 3600000
        if (hrs > 12) {
          const dispOpen = displayOf(open)
          showPopup({
            status: 'forgot', badge: b, name: dispOpen.name, centre: dispOpen.centre,
            openSince: `${open.in_date} ${open.in_time}`, openId: open.id, in_date: open.in_date,
            deptName: dispOpen.deptName,
          })
          // Pre-fill with current time (HH:MM IST)
          const now = new Date()
          const hh = String(now.getHours()).padStart(2, '0')
          const mm = String(now.getMinutes()).padStart(2, '0')
          return { outTimeDefault: `${hh}:${mm}`, ok: true }
        }

        // ── v44 confirm gate ───────────────────────────────────────
        // The ladder is right, but an automatic OUT inside 1h of the IN is
        // almost never deliberate: a double tap, a badge left in front of the
        // lens, a re-scan to "check". It would write a 90-second session and
        // skew the attendance rate. Hold the write and ask; Cancel writes
        // nothing. (>12h already became the forgot-OUT prompt above, so this
        // only ever sees 1h..12h.)
        if (!isConfirmed('OUT') && withinToggleGuard(inTs)) {
          const dispGuard = displayOf(open)
          showPopup({
            status: 'confirm_out', badge: b,
            name: dispGuard.name, centre: dispGuard.centre, deptName: dispGuard.deptName,
            openId: open.id, openSince: `${open.in_date} ${open.in_time}`,
            message: `Only ${minutesSince(inTs)} min since IN at ${String(open.in_time).slice(0, 5)} — mark OUT?`,
          })
          return { ok: false, reason: 'confirm_required', action: 'OUT' }
        }

        const ts = new Date().toISOString()
        try {
          const { error: outError } = await withTimeout(
            supabase.rpc('scan_out', { p_badge: b, p_schedule: scheduleId, p_ts: ts, p_open_id: open.id }),
            SCAN_RPC_TIMEOUT,
            'Scan OUT'
          )
          if (outError) throw outError
          const dispOut = displayOf(open)
          showPopup({ status: 'out', badge: b, name: dispOut.name, centre: dispOut.centre, deptName: dispOut.deptName, time: new Date().toLocaleTimeString(), message: 'OUT marked' })
          toast.success(`OUT ${b}`)
          scanOk = true
        } catch (e) {
          const msg = String(e.message || '')
          if (!navigator.onLine || msg.includes('Failed to fetch') || msg.includes('timed out')) {
            const queued = await enqueueScan({ badge: b, schedule_id: scheduleId, action: 'OUT', ts, open_id: open.id, centre: profile?.centre })
            if (!queued) {
              showPopup({ status: 'error', badge: b, message: 'Offline storage unavailable — please enter manually when online', time: new Date().toLocaleTimeString() })
              toast.error('Offline storage unavailable')
              return { ok: false, reason: 'offline_storage_unavailable' }
            }
            showPopup({ status: 'queued', badge: b, time: new Date().toLocaleTimeString(), message: 'Queued offline — will sync when online' })
            toast.success(`OUT queued (offline) ${b}`)
            scanOk = true
            onQueued?.()
          } else {
            showPopup({ status: 'error', badge: b, message: friendly(msg), time: new Date().toLocaleTimeString() })
            toast.error(friendly(msg))
          }
        }
      } else {
        // ── v44 confirm gate (mirror) ──────────────────────────────
        // A re-IN inside 1h of the last OUT is exactly as likely to be a double
        // tap as the reverse. lastOutTs is NaN when the sewadar has never been
        // scanned (or under the pre-v44 fallback), and withinToggleGuard(NaN)
        // is false — so a sewadar's first ever scan is never prompted, and a
        // re-scan days later is never prompted either.
        if (!isConfirmed('IN') && withinToggleGuard(lastOutTs)) {
          const dispGuard = displayOf(lastOut)
          showPopup({
            status: 'confirm_in', badge: b,
            name: dispGuard.name, centre: dispGuard.centre, deptName: dispGuard.deptName,
            message: `Only ${minutesSince(lastOutTs)} min since OUT at ${String(lastOut.out_time).slice(0, 5)} — mark IN?`,
          })
          return { ok: false, reason: 'confirm_required', action: 'IN' }
        }

        // ── IN flow ───────────────────────────────────────────────
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
              const dispFresh = displayOf(fresh.open)
              showPopup({
                status: 'forgot', badge: b, name: dispFresh.name, centre: dispFresh.centre, deptName: dispFresh.deptName,
                openSince: `${fresh.open.in_date} ${fresh.open.in_time}`, openId: fresh.open.id, in_date: fresh.open.in_date,
              })
              const now = new Date()
              const hh = String(now.getHours()).padStart(2, '0')
              const mm = String(now.getMinutes()).padStart(2, '0')
              return { outTimeDefault: `${hh}:${mm}`, ok: true }
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
            // original 'Already IN' is still the honest message.
            showPopup({ status: 'error', badge: b, message: 'Already checked IN — please OUT first', time: new Date().toLocaleTimeString() })
            toast.error('Already IN — OUT first')
          } else if (!navigator.onLine || msg.includes('Failed to fetch') || msg.includes('timed out')) {
            const queued = await enqueueScan({ badge: b, schedule_id: scheduleId, action: 'IN', ts, centre: profile?.centre, dept: deptName, id: nonce, is_manual: manual })
            if (!queued) {
              showPopup({ status: 'error', badge: b, message: 'Offline storage unavailable — please enter manually when online', time: new Date().toLocaleTimeString() })
              toast.error('Offline storage unavailable')
              return { ok: false, reason: 'offline_storage_unavailable' }
            }
            showPopup({ status: 'queued', badge: b, time: new Date().toLocaleTimeString(), message: 'Queued offline — will sync when online' })
            toast.success(`IN queued (offline) ${b}`)
            scanOk = true
            onQueued?.()
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
  }, [scheduleId, profile, deptName, displayOf, showPopup, toast, onQueued, onAfterScan, setBusySafe, resetBusy])

  return { handleScan, busy, getBusy, resetBusy }
}
