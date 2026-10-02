import { SlidersHorizontal, X } from 'lucide-react'
import { safeBottom } from '../../lib/mobile'
import { useBottomSheet } from './useBottomSheet'

/**
 * FilterSheet — bottom sheet hosting a page's existing filter controls.
 * Pages pass their desktop filter JSX as children UNCHANGED (same state,
 * same handlers), so mobile and desktop can never disagree. Rendered ONLY
 * on mobile (useIsMobile gate at the call site).
 *
 * Shares the .mobile-sheet-* CSS with MoreSheet — one bottom-sheet visual
 * language across the portal.
 */
export default function FilterSheet({ open, onClose, title = 'Filters', resultText, onClearAll, hasActive, children }) {
  const sheetRef = useBottomSheet(open, onClose)

  if (!open) return null

  return (
    <div className="mobile-sheet-overlay" onClick={onClose}>
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="mobile-sheet"
        style={{ paddingBottom: safeBottom('0.9rem') }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mobile-sheet-handle" aria-hidden="true" />
        <div className="mobile-filter-sheet-head">
          <h2 className="mobile-sheet-title" style={{ margin: 0 }}>{title}</h2>
          {hasActive && (
            <button type="button" onClick={onClearAll} className="btn btn-ghost mobile-filter-clear">
              Clear all
            </button>
          )}
        </div>
        {resultText && <div className="mobile-filter-result" aria-live="polite">{resultText}</div>}
        <div className="mobile-filter-fields">
          {children}
        </div>
        <button type="button" onClick={onClose} className="btn btn-primary mobile-sheet-close">
          Show results
        </button>
      </div>
    </div>
  )
}

/**
 * MobileFilterBar — sticky summary row rendered on phones above a report
 * table: a Filters button (with active-count badge), horizontally
 * scrolling active chips (tap × to clear), and the result count.
 */
export function MobileFilterBar({ onOpen, chips = [], onClearChip, onClearAll, resultText, activeCount = 0 }) {
  return (
    <div className="mobile-filterbar" role="search">
      <button type="button" onClick={onOpen} className="btn mobile-filter-open" aria-haspopup="dialog">
        <SlidersHorizontal size={16} aria-hidden="true" />
        Filters
        {activeCount > 0 && <span className="mobile-filter-badge">{activeCount}</span>}
      </button>
      {chips.length > 0 && (
        <div className="mobile-filter-chips" aria-label="Active filters">
          {chips.map((c) => (
            <span key={c.key} className="mobile-chip">
              {c.label}
              <button
                type="button"
                onClick={() => onClearChip(c.key)}
                aria-label={`Clear filter ${c.label}`}
                className="mobile-chip-x"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </span>
          ))}
          <button type="button" onClick={onClearAll} className="mobile-chip-clear">
            Clear all
          </button>
        </div>
      )}
      {resultText && <div className="mobile-filterbar-count" aria-live="polite">{resultText}</div>}
    </div>
  )
}
