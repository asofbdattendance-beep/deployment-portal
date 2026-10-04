// @vitest-environment jsdom
// useExcelExport — desktop writes directly, phones go through the share
// sheet; failures reset the spinner and propagate so the page can toast.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useExcelExport } from './useExcelExport'
import { exportWorkbook, exportWorkbookBlob } from '../lib/excel'

vi.mock('../lib/excel', () => ({
  exportWorkbook: vi.fn(),
  exportWorkbookBlob: vi.fn(),
}))

const mobileState = { value: false }
vi.mock('./useMediaQuery', () => ({
  useIsMobile: () => mobileState.value,
}))

const SHEETS = [{ name: 'Day', rows: [{ a: 1 }] }]
const buildSheets = () => SHEETS

beforeEach(() => {
  vi.clearAllMocks()
  mobileState.value = false
})

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('useExcelExport', () => {
  it('desktop press writes the workbook and reports the count', async () => {
    exportWorkbook.mockResolvedValue(2)
    const { result } = renderHook(() => useExcelExport({ filename: 'f.xlsx', buildSheets }))
    let written
    await act(async () => { written = await result.current.onExportPress() })
    expect(exportWorkbook).toHaveBeenCalledWith('f.xlsx', SHEETS, { keepEmpty: false })
    expect(exportWorkbookBlob).not.toHaveBeenCalled()
    expect(written).toBe(2)
    expect(result.current.exporting).toBe(false)
    expect(result.current.sheetOpen).toBe(false)
  })

  it('a failed desktop export resets the spinner and rethrows for the page toast', async () => {
    exportWorkbook.mockRejectedValue(new Error('Export failed'))
    const { result } = renderHook(() => useExcelExport({ filename: 'f.xlsx', buildSheets }))
    await act(async () => { await expect(result.current.onExportPress()).rejects.toThrow('Export failed') })
    expect(result.current.exporting).toBe(false)
  })

  it('mobile press opens the sheet and prepares the blob', async () => {
    mobileState.value = true
    exportWorkbookBlob.mockResolvedValue({ blob: new Blob(['x']), written: 1 })
    const { result } = renderHook(() => useExcelExport({ filename: 'f.xlsx', buildSheets }))
    await act(async () => { await result.current.onExportPress() })
    expect(exportWorkbook).not.toHaveBeenCalled()
    expect(result.current.sheetOpen).toBe(true)
    expect(result.current.mobile.file).toBeTruthy()
  })

  it('mobile press with nothing to export surfaces the shared empty error', async () => {
    mobileState.value = true
    exportWorkbookBlob.mockResolvedValue({ blob: null, written: 0 })
    const { result } = renderHook(() => useExcelExport({ filename: 'f.xlsx', buildSheets }))
    await act(async () => { await result.current.onExportPress() })
    expect(result.current.mobile.file).toBeNull()
    expect(result.current.mobile.buildError).toBe('Nothing to export for the current filters.')
  })

  it('closeSheet closes and resets the mobile state', async () => {
    mobileState.value = true
    exportWorkbookBlob.mockResolvedValue({ blob: null, written: 0 })
    const { result } = renderHook(() => useExcelExport({ filename: 'f.xlsx', buildSheets }))
    await act(async () => { await result.current.onExportPress() })
    expect(result.current.mobile.buildError).toBeTruthy()
    act(() => { result.current.closeSheet() })
    expect(result.current.sheetOpen).toBe(false)
    expect(result.current.mobile.buildError).toBe('')
  })
})
