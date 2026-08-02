import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { PortalAuthProvider } from './context/PortalAuthContext'
import { ToastProvider } from './components/Toast'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter future={{ v7_relativeSplatPath: true }}>
      <PortalAuthProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </PortalAuthProvider>
    </BrowserRouter>
  </React.StrictMode>
)
