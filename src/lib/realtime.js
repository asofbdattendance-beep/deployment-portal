/**
 * Realtime channel status reporting.
 *
 * WHY THIS EXISTS
 *
 * Every page subscribed like this:
 *
 *   return () => { alive = false; supabase.removeChannel(channel) }
 *   ...
 *   .subscribe((status) => {
 *     if (status !== 'SUBSCRIBED') console.warn(`[x] realtime ${status} …`)
 *   })
 *
 * which warns on EVERY navigation. `removeChannel()` closes the channel, which
 * fires the subscribe callback one last time with status `CLOSED` — and `CLOSED
 * !== 'SUBSCRIBED'`, so the handler reported a failure for what is the normal,
 * expected teardown of a channel that was working. The warning was pure noise
 * and it trained everyone to ignore the console: a genuine `CHANNEL_ERROR` or
 * `TIMED_OUT` was indistinguishable from a page switch.
 *
 * WHAT IS ACTUALLY A PROBLEM
 *
 *   CHANNEL_ERROR — the server refused the join (bad filter, missing
 *                   permission, or the table is not in the `supabase_realtime`
 *                   publication, see sql/v54_realtime_publication.sql).
 *   TIMED_OUT     — the join never completed.
 *   CLOSED        — normal teardown. Silent, by design.
 *
 * A table that is NOT in the realtime publication does NOT produce either of
 * those: the channel joins fine and simply never receives an event. That is the
 * silent case, and it cannot be detected from the client — hence the migration.
 *
 * @param {string} label  short tag used in the console line, e.g. 'attendance'
 * @param {string} status the status supabase-js passed to the subscribe callback
 * @param {boolean} alive false once the effect's cleanup has started
 */
export function reportRealtimeStatus(label, status, alive) {
  // After cleanup we are deliberately closing the channel — CLOSED here is the
  // teardown we just asked for, not a fault.
  if (!alive) return
  if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
    console.warn(`[${label}] realtime ${status} — live updates are OFF, data will be stale until refresh`)
  }
}
