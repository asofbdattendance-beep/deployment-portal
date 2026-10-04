import { Download, Loader2 } from 'lucide-react'
import ExportSheet from './mobile/ExportSheet'
import { useExcelExport } from '../hooks/useExcelExport'

/**
 * ExportButton — the one "Export Excel" control every report page shares.
 *
 * One press does the right thing per device (see useExcelExport): anchor
 * download on desktop, share sheet on phones. Render contract mirrors the
 * AttendancePage header button: `btn btn-primary`, 13px icon, spinner while
 * building, disabled while building or when the page says there is nothing
 * current to export.
 *
 * @param {object} props
 * @param {string} props.filename
 * @param {() => Array<{name:string,rows:Array}>} props.buildSheets
 * @param {boolean} [props.keepEmpty=false]
 * @param {string} [props.label='Export Excel']
 * @param {boolean} [props.disabled=false]  e.g. `!rowsAreCurrent`
 * @param {(written:number) => void} [props.onExported]  desktop success path —
 *   the page announces it (`written === 0` is the "nothing to export" case).
 * @param {(err:unknown) => void} [props.onExportError]  desktop failure path.
 *   Mobile completion stays inside the ExportSheet (share/save gestures).
 */
export default function ExportButton({
  filename,
  buildSheets,
  keepEmpty = false,
  label = 'Export Excel',
  disabled = false,
  onExported,
  onExportError,
}) {
  const { isMobile, exporting, exportDesktop, onExportPress, sheetOpen, closeSheet, mobile } = useExcelExport({
    filename,
    buildSheets,
    keepEmpty,
  })
  // Desktop writes the file directly, so the result is observable here and the
  // page's toasts survive the migration. Mobile opens the sheet; its outcome
  // lives in the sheet's own share/save gestures, not in a toast.
  const handlePress = async () => {
    if (isMobile) return onExportPress()
    try {
      const written = await exportDesktop()
      onExported?.(written)
    } catch (e) {
      onExportError?.(e)
    }
  }
  const busy = exporting || mobile.building
  return (
    <>
      <button
        type="button"
        onClick={handlePress}
        disabled={disabled || busy}
        className="btn btn-primary"
      >
        {busy ? <Loader2 size={13} className="spin" /> : <Download size={13} />} {label}
      </button>
      <ExportSheet
        open={sheetOpen}
        onClose={closeSheet}
        filename={filename}
        file={mobile.file?.blob ?? null}
        building={mobile.building}
        buildError={mobile.buildError}
        delivering={mobile.delivering}
        deliveredVia={mobile.deliveredVia}
        onDeliver={mobile.deliver}
        onRetry={handlePress}
      />
    </>
  )
}
