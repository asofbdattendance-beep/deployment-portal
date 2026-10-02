import { useRef, useState, useCallback } from 'react'
import { Loader2, ArrowDown } from 'lucide-react'

const PULL_THRESHOLD = 72

/**
 * PullToRefresh — pull-down-to-refresh wrapper for mobile lists.
 *
 * Only activates when the wrapped scroller is at the very top
 * (scrollTop <= 0): a downward drag past PULL_THRESHOLD shows "Release to
 * refresh"; releasing fires onRefresh. Desktop / non-touch pointers never
 * engage (touch events only). While `refreshing`, the spinner shows and
 * further pulls are ignored.
 */
export default function PullToRefresh({ onRefresh, refreshing = false, disabled = false, children }) {
  const [pull, setPull] = useState(0)
  const [armed, setArmed] = useState(false)
  const startY = useRef(null)
  const tracking = useRef(false)

  const onTouchStart = useCallback((e) => {
    if (disabled || refreshing) return
    const scroller = e.currentTarget
    // Pages scroll the WINDOW (not this wrapper), so both must be at top.
    // Without the window check a mid-page pull would arm the refresh.
    if (scroller.scrollTop > 0) return
    try {
      if (typeof window !== 'undefined' && window.scrollY > 0) return
    } catch { /* ignore */ }
    const t = e.touches[0]
    if (!t) return
    startY.current = t.clientY
    tracking.current = true
  }, [disabled, refreshing])

  const onTouchMove = useCallback((e) => {
    if (!tracking.current || startY.current == null) return
    const t = e.touches[0]
    if (!t) return
    const dy = t.clientY - startY.current
    if (dy > 0) {
      // Dampen: the indicator stretches at ~40% of the finger travel.
      setPull(Math.min(Math.round(dy * 0.4), 110))
      setArmed(dy * 0.4 >= PULL_THRESHOLD)
    } else {
      setPull(0)
      setArmed(false)
    }
  }, [])

  const endPull = useCallback(() => {
    if (!tracking.current) return
    tracking.current = false
    startY.current = null
    if (armed && !disabled && !refreshing) {
      const p = onRefresh?.()
      // Support async refresh fns without requiring the caller to wire state.
      if (p && typeof p.catch === 'function') p.catch(() => {})
    }
    setPull(0)
    setArmed(false)
  }, [armed, disabled, refreshing, onRefresh])

  return (
    <div
      className="ptr"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={endPull}
      onTouchCancel={endPull}
    >
      {(pull > 0 || refreshing) && (
        <div className="ptr-indicator" aria-live="polite">
          {refreshing
            ? (<><Loader2 size={16} className="spin" aria-hidden="true" /><span>Refreshing…</span></>)
            : armed
              ? (<><ArrowDown size={16} aria-hidden="true" /><span>Release to refresh</span></>)
              : (<><ArrowDown size={16} aria-hidden="true" /><span>Pull to refresh</span></>)}
        </div>
      )}
      <div className="ptr-body" style={pull > 0 ? { transform: `translateY(${pull}px)` } : undefined}>
        {children}
      </div>
    </div>
  )
}
