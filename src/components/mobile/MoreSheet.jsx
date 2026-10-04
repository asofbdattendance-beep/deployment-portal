import { useEffect, useRef } from 'react'
import { Check } from 'lucide-react'
import { safeBottom } from '../../lib/mobile'

/**
 * MoreSheet — bottom sheet listing the overflow pages behind MobileTabBar's
 * More button. Rendered ONLY on mobile (useIsMobile gate in App.jsx).
 * Optional `sections` ([{ label, items }]) renders phase-headed groups with
 * an optional `phaseHeader` node (the PhaseSwitch) above them; otherwise the
 * flat `items` list renders exactly as before (back-compat for tests).
 *
 * A11y contract (mirrors ScanResultPopup's dialog discipline):
 * - role="dialog" aria-modal, labelled by the heading.
 * - Focus moves to the sheet on open, restores to the invoker on close.
 * - Tab is trapped inside while open; Escape/backdrop closes.
 * - Body scroll locks while mounted (restored on unmount).
 * - 150ms slide-up; disabled entirely under prefers-reduced-motion (CSS).
 */
export default function MoreSheet({ open, items, sections, phaseHeader, currentPage, onSelect, onClose, label = 'More pages' }) {
  const sheetRef = useRef(null)
  const prevFocusRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    prevFocusRef.current = document.activeElement
    // Focus the sheet (or the active item) after paint.
    const t = setTimeout(() => {
      const el = sheetRef.current?.querySelector('[aria-current="page"]') || sheetRef.current
      try { el?.focus({ preventScroll: true }) } catch { /* ignore */ }
    }, 60)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
      else if (e.key === 'Tab') {
        const f = [...(sheetRef.current?.querySelectorAll('button') || [])].filter((b) => !b.disabled)
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
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="mobile-sheet-overlay" onClick={onClose}>
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className="mobile-sheet"
        style={{ paddingBottom: safeBottom('0.9rem') }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mobile-sheet-handle" aria-hidden="true" />
        <h2 className="mobile-sheet-title">{label}</h2>
        {phaseHeader ? <div className="mobile-sheet-phase">{phaseHeader}</div> : null}
        {(sections && sections.length > 0 ? sections : [{ label: null, items: items || [] }]).map((section, si) => (
          <div key={section.label || `all-${si}`} className="mobile-sheet-section">
            {section.label ? <h3 className="mobile-sheet-heading">{section.label}</h3> : null}
            <ul className="mobile-sheet-list">
              {(section.items || []).map((item) => {
                const active = currentPage === item.key
                const Icon = item.icon
                return (
                  <li key={item.key}>
                    <button
                      type="button"
                      onClick={() => { onSelect(item.key) }}
                      className={`mobile-sheet-item${active ? ' mobile-sheet-item-active' : ''}`}
                      aria-current={active ? 'page' : undefined}
                    >
                      {Icon ? <Icon size={19} aria-hidden="true" /> : null}
                      <span>{item.label}</span>
                      {active && <Check size={16} style={{ marginLeft: 'auto' }} aria-hidden="true" />}
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
        <button type="button" onClick={onClose} className="btn mobile-sheet-close">
          Close
        </button>
      </div>
    </div>
  )
}
