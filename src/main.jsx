import React from 'react'
import ReactDOM from 'react-dom/client'
import { PortalAuthProvider } from './context/PortalAuthContext'
import { ToastProvider } from './components/Toast'
import ErrorBoundary from './components/ErrorBoundary'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <PortalAuthProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </PortalAuthProvider>
    </ErrorBoundary>
  </React.StrictMode>
)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}
