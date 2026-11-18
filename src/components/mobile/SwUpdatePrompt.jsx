import { useState, useEffect, useRef } from 'react'
import { RefreshCw } from 'lucide-react'
import { hasUnsavedWork } from '../../lib/unsavedWork'

/**
 * SwUpdatePrompt — "New version available" banner + auto-apply.
 *
 * main.jsx dispatches `portal-sw-update` when an installed service worker
 * finishes installing while a controller already exists (i.e. this is an
 * UPDATE, not the first install). The update applies itself — no manual
 * reload needed — when the tab is hidden or has had no input for IDLE_MS,
 * and ONLY if hasUnsavedWork() is false (no unsaved/in-flight autosave, no
 * open modal/sheet, no focused or filled form field, no live camera).
 * Otherwise it keeps waiting. Tapping Reload with unsaved work asks the
 * user to save first instead of reloading.
 */
const hardReload = () => window.location.reload()
export const IDLE_MS = 2 * 60 * 1000

export default function SwUpdatePrompt({ reloadPage = hardReload, idleMs = IDLE_MS } = {}) {
  const [waiting, setWaiting] = useState(null)
  const [blocked, setBlocked] = useState(false)
  const appliedRef = useRef(false)

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

  const reload = () => {
    if (appliedRef.current) return
    // SKIP_WAITING purges the old build's files, so never start it while
    // anything is unsaved — a cancelled reload would strand the old page.
    if (hasUnsavedWork()) { setBlocked(true); return }
    appliedRef.current = true
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
  const reloadRef = useRef(reload)
  reloadRef.current = reload

  // Auto-apply: on tab hide, or after idleMs with no user input.
  useEffect(() => {
    if (waiting == null || typeof document === 'undefined') return undefined
    let timer = null
    // auto path: apply only when nothing can be lost, else try again later
    const apply = () => { if (!hasUnsavedWork()) reloadRef.current() }
    const arm = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { apply(); if (!appliedRef.current) arm() }, idleMs)
    }
    const onVis = () => { if (document.hidden) apply() }
    const inputs = ['pointerdown', 'keydown', 'touchstart', 'wheel']
    inputs.forEach(t => window.addEventListener(t, arm, { passive: true }))
    document.addEventListener('visibilitychange', onVis)
    arm()
    return () => {
      if (timer) clearTimeout(timer)
      inputs.forEach(t => window.removeEventListener(t, arm))
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [waiting, idleMs])

  if (waiting == null) return null

  return (
    <div className="sw-update-banner" role="status">
      <RefreshCw size={15} aria-hidden="true" />
      <span className="install-text">{blocked
        ? 'Save or finish your changes first — the new version loads automatically after.'
        : 'A new version is ready — it will load automatically.'}</span>
      <button type="button" onClick={reload} className="btn btn-primary install-btn">
        Reload
      </button>
    </div>
  )
}
