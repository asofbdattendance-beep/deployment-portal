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
 */
export default function ExportButton({
  filename,
  buildSheets,
  keepEmpty = false,
  label = 'Export Excel',
  disabled = false,
}) {
  const { exporting, onExportPress, sheetOpen, closeSheet, mobile } = useExcelExport({
    filename,
    buildSheets,
    keepEmpty,
  })
  const busy = exporting || mobile.building
  return (
    <>
      <button
        type="button"
        onClick={onExportPress}
        disabled={disabled || busy}
        className="btn btn-primary"
      >
        {busy ? <Loader2 size={13} className="spin" /> : <Download size={13} />} {label}
      </button>
      <ExportSheet
        open={sheetOpen}
        onClose={closeSheet}
        filename={filename}
        file={mobile.file}
        building={mobile.building}
        buildError={mobile.buildError}
        delivering={mobile.delivering}
        deliveredVia={mobile.deliveredVia}
        onDeliver={mobile.deliver}
        onRetry={onExportPress}
      />
    </>
  )
}
