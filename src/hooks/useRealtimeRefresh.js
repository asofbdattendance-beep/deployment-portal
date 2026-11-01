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
 * @param {number} [cfg.minIntervalMs=0]  floor: never fire more often than this
 *   (0 disables). Use to keep a burst from hammering the DB every 2s.
 */
// Per-subscribe topic suffix. realtime-js `channel(topic)` RETURNS the
// existing channel when one with that topic is still in the socket's list —
// and a channel we just removed stays there (state `leaving`) until the
// server acks the leave. Re-subscribing the same name inside that window
// (schedule A→B→A, page away-and-back, StrictMode remount) got the dying
// channel back: `.subscribe()` is a no-op on a non-closed channel, the leave
// ack then closes it, and live updates were silently OFF until a reload.
let topicSeq = 0

export function useRealtimeRefresh({
  scheduleId,
  channelName,
  subscriptions = [],
  onReload,
  label,
  debounceMs = 400,
  maxWaitMs = 2000,
  minIntervalMs = 0,
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
    // In-flight guard: on a weak network one reload can outlast maxWaitMs,
    // and every further event used to start ANOTHER full reload on top of
    // it — requests stacked faster than they completed (refetch storm).
    // While one is running, later events only mark it dirty; ONE follow-up
    // runs after it settles, so the newest change is still picked up.
    let inFlight = false
    let dirty = false
    const fire = () => {
      if (!alive) return
      if (inFlight) { dirty = true; return }
      inFlight = true
      lastReloadAt.current = Date.now()
      Promise.resolve()
        .then(() => reloadRef.current?.())
        .catch(() => {})
        .finally(() => {
          inFlight = false
          if (alive && dirty) { dirty = false; reload() }
        })
    }
    const reload = () => {
      if (!alive) return
      const viewerRun = perfStart('viewer')
      perfMark('viewer', viewerRun, 'rt-event')
      const now = Date.now()
      const since = now - lastReloadAt.current
      // Floor: during a burst, never fire more often than minIntervalMs.
      // Defer instead of dropping, so the latest change still lands.
      if (minIntervalMs > 0 && since < minIntervalMs) {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = null
          if (!alive) return
          perfMark('viewer', viewerRun, 'reload-fired:min-interval')
          fire()
        }, minIntervalMs - since)
        return
      }
      // Max-wait: the trailing debounce coalesces bursts, but a sustained
      // burst would re-arm it forever and starve the reload. Fire immediately
      // when the last actual load is more than maxWaitMs old.
      if (since > maxWaitMs) {
        if (timer) clearTimeout(timer)
        timer = null
        perfMark('viewer', viewerRun, 'reload-fired:max-wait')
        fire()
        return
      }
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        if (!alive) return
        perfMark('viewer', viewerRun, 'reload-fired:debounced')
        fire()
      }, debounceMs)
    }
    topicSeq += 1
    let channel = supabase.channel(`${channelName}-${topicSeq}`)
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
  }, [scheduleId, channelName, label, debounceMs, maxWaitMs, minIntervalMs])
}
