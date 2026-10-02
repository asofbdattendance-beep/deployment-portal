import { safeBottom } from '../../lib/mobile'
import { useBottomSheet } from './useBottomSheet'

/**
 * QuickPeekSheet — generic bottom sheet for "tap a row, see its detail".
 * Used by the AttendanceMatrix mobile view (tap a badge → its visit days)
 * and anywhere else a row needs a phone-friendly detail view. Shares the
 * .mobile-sheet-* CSS with More/Filter/Export sheets.
 */
export default function QuickPeekSheet({ open, onClose, title, children }) {
  const sheetRef = useBottomSheet(open, onClose)

  if (!open) return null

  return (
    <div className="mobile-sheet-overlay" onClick={onClose}>
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={title || 'Details'}
        tabIndex={-1}
        className="mobile-sheet"
        style={{ paddingBottom: safeBottom('0.9rem') }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mobile-sheet-handle" aria-hidden="true" />
        {title && <h2 className="mobile-sheet-title">{title}</h2>}
        <div className="mobile-peek-body">
          {children}
        </div>
        <button type="button" onClick={onClose} className="btn mobile-sheet-close">
          Close
        </button>
      </div>
    </div>
  )
}
