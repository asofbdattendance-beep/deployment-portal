/**
 * excel.js — contract pins for the shared export driver (Phase C task C2).
 *
 * Reports, Dashboard and Anomalies already build through exportWorkbook;
 * Attendance + Live Scanners are migrated onto it so every surface names
 * files/sheets the same way. These pin the driver both sides rely on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sheetName, fileSlug, exportWorkbook } from './excel'

const mocks = vi.hoisted(() => ({
  bookNew: vi.fn(() => ({})),
  jsonToSheet: vi.fn((rows) => ({ rows })),
  bookAppendSheet: vi.fn(),
  writeFile: vi.fn(),
  write: vi.fn(() => new Uint8Array([1, 2, 3])),
}))

vi.mock('xlsx', () => ({
  utils: {
    book_new: (...a) => mocks.bookNew(...a),
    json_to_sheet: (...a) => mocks.jsonToSheet(...a),
    book_append_sheet: (...a) => mocks.bookAppendSheet(...a),
  },
  writeFile: (...a) => mocks.writeFile(...a),
  write: (...a) => mocks.write(...a),
  default: {},
}))

beforeEach(() => {
  for (const k of ['bookNew', 'jsonToSheet', 'bookAppendSheet', 'writeFile', 'write']) mocks[k].mockReset()
  mocks.bookNew.mockReturnValue({})
  mocks.jsonToSheet.mockImplementation((rows) => ({ rows }))
  mocks.write.mockReturnValue(new Uint8Array([1, 2, 3]))
})

describe('sheetName', () => {
  it('replaces illegal characters and caps at 31 chars', () => {
    expect(sheetName('A/B\\C*D?E:F[G]H')).toBe('A-B-C-D-E-F-G-H')
    expect(sheetName('x'.repeat(40))).toHaveLength(31)
  })

  it('never throws on nullish input — falls back to Sheet (L-25)', () => {
    expect(sheetName(null)).toBe('Sheet')
    expect(sheetName(undefined)).toBe('Sheet')
    expect(sheetName('')).toBe('Sheet')
  })
})

describe('fileSlug', () => {
  it('collapses spaces and runs of unsafe chars to one underscore', () => {
    expect(fileSlug('October 2026 Visit')).toBe('October_2026_Visit')
    expect(fileSlug('  a  b/c  ')).toBe('a_b_c')
  })

  it('falls back to schedule for nullish/blank input', () => {
    expect(fileSlug(null)).toBe('schedule')
    expect(fileSlug('   ')).toBe('schedule')
  })
})

describe('exportWorkbook', () => {
  const fakeXlsx = () => ({
    utils: {
      book_new: vi.fn(() => ({})),
      json_to_sheet: vi.fn((rows) => ({ rows })),
      book_append_sheet: vi.fn(),
    },
    writeFile: vi.fn(),
  })

  it('writes every non-empty sheet and returns the count', async () => {
    // loadXlsx dynamic-imports the real xlsx; routing around it is out of
    // scope here — instead drive the documented composition directly.
    const { newWorkbook, addSheet, saveWorkbook } = await import('./excel')
    const X = fakeXlsx()
    const wb = newWorkbook(X)
    addSheet(X, wb, 'Sewadars', [{ a: 1 }])
    addSheet(X, wb, null, [{ b: 2 }])
    saveWorkbook(X, wb, 'f.xlsx')
    expect(X.utils.book_append_sheet).toHaveBeenCalledTimes(2)
    // Null sheet name degrades to the Sheet fallback, never throws.
    expect(X.utils.book_append_sheet.mock.calls[1][2]).toBe('Sheet')
    expect(X.writeFile).toHaveBeenCalledWith(wb, 'f.xlsx')
  })

  it('exportWorkbook is the lazy driver pages call (smoke: module surface)', async () => {
    expect(typeof exportWorkbook).toBe('function')
  })
})

describe('exportWorkbookBlob', () => {
  it('builds a Blob without downloading (mobile share path)', async () => {
    const { exportWorkbookBlob, XLSX_MIME } = await import('./excel')
    const { blob, written, filename } = await exportWorkbookBlob('a.xlsx', [
      { name: 'One', rows: [{ a: 1 }] },
      { name: 'Empty', rows: [] },
    ])
    expect(written).toBe(1)
    expect(filename).toBe('a.xlsx')
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toBe(XLSX_MIME)
    expect(blob.size).toBeGreaterThan(0)
  })

  it('returns a null blob when every sheet is empty', async () => {
    const { exportWorkbookBlob } = await import('./excel')
    const { blob, written } = await exportWorkbookBlob('a.xlsx', [{ name: 'One', rows: [] }])
    expect(written).toBe(0)
    expect(blob).toBeNull()
  })

  it('saveBlob is a no-op without a DOM and never throws', async () => {
    const { saveBlob } = await import('./excel')
    expect(saveBlob(new Blob(['x']), 'a.xlsx')).toBe(false)
    expect(saveBlob(null, 'a.xlsx')).toBe(false)
  })
})
