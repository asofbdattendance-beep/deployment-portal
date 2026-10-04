import { useState, useCallback } from 'react'
import { useExport } from './useExport'
import { useIsMobile } from './useMediaQuery'
import { exportWorkbook, exportWorkbookBlob } from '../lib/excel'

/**
 * useExcelExport — the one export pattern every report page shares.
 *
 * Extracted verbatim from AttendancePage's exportExcel/onExportPress pair:
 * desktop writes the file directly (anchor download); phones open the
 * ExportSheet and build the Blob on the Export tap (tap-1) so the sheet's
 * Share/Save tap (tap-2) carries a live user gesture — a share issued after
 * an awaited workbook build is silently blocked on iOS (see useExport).
 *
 * Toasts stay in the page: the hook returns counts (`written`) and the page
 * decides what "Nothing to export" vs success sounds like. `buildSheets`
 * must return the already-loaded, already-filtered sheet list — an export
 * never refetches (lib/excel.js conventions).
 *
 * @param {object} cfg
 * @param {string} cfg.filename            e.g. `{slug}_{date}_attendance.xlsx`
 * @param {() => Array<{name:string,rows:Array}>} cfg.buildSheets
 * @param {boolean} [cfg.keepEmpty=false]  pass through to the excel driver
 */
export function useExcelExport({ filename, buildSheets, keepEmpty = false }) {
  const isMobile = useIsMobile()
  const [exporting, setExporting] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const mobile = useExport()

  const exportDesktop = useCallback(async () => {
    setExporting(true)
    try {
      return await exportWorkbook(filename, buildSheets(), { keepEmpty })
    } finally {
      setExporting(false)
    }
  }, [filename, buildSheets, keepEmpty])

  const closeSheet = useCallback(() => {
    setSheetOpen(false)
    mobile.reset()
  }, [mobile])

  const onExportPress = useCallback(async () => {
    if (!isMobile) return exportDesktop()
    setSheetOpen(true)
    return mobile.prepare(async () => {
      const { blob, written } = await exportWorkbookBlob(filename, buildSheets(), { keepEmpty })
      if (!written) return null
      return { blob, filename }
    })
  }, [isMobile, exportDesktop, mobile, filename, buildSheets, keepEmpty])

  return { exporting, exportDesktop, onExportPress, sheetOpen, closeSheet, mobile, isMobile }
}
