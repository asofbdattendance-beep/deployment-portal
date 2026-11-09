import { useState, createContext, useContext, useCallback, useMemo, useRef, useEffect } from 'react'
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react'

const ToastContext = createContext(null)

// Monotonic id counter — Date.now() collides when two toasts are added in
// the same millisecond, which made React drop/replace one of them.
let toastSeq = 0

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  // auto-dismiss timers are tracked so a stale timeout can never fire
  // setState after the provider unmounts
  const timersRef = useRef(new Set())

  useEffect(() => {
    const timers = timersRef.current
    return () => {
      timers.forEach(clearTimeout)
      timers.clear()
    }
  }, [])

  // Messages currently on screen, keyed by type + text. A caller that fires
  // the same toast many times a second (the camera re-offering a badge while
  // a save is in flight) shows ONE toast, not a stack that buries the screen.
  // Maps key → the id of the copy currently showing. Releasing a key checks
  // the id, so a closed toast's stale timer can never free a NEWER copy.
  const visibleRef = useRef(new Map())
  const release = (key, id) => {
    if (visibleRef.current.get(key) === id) visibleRef.current.delete(key)
  }

  const addToast = useCallback((message, type = 'info', duration = 3000) => {
    const key = `${type}\u0000${message}`
    if (visibleRef.current.has(key)) return
    const id = ++toastSeq
    visibleRef.current.set(key, id)
    setToasts(prev => [...prev, { id, message, type, key }])
    const timer = setTimeout(() => {
      timersRef.current.delete(timer)
      release(key, id)
      setToasts(prev => prev.filter(t => t.id !== id))
    }, duration)
    timersRef.current.add(timer)
  }, [])

  const removeToast = useCallback((id) => {
    setToasts(prev => {
      const gone = prev.find(t => t.id === id)
      if (gone) release(gone.key, id)
      return prev.filter(t => t.id !== id)
    })
  }, [])

  // Stable identity — the toast object must not change between renders,
  // otherwise every consumer's useCallback([..., toast]) gets recreated on
  // each toast pop, which re-triggers effects and can cause reload loops.
  const toast = useMemo(() => ({
    success: (msg, dur) => addToast(msg, 'success', dur),
    error: (msg, dur) => addToast(msg, 'error', dur || 4000),
    warning: (msg, dur) => addToast(msg, 'warning', dur),
    info: (msg, dur) => addToast(msg, 'info', dur),
  }), [addToast])

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <ToastContainer toasts={toasts} removeToast={removeToast} />
    </ToastContext.Provider>
  )
}

export function useToast() {
  const context = useContext(ToastContext)
  if (!context) {
    return {
      success: () => {},
      error: () => {},
      warning: () => {},
      info: () => {},
    }
  }
  return context
}

function ToastContainer({ toasts, removeToast }) {
  if (toasts.length === 0) return null
  return (
    <div className="toast-container">
      {toasts.map(toast => (
        <Toast key={toast.id} toast={toast} onClose={() => removeToast(toast.id)} />
      ))}
    </div>
  )
}

function Toast({ toast, onClose }) {
  const icons = {
    success: <CheckCircle size={20} />,
    error: <XCircle size={20} />,
    warning: <AlertTriangle size={20} />,
    info: <Info size={20} />,
  }

  return (
    <div className={`toast toast-${toast.type}`} role="status" aria-live="polite">
      <span className="toast-icon">{icons[toast.type]}</span>
      <span className="toast-message">{toast.message}</span>
      <button className="toast-close" onClick={onClose} aria-label="Dismiss notification" title="Dismiss notification">
        <X size={16} />
      </button>
    </div>
  )
}
