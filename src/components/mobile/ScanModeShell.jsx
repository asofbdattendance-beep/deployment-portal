import { useEffect, useRef } from 'react'
import { requestWakeLock, releaseWakeLock, safeBottom } from '../../lib/mobile'

/**
 * ScanModeShell — immersive full-screen capture layout for phones.
 * Rendered ONLY when useIsMobile() (the scanner pages keep their desktop
 * cards at ≥769px). The scan STATE MACHINE is untouched: pages pass their
 * existing camera / action / manual / feed / popup nodes as slots, so this
 * is pure chrome — safe-area, dynamic viewport, wake lock.
 *
 * - 100dvh column: header, camera, big action, manual entry, feed.
 * - Keeps the screen awake while mounted (Wake Lock, re-acquired on
 *   visibilitychange since the lock releases when the tab hides).
 * - Feed region scrolls internally; the page behind does not double-scroll.
 */
export default function ScanModeShell({
  title,
  pills,
  camera,
  action,
  manual,
  queueBar,
  feedTitle,
  feed,
  popup,
}) {
  const lockRef = useRef(null)

  useEffect(() => {
    let alive = true
    const acquire = async () => {
      const s = await requestWakeLock()
      if (alive) lockRef.current = s
      else if (s) releaseWakeLock(s)
    }
    const onVis = () => {
      if (document.visibilityState === 'visible') acquire()
    }
    acquire()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', onVis)
      if (lockRef.current) { releaseWakeLock(lockRef.current); lockRef.current = null }
    }
  }, [])

  return (
    <div className="scan-shell" style={{ paddingBottom: safeBottom('0.4rem') }}>
      <div className="scan-shell-head">
        <h2 className="page-title scan-shell-title">{title}</h2>
        {pills && <div className="scan-shell-pills">{pills}</div>}
      </div>
      {camera && <div className="scan-shell-camera">{camera}</div>}
      {action && <div className="scan-shell-action">{action}</div>}
      {manual && <div className="scan-shell-manual">{manual}</div>}
      {(queueBar || feedTitle || feed) && (
        <div className="scan-shell-feed">
          {feedTitle && <div className="scan-shell-feed-title">{feedTitle}</div>}
          {queueBar}
          {feed}
        </div>
      )}
      {popup}
    </div>
  )
}
