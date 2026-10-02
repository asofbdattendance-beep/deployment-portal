import { useState, useEffect } from 'react'
import { Download, X, Share } from 'lucide-react'
import { useIsMobile } from '../../hooks/useMediaQuery'
import { isStandalone, safeBottom } from '../../lib/mobile'

const DISMISS_KEY = 'portal_install_dismissed'

function isIos() {
  if (typeof navigator === 'undefined') return false
  try {
    return /iphone|ipad|ipod/i.test(navigator.userAgent || '') ||
      (navigator.platform === 'MacIntel' && Number(navigator.maxTouchPoints || 0) > 1)
  } catch {
    return false
  }
}

/**
 * InstallPrompt — "install this portal as an app" banner for phones.
 *
 * Android/Chrome: captures `beforeinstallprompt` and shows an Install
 * button that fires the deferred prompt on tap (a real user gesture).
 * iOS Safari (no install prompt API): shows a one-line "Share → Add to
 * Home Screen" hint instead. Never shows when already standalone, never
 * on desktop, dismissible (persisted in localStorage).
 */
export default function InstallPrompt() {
  const isMobile = useIsMobile()
  const [deferred, setDeferred] = useState(null)
  const [dismissed, setDismissed] = useState(false)
  const [installed, setInstalled] = useState(false)

  useEffect(() => {
    try {
      if (typeof localStorage !== 'undefined' && localStorage.getItem(DISMISS_KEY) === '1') {
        setDismissed(true)
      }
    } catch { /* ignore */ }
    if (typeof window === 'undefined') return undefined
    const onBip = (e) => {
      try { e.preventDefault() } catch { /* ignore */ }
      setDeferred(e)
    }
    const onInstalled = () => {
      setInstalled(true)
      setDeferred(null)
    }
    window.addEventListener('beforeinstallprompt', onBip)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onBip)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  if (!isMobile || dismissed || installed) return null
  const standalone = (() => {
    try {
      return isStandalone()
    } catch {
      return false
    }
  })()
  if (standalone) return null

  // iOS has no beforeinstallprompt — the Share-sheet hint is the install path.
  if (!deferred && !isIos()) return null

  const dismiss = () => {
    setDismissed(true)
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(DISMISS_KEY, '1')
    } catch { /* ignore */ }
  }
  const install = async () => {
    if (!deferred) return
    try {
      deferred.prompt()
      await deferred.userChoice
    } catch { /* ignore */ }
    setDeferred(null)
  }

  return (
    <div className="install-banner" role="region" aria-label="Install app" style={{ paddingBottom: safeBottom('0.7rem') }}>
      {deferred ? (
        <>
          <Download size={18} aria-hidden="true" />
          <span className="install-text">Install Sewadar Portal as an app for faster scanning.</span>
          <button type="button" onClick={install} className="btn btn-primary install-btn">Install</button>
        </>
      ) : (
        <>
          <Share size={18} aria-hidden="true" />
          <span className="install-text">Add to Home Screen from the Share menu to use this as an app.</span>
        </>
      )}
      <button type="button" onClick={dismiss} className="install-dismiss" aria-label="Dismiss install prompt">
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  )
}
