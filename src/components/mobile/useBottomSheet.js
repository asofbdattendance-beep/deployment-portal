import { useEffect, useRef } from 'react'

/**
 * useBottomSheet — shared dialog discipline for mobile bottom sheets
 * (FilterSheet; MoreSheet predates it and keeps its own inline copy).
 *
 * - Focus moves into the sheet on open, restores to the invoker on close.
 * - Tab is trapped while open; Escape closes.
 * - Body scroll locks while mounted (restored on unmount).
 * Returns a ref to attach to the dialog element.
 */
export function useBottomSheet(open, onClose, { initialFocusSelector = '[aria-current="page"], button, input, select' } = {}) {
  const sheetRef = useRef(null)
  const prevFocusRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    prevFocusRef.current = document.activeElement
    const t = setTimeout(() => {
      const el = sheetRef.current?.querySelector(initialFocusSelector) || sheetRef.current
      try { el?.focus({ preventScroll: true }) } catch { /* ignore */ }
    }, 60)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
      else if (e.key === 'Tab') {
        const f = [...(sheetRef.current?.querySelectorAll('button, input, select, textarea, [tabindex]') || [])].filter((b) => !b.disabled)
        if (f.length === 0) return
        const first = f[0]
        const last = f[f.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      clearTimeout(t)
      document.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = prevOverflow
      try { prevFocusRef.current?.focus?.({ preventScroll: true }) } catch { /* ignore */ }
    }
  }, [open, onClose, initialFocusSelector])

  return sheetRef
}
