// @vitest-environment jsdom
// ExportButton — one press downloads on desktop, opens the share sheet on
// phones; the render contract mirrors the AttendancePage header button.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import ExportButton from './ExportButton'
import { exportWorkbook, exportWorkbookBlob } from '../lib/excel'

vi.mock('../lib/excel', () => ({
  exportWorkbook: vi.fn(),
  exportWorkbookBlob: vi.fn(),
}))

const mobileState = { value: false }
vi.mock('../hooks/useMediaQuery', () => ({
  useIsMobile: () => mobileState.value,
}))

const buildSheets = () => [{ name: 'Day', rows: [{ a: 1 }] }]

beforeEach(() => {
  vi.clearAllMocks()
  mobileState.value = false
})

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('ExportButton', () => {
  it('desktop click writes the workbook directly', async () => {
    exportWorkbook.mockResolvedValue(1)
    render(<ExportButton filename="day.xlsx" buildSheets={buildSheets} />)
    fireEvent.click(screen.getByRole('button', { name: /export excel/i }))
    await waitFor(() => expect(exportWorkbook).toHaveBeenCalledWith('day.xlsx', [{ name: 'Day', rows: [{ a: 1 }] }], { keepEmpty: false }))
  })

  it('respects the disabled prop (e.g. rows not current)', () => {
    render(<ExportButton filename="day.xlsx" buildSheets={buildSheets} disabled />)
    expect(screen.getByRole('button', { name: /export excel/i }).disabled).toBe(true)
  })

  it('mobile click opens the share sheet instead of downloading', async () => {
    mobileState.value = true
    exportWorkbookBlob.mockResolvedValue({ blob: new Blob(['x']), written: 1 })
    render(<ExportButton filename="day.xlsx" buildSheets={buildSheets} />)
    fireEvent.click(screen.getByRole('button', { name: /export excel/i }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: /export report/i })).toBeTruthy())
    expect(exportWorkbook).not.toHaveBeenCalled()
  })

  it('reports the desktop row count so the page can announce it', async () => {
    exportWorkbook.mockResolvedValue(0)
    const onExported = vi.fn()
    render(<ExportButton filename="day.xlsx" buildSheets={buildSheets} onExported={onExported} />)
    fireEvent.click(screen.getByRole('button', { name: /export excel/i }))
    await waitFor(() => expect(onExported).toHaveBeenCalledWith(0))
  })

  it('reports desktop failures so the page can announce them', async () => {
    exportWorkbook.mockRejectedValue(new Error('boom'))
    const onExportError = vi.fn()
    render(<ExportButton filename="day.xlsx" buildSheets={buildSheets} onExportError={onExportError} />)
    fireEvent.click(screen.getByRole('button', { name: /export excel/i }))
    await waitFor(() => expect(onExportError).toHaveBeenCalled())
    expect(onExportError.mock.calls[0][0].message).toBe('boom')
  })
})
