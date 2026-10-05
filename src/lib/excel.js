/**
 * Shared Excel export helpers — extracted from AttendancePage so every
 * reports surface (Reports, Live Scanners, Anomalies, Dashboard snapshot)
 * builds workbooks the same way. No Supabase client here; the caller passes
 * already-loaded, already-filtered rows, so an export never refetches.
 *
 * Conventions (do not drift from these):
 * - `xlsx` is ALWAYS lazy-imported inside the export handler via loadXlsx(),
 *   never bundled at page load.
 * - Sheet names go through sheetName() (≤31 chars, no \ / * ? : [ ]).
 * - Summary sheets end with a TOTAL row appended as a plain object.
 * - Filenames are `{schedule}_{date}_{kind}.xlsx`, slugified like the
 *   schedule picker (spaces → underscores is handled by fileSlug()).
 */

export async function loadXlsx() {
  return await import('xlsx')
}

// Excel sheet names: ≤31 chars and none of \ / * ? : [ ]
// (verbatim from AttendancePage — every existing workbook relies on it).
export function sheetName(raw) {
  return String(raw ?? '').replace(/[\\/*?:[\]]/g, '-').slice(0, 31) || 'Sheet'
}

// Filename-safe slug: spaces and runs of non [A-Za-z0-9._-] collapse to one _.
export function fileSlug(raw) {
  return String(raw ?? 'schedule').trim().replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'schedule'
}

export function newWorkbook(XLSX) {
  return XLSX.utils.book_new()
}

export function addSheet(XLSX, wb, name, rows) {
  const ws = XLSX.utils.json_to_sheet(Array.isArray(rows) ? rows : [])
  XLSX.utils.book_append_sheet(wb, ws, sheetName(name))
  return ws
}

export function saveWorkbook(XLSX, wb, filename) {
  XLSX.writeFile(wb, filename)
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/**
 * Anchor download for a Blob. Desktop path of exportWorkbook; the mobile
 * share sheet lives in lib/mobile (shareOrDownload). Returns true when a
 * download was triggered. Never throws.
 */
export function saveBlob(blob, filename) {
  try {
    if (typeof window === 'undefined' || typeof document === 'undefined' || !blob) return false
    const url = (window.URL || URL).createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename || 'download'
    document.body.appendChild(a)
    a.click()
    setTimeout(() => {
      try { document.body.removeChild(a) } catch { /* ignore */ }
      try { (window.URL || URL).revokeObjectURL(url) } catch { /* ignore */ }
    }, 1000)
    return true
  } catch {
    return false
  }
}

/**
 * Serialize a built workbook to a Blob (no download triggered).
 * The caller decides delivery: anchor download on desktop, Web Share
 * sheet on phones (the only reliable "save" on iOS Safari).
 */
export function workbookToBlob(XLSX, wb) {
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
  return new Blob([out], { type: XLSX_MIME })
}

/**
 * Blob variant of exportWorkbook: builds every sheet and returns the file
 * instead of saving it. Returns { blob, written, filename }; blob is null
 * when nothing was written (caller toasts "Nothing to export").
 */
export async function exportWorkbookBlob(filename, sheets, opts = {}) {
  const XLSX = await loadXlsx()
  const wb = newWorkbook(XLSX)
  let written = 0
  for (const s of sheets || []) {
    const rows = Array.isArray(s.rows) ? s.rows : []
    if (rows.length === 0 && !opts.keepEmpty) continue
    addSheet(XLSX, wb, s.name, rows)
    written += 1
  }
  if (written === 0) return { blob: null, written: 0, filename }
  return { blob: workbookToBlob(XLSX, wb), written, filename }
}

/**
 * Full export driver: lazy-loads xlsx, builds every sheet, writes the file.
 * Sheets with zero rows are SKIPPED (an empty sheet still costs a tab and
 * confuses "nothing to export" checks) — unless opts.keepEmpty is set.
 * Returns the number of sheets written; 0 means the caller should toast
 * "Nothing to export" instead of writing an empty workbook.
 */
export async function exportWorkbook(filename, sheets, opts = {}) {
  const { blob, written } = await exportWorkbookBlob(filename, sheets, opts)
  if (written === 0) return 0
  saveBlob(blob, filename)
  return written
}

/**
 * Read the first sheet of an uploaded .xlsx file into normalised row objects.
 * Header keys are lowercased, trimmed, and have non-alphanumeric runs replaced
 * with underscores so downstream code can rely on stable field names.
 *
 * Returns an array of plain objects (one per data row). Empty cells get ''.
 * Throws if the file cannot be parsed or has no sheets.
 */
export async function readWorkbookRows(file) {
  const XLSX = await loadXlsx()
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })
  const firstSheetName = wb.SheetNames[0]
  if (!firstSheetName) throw new Error('Workbook has no sheets')
  const ws = wb.Sheets[firstSheetName]
  const raw = XLSX.utils.sheet_to_json(ws, { defval: '' })
  return raw.map((row) => {
    const normalised = {}
    for (const [key, val] of Object.entries(row)) {
      const norm = String(key).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
      normalised[norm] = val
    }
    return normalised
  })
}
