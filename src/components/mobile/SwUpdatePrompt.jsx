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
const hardReload = () => window.location.reload()

export default function SwUpdatePrompt({ reloadPage = hardReload } = {}) {
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
        const sw = navigator.serviceWorker
        // Reload once the NEW worker controls the page. A fixed 400ms beat
        // raced activation: on a slow phone (worker cold-started to receive
        // the message) the reload was served by the OLD worker's index.html,
        // then the new worker activated and purged the old precache — the
        // page ran the old build with its lazy chunks (Scanner, ZXing) gone.
        let done = false
        const go = () => { if (done) return; done = true; reloadPage() }
        if (typeof sw.addEventListener === 'function') sw.addEventListener('controllerchange', go)
        sw.getRegistration().then((reg) => {
          if (reg && reg.waiting) {
            reg.waiting.postMessage({ type: 'SKIP_WAITING' })
            // Fallback if controllerchange never fires (engine quirk).
            setTimeout(go, 4000)
          } else {
            go()
          }
        }).catch(go)
        return
      }
    } catch { /* ignore */ }
    reloadPage()
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
