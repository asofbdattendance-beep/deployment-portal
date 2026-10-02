/**
 * Styled attendance workbook — the Dept Incharge Dashboard snapshot export.
 *
 * The shared `src/lib/excel.js` driver uses community `xlsx`, which cannot
 * write cell colours, so this module lazy-loads `exceljs` instead (the same
 * pattern `DeploymentMatrixReport.jsx` uses: lazy import, ARGB constants
 * taken straight from the index.css tokens, frozen header rows, column
 * widths, thin grid borders).
 *
 * Sheet contract (unchanged from the xlsx version): 'Today' and
 * 'Whole visit' are Metric/Value tables; 'Attd Matrix' is one row per
 * sewadar with Badge/Name/Centre/Dept/Type, one ISO-date column per visit
 * day holding 'P'/'A', plus a trailing 'Days' (present/total) column. Empty
 * sheets are skipped, mirroring `exportWorkbook`.
 */

export const EXCEL_THEME = {
  HEAD_FILL: 'FFF8FAFC', // --surface-2
  PRESENT_FILL: 'FFECFDF5', // --success-soft
  PRESENT_FONT: 'FF047857', // .pill-green text
  ABSENT_FILL: 'FFFDF2F2', // --danger-soft (softened one step for large red areas)
  ABSENT_FONT: 'FFB91C1C', // .pill-red text
  GRID: 'FFE2E8F0', // --border
  TEXT: 'FF0F172A', // --text
}

const THIN = { style: 'thin', color: { argb: EXCEL_THEME.GRID } }

function styleHeaderRow(ws, row, nCols) {
  for (let c = 1; c <= nCols; c++) {
    const cell = ws.getCell(row, c)
    cell.font = { bold: true, color: { argb: EXCEL_THEME.TEXT } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: EXCEL_THEME.HEAD_FILL } }
    cell.alignment = { vertical: 'middle', horizontal: c <= 4 ? 'left' : 'center', wrapText: true }
    cell.border = { bottom: THIN }
  }
}

function styleGrid(ws, firstRow, lastRow, nCols) {
  for (let r = firstRow; r <= lastRow; r++) {
    for (let c = 1; c <= nCols; c++) {
      const cell = ws.getCell(r, c)
      cell.border = {
        top: THIN,
        left: c === 1 ? THIN : undefined,
        right: c === nCols ? THIN : undefined,
        bottom: r === lastRow ? THIN : undefined,
      }
      if (!cell.alignment || !cell.alignment.horizontal) {
        cell.alignment = { vertical: 'middle', horizontal: c <= 4 ? 'left' : 'center' }
      }
    }
  }
}

function addMetricSheet(wb, name, pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) return 0
  const ws = wb.addWorksheet(name)
  ws.getCell(1, 1).value = 'Metric'
  ws.getCell(1, 2).value = 'Value'
  styleHeaderRow(ws, 1, 2)
  pairs.forEach(([metric, value], i) => {
    const row = i + 2
    ws.getCell(row, 1).value = metric
    ws.getCell(row, 1).font = { bold: true, color: { argb: EXCEL_THEME.TEXT } }
    ws.getCell(row, 2).value = value ?? null
    ws.getCell(row, 2).alignment = { vertical: 'middle', horizontal: 'center' }
  })
  styleGrid(ws, 2, pairs.length + 1, 2)
  ws.columns = [{ width: 16 }, { width: 12 }]
  return 1
}

