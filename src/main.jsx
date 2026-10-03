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
import InstallPrompt from './components/mobile/InstallPrompt'
import SwUpdatePrompt from './components/mobile/SwUpdatePrompt'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <PortalAuthProvider>
        <ToastProvider>
          <OfflineBanner />
          <InstallPrompt />
          <SwUpdatePrompt />
          <App />
        </ToastProvider>
      </PortalAuthProvider>
    </ErrorBoundary>
  </React.StrictMode>
)
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
