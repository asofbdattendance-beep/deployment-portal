import { useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { reportRealtimeStatus } from '../lib/realtime'
import { perfStart, perfMark } from '../lib/perfTimings'

/**
 * useRealtimeRefresh — the one realtime subscribe pattern every live page shares.
 *
 * Extracted verbatim from AttendancePage's scan-landing effect: a burst of
 * postgres_changes coalesces into ONE reload via a trailing debounce, and a
 * max-wait guarantees a sustained burst can never starve the reload forever.
 * Teardown (unmount / schedule switch) is silent by design — `alive = false`
 * reaches the subscribe callback before removeChannel fires CLOSED, so
 * reportRealtimeStatus stays quiet for the normal case and only warns on
 * genuine CHANNEL_ERROR / TIMED_OUT (see lib/realtime.js).
 *
 * `onReload` and `subscriptions` are read through refs (latest wins) so the
 * channel subscribes ONCE per schedule — an inline subscriptions array must
 * not resubscribe on every render.
 *
 * The hook stamps its own last-fire time (pages historically stamped it at
 * the top of load(); a second stamp there is a harmless no-op).
 *
 * @param {object} cfg
 * @param {string|null} cfg.scheduleId  falsy = do not subscribe
 * @param {string} cfg.channelName       e.g. `attendance-${scheduleId}`
 * @param {Array<{table:string,filter?:string}>} cfg.subscriptions
 * @param {() => Promise<unknown>} cfg.onReload  must never throw (catch inside)
 * @param {string} cfg.label            tag for reportRealtimeStatus console lines
 * @param {number} [cfg.debounceMs=400]
 * @param {number} [cfg.maxWaitMs=2000]
 */
export function useRealtimeRefresh({
  scheduleId,
  channelName,
  subscriptions = [],
  onReload,
  label,
  debounceMs = 400,
  maxWaitMs = 2000,
}) {
  const reloadRef = useRef(onReload)
  reloadRef.current = onReload
  const subsRef = useRef(subscriptions)
  subsRef.current = subscriptions
  const lastReloadAt = useRef(0)

  useEffect(() => {
    if (!scheduleId) return undefined
    let alive = true
    let timer = null
    const reload = () => {
      if (!alive) return
      // Phase-0 tripwire: every postgres_changes event starts a viewer run;
      // pages mark 'rows-painted' when their reload lands (same run id via
      // perfCurrentRun). Paste via __portalPerfDump.
      const viewerRun = perfStart('viewer')
      perfMark('viewer', viewerRun, 'rt-event')
      // Max-wait: the trailing debounce coalesces bursts, but a sustained
      // burst would re-arm it forever and starve the reload. Fire immediately
      // when the last actual load is more than maxWaitMs old.
      if (Date.now() - lastReloadAt.current > maxWaitMs) {
        if (timer) clearTimeout(timer)
        lastReloadAt.current = Date.now()
        perfMark('viewer', viewerRun, 'reload-fired:max-wait')
        if (alive) Promise.resolve().then(() => reloadRef.current?.()).catch(() => {})
        return
      }
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (!alive) return
        lastReloadAt.current = Date.now()
        perfMark('viewer', viewerRun, 'reload-fired:debounced')
        Promise.resolve().then(() => reloadRef.current?.()).catch(() => {})
      }, debounceMs)
    }
    let channel = supabase.channel(channelName)
    for (const sub of subsRef.current || []) {
      channel = channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: sub.table, ...(sub.filter ? { filter: sub.filter } : {}) },
        reload
      )
    }
    channel.subscribe((status) => {
      reportRealtimeStatus(label, status, alive)
    })
    // Parity with the pages this was extracted from: their initial load()
    // stamps the last-fire time at mount, so an event landing mid-first-load
    // debounces instead of firing a second load immediately.
    lastReloadAt.current = Date.now()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      supabase.removeChannel(channel)
    }
  }, [scheduleId, channelName, label, debounceMs, maxWaitMs])
}
