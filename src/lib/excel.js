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

/**
 * Full export driver: lazy-loads xlsx, builds every sheet, writes the file.
 * Sheets with zero rows are SKIPPED (an empty sheet still costs a tab and
 * confuses "nothing to export" checks) — unless opts.keepEmpty is set.
 * Returns the number of sheets written; 0 means the caller should toast
 * "Nothing to export" instead of writing an empty workbook.
 */
export async function exportWorkbook(filename, sheets, opts = {}) {
  const XLSX = await loadXlsx()
  const wb = newWorkbook(XLSX)
  let written = 0
  for (const s of sheets || []) {
    const rows = Array.isArray(s.rows) ? s.rows : []
    if (rows.length === 0 && !opts.keepEmpty) continue
    addSheet(XLSX, wb, s.name, rows)
    written += 1
  }
  if (written === 0) return 0
  saveWorkbook(XLSX, wb, filename)
  return written
}
