/**
 * useScanHandler — shared scan-in/scan-out logic used by both ScannerPage
 * and DeptInchargePage. Eliminates code duplication and ensures consistent
 * timeout, busy-flag safety, and error handling.
 */
import { useCallback, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { BADGE_REGEX } from '../lib/logic'
import { enqueueScan } from '../lib/offlineQueue'
import {
  friendly,
  withTimeout,
  SCAN_RPC_TIMEOUT,
  SESSION_RPC_TIMEOUT,
  BUSY_SAFETY_TIMEOUT,
} from '../lib/scannerUtils'

/**
 * @param {object} opts
 * @param {string} opts.scheduleId
 * @param {object} opts.profile — { centre }
 * @param {string} opts.deptName — current department name (for DeptInchargePage)
 * @param {Function} opts.showPopup — (data) => void
 * @param {Function} opts.toast — toast object { success, error, warning }
 * @param {Function} opts.onQueued — called after enqueue (to refresh queue count)
 * @param {Function} opts.onAfterScan — called after scan completes (to refresh sessions)
 * @returns {{ handleScan: (badge: string) => Promise<void>, busy: boolean, resetBusy: () => void }}
 */
export function useScanHandler({ scheduleId, profile, deptName, showPopup, toast, onQueued, onAfterScan }) {
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const safetyTimerRef = useRef(null)

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
    }, BUSY_SAFETY_TIMEOUT)
  }, [])

  const handleScan = useCallback(async (badge) => {
    if (busyRef.current) return
    const b = String(badge).trim().toUpperCase()
    if (!b) return
    if (!BADGE_REGEX.test(b)) {
      showPopup({ status: 'error', badge: b, message: 'Invalid badge format — check FB/BH/VS', time: new Date().toLocaleTimeString() })
      return
    }

    setBusySafe()
    try {
      // Step 1: check for existing open session (with timeout)
      let open = null
      try {
        const { data: openData, error: sessionErr } = await withTimeout(
          supabase.rpc('get_open_session', { p_badge: b, p_schedule: scheduleId }),
          SESSION_RPC_TIMEOUT,
          'Session lookup'
        )
        if (sessionErr) throw sessionErr
        open = openData
      } catch (e) {
        // If session lookup fails, treat as "no open session" — try scan_in
        console.warn('[Scanner] get_open_session failed, proceeding with scan_in:', e.message)
      }

      if (open) {
        // ── OUT flow ──────────────────────────────────────────────
        const inTs = new Date(`${open.in_date}T${open.in_time}+05:30`).getTime()
        const hrs = (Date.now() - inTs) / 3600000
        if (hrs > 12) {
          showPopup({
            status: 'forgot', badge: b, name: open.sewadar_name, centre: open.centre,
            openSince: `${open.in_date} ${open.in_time}`, openId: open.id, in_date: open.in_date,
            deptName,
          })
          // Pre-fill with current time (HH:MM IST)
          const now = new Date()
          const hh = String(now.getHours()).padStart(2, '0')
          const mm = String(now.getMinutes()).padStart(2, '0')
          return { outTimeDefault: `${hh}:${mm}` }
        }

        const ts = new Date().toISOString()
        try {
          const { error: outError } = await withTimeout(
            supabase.rpc('scan_out', { p_badge: b, p_schedule: scheduleId, p_ts: ts, p_open_id: open.id }),
            SCAN_RPC_TIMEOUT,
            'Scan OUT'
          )
          if (outError) throw outError
          showPopup({ status: 'out', badge: b, name: open.sewadar_name, centre: open.centre, deptName, time: new Date().toLocaleTimeString(), message: 'OUT marked' })
          toast.success(`OUT ${b}`)
        } catch (e) {
          const msg = String(e.message || '')
          if (!navigator.onLine || msg.includes('Failed to fetch') || msg.includes('timed out')) {
            const queued = await enqueueScan({ badge: b, schedule_id: scheduleId, action: 'OUT', ts, open_id: open.id, centre: profile?.centre })
            if (!queued) {
              showPopup({ status: 'error', badge: b, message: 'Offline storage unavailable — please enter manually when online', time: new Date().toLocaleTimeString() })
              toast.error('Offline storage unavailable')
              return
            }
            showPopup({ status: 'queued', badge: b, time: new Date().toLocaleTimeString(), message: 'Queued offline — will sync when online' })
            toast.success(`OUT queued (offline) ${b}`)
            onQueued?.()
          } else {
            showPopup({ status: 'error', badge: b, message: friendly(msg), time: new Date().toLocaleTimeString() })
            toast.error(friendly(msg))
          }
        }
      } else {
        // ── IN flow ───────────────────────────────────────────────
        const ts = new Date().toISOString()
        try {
          const { data, error } = await withTimeout(
            supabase.rpc('scan_in', { p_badge: b, p_schedule: scheduleId, p_ts: ts, p_centre: profile?.centre }),
            SCAN_RPC_TIMEOUT,
            'Scan IN'
          )
          if (error) throw error
          const flag = data?.undeployed ? ' Flagged: not deployed' : ''
          showPopup({
            status: data?.undeployed ? 'flagged' : 'in',
            badge: b, deptName, time: new Date().toLocaleTimeString(),
            flag: data?.undeployed ? `Not deployed to ${deptName || 'your dept'} — flagged` : null,
            message: `IN marked${flag}`,
          })
          toast[data?.undeployed ? 'warning' : 'success'](`IN ${b}${flag}`)
        } catch (e) {
          const msg = String(e.message || '')
          if (msg.includes('Already IN')) {
            // Re-fetch to get the open session for the forgot-out flow
            try {
              const fresh = await withTimeout(
                supabase.rpc('get_open_session', { p_badge: b, p_schedule: scheduleId }).then(r => r.data),
                SESSION_RPC_TIMEOUT,
                'Session lookup'
              )
              if (fresh) {
                showPopup({
                  status: 'forgot', badge: b, name: fresh.sewadar_name, centre: fresh.centre, deptName,
                  openSince: `${fresh.in_date} ${fresh.in_time}`, openId: fresh.id, in_date: fresh.in_date,
                })
                const now = new Date()
                const hh = String(now.getHours()).padStart(2, '0')
                const mm = String(now.getMinutes()).padStart(2, '0')
                return { outTimeDefault: `${hh}:${mm}` }
              }
            } catch { /* fall through to error popup */ }
            showPopup({ status: 'error', badge: b, message: 'Already checked IN — please OUT first', time: new Date().toLocaleTimeString() })
            toast.error('Already IN — OUT first')
          } else if (!navigator.onLine || msg.includes('Failed to fetch') || msg.includes('timed out')) {
            const queued = await enqueueScan({ badge: b, schedule_id: scheduleId, action: 'IN', ts, centre: profile?.centre, dept: deptName })
            if (!queued) {
              showPopup({ status: 'error', badge: b, message: 'Offline storage unavailable — please enter manually when online', time: new Date().toLocaleTimeString() })
              toast.error('Offline storage unavailable')
              return
            }
            showPopup({ status: 'queued', badge: b, time: new Date().toLocaleTimeString(), message: 'Queued offline — will sync when online' })
            toast.success(`IN queued (offline) ${b}`)
            onQueued?.()
          } else {
            showPopup({ status: 'error', badge: b, message: friendly(msg), time: new Date().toLocaleTimeString() })
            toast.error(friendly(msg))
          }
        }
      }
      onAfterScan?.()
    } finally {
      resetBusy()
    }
  }, [scheduleId, profile, deptName, showPopup, toast, onQueued, onAfterScan, setBusySafe, resetBusy])

  return { handleScan, busy, getBusy, resetBusy }
}