function addMatrixSheet(wb, { scheduleName, date, matrix }) {
  const columns = Array.isArray(matrix?.columns) ? matrix.columns : []
  const rows = Array.isArray(matrix?.rows) ? matrix.rows : []
  if (rows.length === 0) return 0
  const ws = wb.addWorksheet('Attd Matrix')
  const headers = ['Badge', 'Name', 'Centre', 'Dept', 'Type', ...columns, 'Days']
  const nCols = headers.length

  // Title row — merged across every column, like the report export.
  ws.mergeCells(1, 1, 1, nCols)
  const title = ws.getCell(1, 1)
  title.value = `Attendance matrix — ${scheduleName || 'schedule'} · ${date || ''}`.trim()
  title.font = { bold: true, size: 13, color: { argb: EXCEL_THEME.TEXT } }
  title.alignment = { horizontal: 'center', vertical: 'middle' }
  ws.getRow(1).height = 24

  headers.forEach((h, i) => {
    ws.getCell(2, i + 1).value = h
  })
  styleHeaderRow(ws, 2, nCols)

  rows.forEach((r, i) => {
    const row = i + 3
    const total = columns.length
    const presentCount = typeof r?.presentCount === 'number'
      ? r.presentCount
      : columns.filter((c) => !!r?.byDate?.[c]).length
    ws.getCell(row, 1).value = r?.badge_number ?? ''
    ws.getCell(row, 2).value = r?.sewadar_name ?? ''
    ws.getCell(row, 3).value = r?.centre ?? ''
    ws.getCell(row, 4).value = r?.dept_name ?? ''
    ws.getCell(row, 5).value = r?.is_vss ? 'VSS' : 'Regular'
    columns.forEach((c, ci) => {
      const present = !!r?.byDate?.[c]
      const cell = ws.getCell(row, 6 + ci)
      cell.value = present ? 'P' : 'A'
      cell.font = {
        bold: true,
        color: { argb: present ? EXCEL_THEME.PRESENT_FONT : EXCEL_THEME.ABSENT_FONT },
      }
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: present ? EXCEL_THEME.PRESENT_FILL : EXCEL_THEME.ABSENT_FILL },
      }
      cell.alignment = { vertical: 'middle', horizontal: 'center' }
    })
    const days = ws.getCell(row, 6 + columns.length)
    days.value = `${presentCount}/${total}`
    days.font = { bold: true, color: { argb: EXCEL_THEME.TEXT } }
    days.alignment = { vertical: 'middle', horizontal: 'center' }
  })
  styleGrid(ws, 3, rows.length + 2, nCols)
  ws.columns = [
    { width: 16 }, { width: 24 }, { width: 18 }, { width: 20 }, { width: 10 },
    ...columns.map(() => ({ width: 12 })),
    { width: 10 },
  ]
  // Freeze the title + header rows and the Badge/Name columns.
  ws.views = [{ state: 'frozen', xSplit: 2, ySplit: 2 }]
  const lastCol = ws.getCell(2, nCols).address.replace(/2$/, '')
  ws.autoFilter = { from: 'A2', to: `${lastCol}2` }
  return 1
}

/**
 * Build the styled workbook with any exceljs-compatible namespace. Taking
 * the namespace as a parameter (instead of importing inside) keeps this
 * pure and unit-testable without touching the DOM or the real exceljs.
 *
 * @returns {{wb: object, sheetsWritten: number}}
 */
export function buildAttendanceWorkbook(ExcelNS, { scheduleName, date, kpis, matrix }) {
  const NS = ExcelNS?.default || ExcelNS
  const wb = new NS.Workbook()
  let sheetsWritten = 0
  sheetsWritten += addMetricSheet(wb, 'Today', kpis?.today ? [
    ['Deployed', kpis.today.deployed],
    ['Present', kpis.today.present],
    ['Absent', kpis.today.absent],
    ['Open now', kpis.today.openNow],
    ['Rate %', kpis.today.rate],
  ] : [])
  sheetsWritten += addMetricSheet(wb, 'Whole visit', kpis?.visit ? [
    ['Deployed', kpis.visit.deployed],
    ['Ever present', kpis.visit.present],
    ['Never present', kpis.visit.absent],
    ['Rate %', kpis.visit.rate],
  ] : [])
  sheetsWritten += addMatrixSheet(wb, { scheduleName, date, matrix })
  return { wb, sheetsWritten }
}

/**
 * Build, serialize and download the snapshot workbook. `loadExcel` is an
 * injectable lazy loader so tests can pass a fake without importing exceljs.
 *
 * @returns {Promise<number>} sheets written (0 = caller toasts "nothing to export")
 */
export async function exportAttendanceWorkbook(
  { filename, scheduleName, date, kpis, matrix },
  loadExcel = () => import('exceljs'),
) {
  const mod = await loadExcel()
  const { wb, sheetsWritten } = buildAttendanceWorkbook(mod?.default || mod, {
    scheduleName, date, kpis, matrix,
  })
  if (sheetsWritten === 0) return 0
  const buf = await wb.xlsx.writeBuffer()
  if (typeof document !== 'undefined') {
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }
  return sheetsWritten
}
