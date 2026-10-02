import { useState, useEffect } from 'react'

/**
 * useOnline — reactive connectivity flag.
 *
 * `navigator.onLine` read at render time never updates, so pages that read
 * it once show a stale Online pill until some other state change
 * re-renders. This hook subscribes to the browser online/offline events.
 * SSR-safe: defaults to true (assume online) when navigator is missing.
 */
export function useOnline() {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  )
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    // Re-read on mount in case status changed before listeners attached.
    try {
      setOnline(navigator.onLine !== false)
    } catch { /* ignore */ }
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  return online
}
