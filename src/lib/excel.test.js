import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('xlsx', () => ({
  utils: {
    book_new: vi.fn(() => ({ sheets: [] })),
    json_to_sheet: vi.fn((rows) => ({ rows })),
    book_append_sheet: vi.fn((wb, ws, name) => wb.sheets.push(name)),
  },
  writeFile: vi.fn(),
}))

import { sheetName, fileSlug, exportWorkbook, addSheet } from './excel'
import * as XLSX from 'xlsx'

beforeEach(() => { vi.clearAllMocks() })

describe('sheetName', () => {
  it('strips illegal chars and caps at 31 (AttendancePage verbatim)', () => {
    expect(sheetName('a/b\\c:d*e?f[g]h')).toBe('a-b-c-d-e-f-g-h')
    expect(sheetName('x'.repeat(40))).toHaveLength(31)
    expect(sheetName('')).toBe('Sheet')
  })
})

describe('fileSlug', () => {
  it('slugifies schedule names for filenames', () => {
    expect(fileSlug('October 2026 Visit')).toBe('October_2026_Visit')
    expect(fileSlug('  a/b  ')).toBe('a_b')
    expect(fileSlug('')).toBe('schedule')
  })
})

describe('exportWorkbook', () => {
  it('skips empty sheets and returns 0 when there is nothing to export', async () => {
    const written = await exportWorkbook('x.xlsx', [{ name: 'A', rows: [] }])
    expect(written).toBe(0)
    expect(XLSX.writeFile).not.toHaveBeenCalled()
  })
  it('writes non-empty sheets and returns the count', async () => {
    const written = await exportWorkbook('x.xlsx', [
      { name: 'Summary', rows: [{ a: 1 }] },
      { name: 'Empty', rows: [] },
      { name: 'List', rows: [{ b: 2 }] },
    ])
    expect(written).toBe(2)
    expect(XLSX.writeFile).toHaveBeenCalledTimes(1)
    expect(XLSX.writeFile.mock.calls[0][1]).toBe('x.xlsx')
  })
  it('addSheet sanitizes the tab name', async () => {
    const XLSXNS = await import('xlsx')
    const wb = { sheets: [] }
    addSheet(XLSXNS, wb, 'A/B:C*D?E[F]G' + 'x'.repeat(40), [{ a: 1 }])
    expect(wb.sheets[0]).toHaveLength(31)
    expect(wb.sheets[0]).not.toMatch(/[/*?:[\]\\]/)
  })
})
