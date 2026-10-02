import { useState, useCallback } from 'react'
import { shareOrDownload } from '../lib/mobile'

/**
 * useExport — mobile export delivery behind every report download button.
 *
 * The gesture rule (iOS Web Share needs a fresh user gesture): the page
 * builds the Blob on the Export tap (tap-1, opens the sheet), then
 * `deliver()` runs on the explicit Share/Save tap inside the sheet
 * (tap-2) so the share call carries a live gesture. A share call made
 * after an awaited workbook build would be silently blocked — this split
 * is the whole point of the hook.
 *
 * Desktop never touches this hook: pages keep their direct download.
 *
 * @returns {{ file, building, buildError, prepare, deliver, reset }}
 *   file = { blob, filename } | null; deliver() → 'share'|'download'|'unavailable'
 */
export function useExport() {
  const [file, setFile] = useState(null)
  const [building, setBuilding] = useState(false)
  const [buildError, setBuildError] = useState('')
  const [delivering, setDelivering] = useState(false)
  const [deliveredVia, setDeliveredVia] = useState(null)

  // buildFn: () => Promise<{ blob, filename } | null>. Null blob = "nothing
  // to export" — surfaced as buildError, never an empty sheet.
  const prepare = useCallback(async (buildFn) => {
    setBuilding(true)
    setBuildError('')
    setDeliveredVia(null)
    try {
      const out = await buildFn()
      if (!out || !out.blob) {
        setFile(null)
        setBuildError('Nothing to export for the current filters.')
        return null
      }
      setFile({ blob: out.blob, filename: out.filename || 'attendance.xlsx' })
      return out
    } catch (err) {
      setFile(null)
      setBuildError(err?.message || 'Could not build the workbook.')
      return null
    } finally {
      setBuilding(false)
    }
  }, [])

  const deliver = useCallback(async () => {
    if (!file) return 'unavailable'
    setDelivering(true)
    try {
      const { method } = await shareOrDownload(file.blob, file.filename)
      setDeliveredVia(method)
      return method
    } finally {
      setDelivering(false)
    }
  }, [file])

  const reset = useCallback(() => {
    setFile(null)
    setBuildError('')
    setDeliveredVia(null)
  }, [])

  return { file, building, buildError, delivering, deliveredVia, prepare, deliver, reset }
}
