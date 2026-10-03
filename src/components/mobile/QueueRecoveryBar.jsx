import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, Wifi, WifiOff } from 'lucide-react'
import {
  clearFailedQueue,
  clearLiveQueue,
  clearOrphanedQueue,
  listStrandedQueue,
  removeQueued,
  isFailedQueueRow,
  isOrphanedQueueRow,
} from '../../lib/offlineQueue'

/**
 * QueueRecoveryBar — the ONE surface for offline-queue state + recovery.
 *
 * Every scanner role gets the same counts and the same ways out of a bad
 * queue. Previously ScannerPage had all four recoveries (failed / live /
 * orphaned / stranded) and InchargeScannerPage had NONE beyond a pending
 * count — a dept_incharge could see "N queued" with no way to clear it.
 *
 * Live rows are only ever cleared for the CURRENT owner, and only behind an
 * explicit confirm: they have not synced, so deleting them drops real scans.
 * Stranded rows are never auto-drained or auto-deleted (cross-user safety).
 *
 * Props: queued (rows), syncing, isOnline, offline (stale-data flag).
 * Renders null when there is nothing queued and nothing stranded, so it is
 * safe to mount unconditionally.
 */
export default function QueueRecoveryBar({ queued = [], syncing = false, isOnline = true, offline = false }) {
  const [refreshQueue, setRefreshQueue] = useState(0)
  const [stranded, setStranded] = useState([])

  const refreshStranded = useCallback(async () => {
    try { setStranded(await listStrandedQueue() || []) }
    catch (e) { console.warn('[queue] stranded refresh failed:', e?.message) }
  }, [])

  useEffect(() => { refreshStranded() }, [refreshStranded, refreshQueue])
  useEffect(() => {
    const id = setInterval(() => refreshStranded(), 30000)
    return () => clearInterval(id)
  }, [refreshStranded])

  const rows = Array.isArray(queued) ? queued : []
  // Pending EXCLUDES failed and orphaned/stranded rows — they are surfaced
  // separately rather than inflating the sync pill.
  const pendingCount = rows.filter((q) => !q.synced && !isFailedQueueRow(q) && !isOrphanedQueueRow(q)).length
  const failedCount = rows.filter(isFailedQueueRow).length
  const orphanedCount = rows.filter(isOrphanedQueueRow).length

  const clearFailed = useCallback(async () => {
    await clearFailedQueue(); setRefreshQueue((n) => n + 1)
  }, [])
  const clearOrphaned = useCallback(async () => {
    await clearOrphanedQueue(); setRefreshQueue((n) => n + 1)
  }, [])
  const clearLive = useCallback(async () => {
    if (!window.confirm(
      `Delete ${pendingCount} live queued scan(s)? They have NOT synced — only do this for duplicate or test rows.`,
    )) return
    await clearLiveQueue(); setRefreshQueue((n) => n + 1)
  }, [pendingCount])
  const clearOneStranded = useCallback(async (id) => {
    await removeQueued(id); refreshStranded()
  }, [refreshStranded])

  if (pendingCount === 0 && failedCount === 0 && orphanedCount === 0 && stranded.length === 0) return null

  return (
    <div className="queue-recovery">
      <div className="queue-recovery-pills">
        {pendingCount > 0 && (
          <span className="pill pill-amber queue-pill">
            {syncing ? <RefreshCw size={10} className="spin" aria-hidden="true" /> : <WifiOff size={10} aria-hidden="true" />}
            {pendingCount} queued
          </span>
        )}
        {failedCount > 0 && <span className="pill pill-red queue-pill">{failedCount} failed</span>}
        {orphanedCount > 0 && <span className="pill pill-gray queue-pill">{orphanedCount} orphaned</span>}
        {stranded.length > 0 && <span className="pill pill-red queue-pill">{stranded.length} stranded</span>}
        <span className={`pill ${isOnline ? 'pill-green' : 'pill-red'} queue-pill`}>
          {isOnline ? <Wifi size={10} aria-hidden="true" /> : <WifiOff size={10} aria-hidden="true" />}
          {isOnline ? 'Online' : 'Offline'}
        </span>
        {offline && <span className="queue-stale">· refresh failed — showing last data</span>}
      </div>

      <div className="queue-clear-row">
        {failedCount > 0 && (
          <button type="button" onClick={clearFailed} className="queue-clear-btn queue-danger">
            Clear failed ({failedCount})
          </button>
        )}
        {pendingCount > 0 && (
          <button type="button" onClick={clearLive} className="queue-clear-btn queue-warn">
            Clear live queued ({pendingCount})
          </button>
        )}
        {orphanedCount > 0 && (
          <button type="button" onClick={clearOrphaned} className="queue-clear-btn queue-muted">
            Clear orphaned ({orphanedCount})
          </button>
        )}
      </div>

      {stranded.length > 0 && (
        <div className="queue-stranded">
          <div className="queue-stranded-head">
            Stranded scans ({stranded.length}) — queued with no owner, never auto-sync
          </div>
          {stranded.map((r) => (
            <div key={r.id} className="queue-stranded-row">
              <span>{r.badge || '?'} · {r.action || 'IN'}</span>
              <button type="button" onClick={() => clearOneStranded(r.id)} className="queue-clear-btn queue-danger">
                Clear
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}