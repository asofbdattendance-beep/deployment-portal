// @vitest-environment jsdom
// Styled attendance workbook (Dept Incharge Dashboard snapshot export).
// The namespace is injected, so no real exceljs import and no DOM download
// is needed to assert the workbook shape — only the thin download wrapper
// needs jsdom, and it takes a fake loader.
import { describe, it, expect, vi } from 'vitest'
import { buildAttendanceWorkbook, exportAttendanceWorkbook, EXCEL_THEME } from './attendanceExcel'

const colLetter = (n) => {
  let s = ''
  while (n > 0) {
    const m = (n - 1) % 26
    s = String.fromCharCode(65 + m) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

class FakeCell {
  constructor(address) {
    this.address = address
    this.value = undefined
    this.font = {}
    this.fill = null
    this.alignment = {}
    this.border = {}
  }
}

class FakeSheet {
  constructor(name) {
    this.name = name
    this.cells = new Map()
    this.rows = new Map()
    this.columns = []
    this.views = null
    this.merged = []
    this.autoFilter = null
  }

  getCell(r, c) {
    const key = `${r}:${c}`
    if (!this.cells.has(key)) this.cells.set(key, new FakeCell(`${colLetter(c)}${r}`))
    return this.cells.get(key)
  }

  getRow(r) {
    if (!this.rows.has(r)) this.rows.set(r, {})
    return this.rows.get(r)
  }

  mergeCells(...args) {
    this.merged.push(args)
  }
}

class FakeWorkbook {
  constructor() {
    this.sheets = []
    this.xlsx = { writeBuffer: vi.fn(async () => new Uint8Array([1, 2, 3])) }
  }

  addWorksheet(name) {
    const ws = new FakeSheet(name)
    this.sheets.push(ws)
    return ws
  }
}

const FakeNS = { Workbook: FakeWorkbook }

const kpis = {
  today: { deployed: 16, present: 12, absent: 4, openNow: 1, rate: 75 },
  visit: { deployed: 16, present: 15, absent: 1, rate: 94 },
}
const matrix = {
  columns: ['2026-10-07', '2026-10-08'],
  rows: [
    {
      badge_number: 'B1', sewadar_name: 'Asha', centre: 'DELHI', dept_name: 'Traffic', is_vss: false,
      byDate: { '2026-10-07': true, '2026-10-08': false }, presentCount: 1,
    },
    {
      badge_number: 'B2', sewadar_name: 'Zed', sewadar_centre: 'NOIDA', dept_name: 'Medical', is_vss: false,
      centre: 'NOIDA', byDate: { '2026-10-07': false, '2026-10-08': false }, presentCount: 0,
    },
  ],
}
const input = { scheduleName: 'October 2026 Visit', date: '2026-10-11', kpis, matrix }

const cell = (ws, r, c) => ws.cells.get(`${r}:${c}`)

describe('buildAttendanceWorkbook', () => {
  it('writes the three snapshot sheets with styled headers', () => {
    const { wb, sheetsWritten } = buildAttendanceWorkbook(FakeNS, input)
    expect(sheetsWritten).toBe(3)
    expect(wb.sheets.map((s) => s.name)).toEqual(['Today', 'Whole visit', 'Attd Matrix'])
    for (const ws of wb.sheets) {
      expect(cell(ws, 1, 1)?.font?.bold ?? cell(ws, 2, 1)?.font?.bold).toBe(true)
    }
    const today = wb.sheets[0]
    expect(cell(today, 2, 1).value).toBe('Deployed')
    expect(cell(today, 2, 2).value).toBe(16)
    const visit = wb.sheets[1]
    expect(cell(visit, 3, 1).value).toBe('Ever present')
    expect(cell(visit, 3, 2).value).toBe(15)
  })

  it('paints P green and A red with a frozen header and a Days column', () => {
    const { wb } = buildAttendanceWorkbook(FakeNS, input)
    const ws = wb.sheets[2]
    // Title row merged across Badge..Days (5 fixed + 2 dates + Days = 8).
    expect(ws.merged).toEqual([[1, 1, 1, 8]])
    expect(cell(ws, 1, 1).value).toContain('October 2026 Visit')
    // Header row carries the ISO dates plus the trailing Days column.
    expect(cell(ws, 2, 6).value).toBe('2026-10-07')
    expect(cell(ws, 2, 7).value).toBe('2026-10-08')
    expect(cell(ws, 2, 8).value).toBe('Days')
    expect(ws.views).toEqual([{ state: 'frozen', xSplit: 2, ySplit: 2 }])
    expect(ws.autoFilter).toEqual({ from: 'A2', to: 'H2' })
    // B1: present day one, absent day two.
    const p = cell(ws, 3, 6)
    expect(p.value).toBe('P')
    expect(p.fill.fgColor.argb).toBe(EXCEL_THEME.PRESENT_FILL)
    expect(p.font.color.argb).toBe(EXCEL_THEME.PRESENT_FONT)
    const a = cell(ws, 3, 7)
    expect(a.value).toBe('A')
    expect(a.fill.fgColor.argb).toBe(EXCEL_THEME.ABSENT_FILL)
    expect(a.font.color.argb).toBe(EXCEL_THEME.ABSENT_FONT)
    expect(cell(ws, 3, 8).value).toBe('1/2')
    expect(cell(ws, 4, 8).value).toBe('0/2')
    expect(cell(ws, 3, 5).value).toBe('Regular')
  })

  it('skips the matrix sheet when there are no rows', () => {
    const { wb, sheetsWritten } = buildAttendanceWorkbook(FakeNS, { ...input, matrix: { columns: [], rows: [] } })
    expect(sheetsWritten).toBe(2)
    expect(wb.sheets.map((s) => s.name)).toEqual(['Today', 'Whole visit'])
  })
})

describe('exportAttendanceWorkbook', () => {
  it('serializes the workbook and downloads it under the given filename', async () => {
    const createObjectURL = vi.fn(() => 'blob:fake')
    const revokeObjectURL = vi.fn()
    globalThis.URL.createObjectURL = createObjectURL
    globalThis.URL.revokeObjectURL = revokeObjectURL
    const clicked = []
    const origClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function click() { clicked.push(this.getAttribute('download')) }
    try {
      const n = await exportAttendanceWorkbook(
        { filename: 'october_visit_incharge_2026-10-11.xlsx', ...input },
        async () => FakeNS,
      )
      expect(n).toBe(3)
      expect(createObjectURL).toHaveBeenCalledTimes(1)
      expect(clicked).toEqual(['october_visit_incharge_2026-10-11.xlsx'])
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake')
    } finally {
      HTMLAnchorElement.prototype.click = origClick
    }
  })

  it('returns 0 without downloading when every sheet is empty', async () => {
    const createObjectURL = vi.fn(() => 'blob:fake')
    globalThis.URL.createObjectURL = createObjectURL
    const n = await exportAttendanceWorkbook(
      { filename: 'empty.xlsx', scheduleName: '', date: '', kpis: undefined, matrix: { columns: [], rows: [] } },
      async () => FakeNS,
    )
    expect(n).toBe(0)
    expect(createObjectURL).not.toHaveBeenCalled()
  })
})
