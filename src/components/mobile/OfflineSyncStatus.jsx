import { useEffect, useState } from 'react'
import { RefreshCw, WifiOff, AlertTriangle } from 'lucide-react'
import { subscribeOfflineSync } from '../../lib/offlineSync'
import { isFailedQueueRow, isOrphanedQueueRow } from '../../lib/offlineQueue'

/**
 * OfflineSyncStatus — the ONE global queue surface outside the scanner pages.
 *
 * QueueRecoveryBar lives on the scanner pages only; an operator who queues
 * scans offline and then opens Dashboard/Reports had zero visibility into a
 * stuck or failed queue. This pill mounts once in main.jsx, subscribes to
 * the app-level sync engine, and shows pending/failed counts on EVERY page.
 * It never offers recovery actions — those stay on the QueueRecoveryBar
 * (confirm-gated deletes must not be one tap away everywhere).
 *
 * Counting matches QueueRecoveryBar exactly: pending EXCLUDES failed and
 * orphaned (null-owner) rows — a logged-out snapshot can only ever contain
 * null-owner rows, which can never drain, so they must not paint a
 * permanent "syncing" spinner. The live region wrapper always mounts so
 * screen readers announce pills when they appear.
 */
export default function OfflineSyncStatus() {
  const [queued, setQueued] = useState([])
  const [syncing, setSyncing] = useState(false)

  useEffect(() => subscribeOfflineSync(({ queued: rows } = {}) => {
    const arr = Array.isArray(rows) ? rows : []
    setQueued(arr)
    setSyncing(arr.some((q) => !q.synced && !isFailedQueueRow(q) && !isOrphanedQueueRow(q)))
  }), [])

  const rows = Array.isArray(queued) ? queued : []
  const pending = rows.filter((q) => !q.synced && !isFailedQueueRow(q) && !isOrphanedQueueRow(q)).length
  const failed = rows.filter(isFailedQueueRow).length

  return (
    <div className="queue-recovery" role="status" aria-live="polite">
      {(pending > 0 || failed > 0) && (
        <div className="queue-recovery-pills">
          {pending > 0 && (
            <span className="pill pill-amber queue-pill">
              {syncing
                ? <RefreshCw size={10} className="spin" aria-hidden="true" />
                : <WifiOff size={10} aria-hidden="true" />}
              {pending} queued{syncing ? ' · syncing' : ''}
            </span>
          )}
          {failed > 0 && (
            <span className="pill pill-red queue-pill">
              <AlertTriangle size={10} aria-hidden="true" />
              {failed} failed — open Scanner to review
            </span>
          )}
        </div>
      )}
    </div>
  )
}
