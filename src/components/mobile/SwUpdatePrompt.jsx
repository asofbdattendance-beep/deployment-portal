import { useState, useEffect } from 'react'
import { RefreshCw } from 'lucide-react'

/**
 * SwUpdatePrompt — "New version available" banner.
 *
 * main.jsx dispatches `portal-sw-update` when an installed service worker
 * finishes installing while a controller already exists (i.e. this is an
 * UPDATE, not the first install). Tapping Reload posts SKIP_WAITING to the
 * waiting worker and reloads once it activates — never mid-scan without
 * the user's tap.
 */
export default function SwUpdatePrompt() {
  const [waiting, setWaiting] = useState(null)

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onUpdate = (e) => setWaiting(e?.detail?.registration || true)
    window.addEventListener('portal-sw-update', onUpdate)
    return () => window.removeEventListener('portal-sw-update', onUpdate)
  }, [])

  useEffect(() => {
    if (waiting == null || typeof window === 'undefined' || !('serviceWorker' in navigator)) return undefined
    // If the worker already activated (e.g. event fired before mount),
    // there is nothing to wait for — stay hidden.
    let cancelled = false
    navigator.serviceWorker.getRegistration().then((reg) => {
      if (cancelled) return
      if (reg && !reg.waiting) setWaiting(null)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [waiting])

  if (waiting == null) return null

  const reload = () => {
    try {
      if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistration().then((reg) => {
          if (reg && reg.waiting) {
            reg.waiting.postMessage({ type: 'SKIP_WAITING' })
          }
          // Reload after a beat so the new worker can take control.
          setTimeout(() => window.location.reload(), 400)
        }).catch(() => window.location.reload())
        return
      }
    } catch { /* ignore */ }
    window.location.reload()
  }

  return (
    <div className="sw-update-banner" role="status">
      <RefreshCw size={15} aria-hidden="true" />
      <span className="install-text">A new version is ready.</span>
      <button type="button" onClick={reload} className="btn btn-primary install-btn">
        Reload
      </button>
    </div>
  )
}
