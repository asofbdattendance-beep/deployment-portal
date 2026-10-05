import React from 'react'
import ReactDOM from 'react-dom/client'
import { PortalAuthProvider } from './context/PortalAuthContext'
import { ToastProvider } from './components/Toast'
import ErrorBoundary from './components/ErrorBoundary'
import App from './App'
// App-wide status banners: mounted OUTSIDE the authenticated shell so "you
// are offline" also shows on the login screen and on the profile-load
// failure screen — exactly when a phone user most needs to know.
import OfflineBanner from './components/mobile/OfflineBanner'
import OfflineSyncStatus from './components/mobile/OfflineSyncStatus'
import InstallPrompt from './components/mobile/InstallPrompt'
import SwUpdatePrompt from './components/mobile/SwUpdatePrompt'
import { installOfflineSync } from './lib/offlineSync'
import { perfDump } from './lib/perfTimings'
import './index.css'

// Phase-0 latency capture: console `window.__portalPerfDump()` after a slow
// login/scan and paste the output. See src/lib/perfTimings.js for procedure.
try {
  window.__portalPerfDump = () => {
    const out = perfDump()
    console.info('[perf] dump:\n' + out)
    return out
  }
} catch { /* non-browser boot (tests) — skip the console hook */ }

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <PortalAuthProvider>
        <ToastProvider>
          <OfflineBanner />
          <OfflineSyncStatus />
          <InstallPrompt />
          <SwUpdatePrompt />
          <App />
        </ToastProvider>
      </PortalAuthProvider>
    </ErrorBoundary>
  </React.StrictMode>
)
// App-level offline sync: ONE drain loop for the whole portal, installed
// once at boot. It survives page navigation (the old per-scanner-page
// drainer died on unmount) and kicks a drain immediately — queued scans
// sync even if the operator never opens a scanner page. Idempotent and
// exception-proof: a sync engine must never break app boot.
try {
  installOfflineSync()
} catch {
  // Sync stays best-effort; the app boots without it.
}
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      // Prompt-driven updates: when a NEW worker finishes installing while
      // this page is controlled, tell the app (SwUpdatePrompt) instead of
      // swapping code under a running scan session.
      const watch = (worker) => {
        if (!worker) return
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            window.dispatchEvent(new CustomEvent('portal-sw-update', { detail: { registration: reg } }))
          }
        })
      }
      if (reg.waiting && navigator.serviceWorker.controller) {
        window.dispatchEvent(new CustomEvent('portal-sw-update', { detail: { registration: reg } }))
      }
      reg.addEventListener('updatefound', () => watch(reg.installing))
    }).catch(() => {})
  })
}
