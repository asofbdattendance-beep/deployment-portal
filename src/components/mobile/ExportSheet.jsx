import { Share2, Download, FileSpreadsheet, AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react'
import PrintPdfButton from '../PrintPdfButton'
import { safeBottom, canShareFiles, fileForShare } from '../../lib/mobile'
import { useBottomSheet } from './useBottomSheet'

/**
 * ExportSheet — bottom sheet that delivers a prepared workbook on phones.
 *
 * States: building (spinner) → ready (Share / Save buttons + size) →
 * delivered (confirmation) / error (retry). Share uses the Web Share API
 * (Files / Drive / WhatsApp — the only reliable "save" on iOS Safari);
 * Save falls back to an anchor download. Shares the .mobile-sheet-* CSS
 * with MoreSheet/FilterSheet.
 */
function formatSize(blob) {
  const n = Number(blob?.size)
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export default function ExportSheet({
  open,
  onClose,
  filename,
  file,
  building,
  buildError,
  delivering,
  deliveredVia,
  onDeliver,
  onRetry,
}) {
  const sheetRef = useBottomSheet(open, onClose)

  if (!open) return null

  const shareFile = file ? fileForShare(file, filename, undefined) : null
  const shareAvailable = shareFile ? canShareFiles([shareFile]) : false

  return (
    <div className="mobile-sheet-overlay" onClick={onClose}>
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Export report"
        tabIndex={-1}
        className="mobile-sheet"
        style={{ paddingBottom: safeBottom('0.9rem') }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mobile-sheet-handle" aria-hidden="true" />
        <h2 className="mobile-sheet-title">Export report</h2>

        {building && (
          <div className="mobile-export-state" role="status">
            <Loader2 size={20} className="spin" aria-hidden="true" />
            <span>Preparing workbook…</span>
          </div>
        )}

        {!building && buildError && (
          <div className="mobile-export-state mobile-export-error" role="alert">
            <AlertTriangle size={18} aria-hidden="true" />
            <span>{buildError}</span>
            {onRetry && (
              <button type="button" onClick={onRetry} className="btn mobile-sheet-close">
                Try again
              </button>
            )}
          </div>
        )}

        {!building && !buildError && file && (
          <>
            <div className="mobile-export-file">
              <FileSpreadsheet size={20} aria-hidden="true" />
              <div>
                <div className="mobile-export-name">{filename}</div>
                {formatSize(file) && <div className="mobile-export-size">{formatSize(file)} · Excel workbook</div>}
              </div>
            </div>
            {deliveredVia === 'share' && (
              <div className="mobile-export-state" role="status">
                <CheckCircle2 size={18} aria-hidden="true" />
                <span>Shared — pick Files or Drive in the sheet to save it.</span>
              </div>
            )}
            {deliveredVia === 'download' && (
              <div className="mobile-export-state" role="status">
                <CheckCircle2 size={18} aria-hidden="true" />
                <span>Saved — check your Downloads folder.</span>
              </div>
            )}
            {deliveredVia === 'unavailable' && (
              <div className="mobile-export-state mobile-export-error" role="alert">
                <AlertTriangle size={18} aria-hidden="true" />
                <span>Could not save on this device — try Print to PDF instead.</span>
              </div>
            )}
            <div className="mobile-export-actions">
              {shareAvailable && (
                <button
                  type="button"
                  onClick={onDeliver}
                  disabled={delivering}
                  className="btn btn-primary mobile-sheet-close"
                >
                  <Share2 size={16} aria-hidden="true" /> {delivering ? 'Sharing…' : 'Share'}
                </button>
              )}
              <button
                type="button"
                onClick={onDeliver}
                disabled={delivering}
                className={`btn mobile-sheet-close ${shareAvailable ? '' : 'btn-primary'}`}
              >
                <Download size={16} aria-hidden="true" /> {delivering ? 'Saving…' : 'Save to device'}
              </button>
            </div>
          </>
        )}

        {/* PDF does not depend on the workbook, so it is offered ALWAYS —
            including while Excel is still building or after it failed. The
            sheet unmounts first (`onClose`), otherwise the overlay is what
            lands in the PDF. */}
        <div className="mobile-export-actions mobile-export-pdf">
          <PrintPdfButton
            className="btn mobile-sheet-close"
            label="Export PDF"
            onBeforePrint={onClose}
          />
        </div>

        <button type="button" onClick={onClose} className="btn mobile-sheet-close">
          Close
        </button>
      </div>
    </div>
  )
}
