// @vitest-environment jsdom
// useExport + ExportSheet.
//
// Worth protecting: prepare() surfaces empty workbooks as "nothing to
// export" (never an empty sheet), build failures become buildError, and
// deliver() routes through the share/download helper. The sheet renders
// nothing when closed and exposes Share/Save/Close when a file is ready.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { renderHook, act } from '@testing-library/react'
import { useExport } from '../../hooks/useExport'
import ExportSheet from './ExportSheet'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('useExport', () => {
  it('prepares a file from a builder', async () => {
    const { result } = renderHook(() => useExport())
    const blob = new Blob(['x'], { type: 'application/octet-stream' })
    let out
    await act(async () => {
      out = await result.current.prepare(async () => ({ blob, filename: 'a.xlsx' }))
    })
    expect(out.filename).toBe('a.xlsx')
    expect(result.current.file.filename).toBe('a.xlsx')
    expect(result.current.buildError).toBe('')
  })

  it('reports empty workbooks instead of opening a sheet', async () => {
    const { result } = renderHook(() => useExport())
    await act(async () => {
      await result.current.prepare(async () => ({ blob: null }))
    })
    expect(result.current.file).toBeNull()
    expect(result.current.buildError).toMatch(/Nothing to export/)
  })

  it('reports build failures', async () => {
    const { result } = renderHook(() => useExport())
    await act(async () => {
      await result.current.prepare(async () => { throw new Error('boom') })
    })
    expect(result.current.file).toBeNull()
    expect(result.current.buildError).toBe('boom')
  })

  it('reset clears state', async () => {
    const { result } = renderHook(() => useExport())
    const blob = new Blob(['x'])
    await act(async () => {
      await result.current.prepare(async () => ({ blob, filename: 'a.xlsx' }))
    })
    act(() => { result.current.reset() })
    expect(result.current.file).toBeNull()
  })
})

describe('ExportSheet', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <ExportSheet open={false} onClose={() => {}} filename="a.xlsx" file={null} building={false} />
    )
    expect(container.textContent).toBe('')
  })

  it('shows the building state', () => {
    render(<ExportSheet open onClose={() => {}} filename="a.xlsx" file={null} building />)
    expect(screen.getByRole('dialog', { name: 'Export report' })).toBeTruthy()
    expect(screen.getByText('Preparing workbook…')).toBeTruthy()
  })

  it('shows the error state with retry', () => {
    const onRetry = vi.fn()
    render(
      <ExportSheet open onClose={() => {}} filename="a.xlsx" file={null} building={false} buildError="Nothing to export for the current filters." onRetry={onRetry} />
    )
    expect(screen.getByText('Nothing to export for the current filters.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('offers Save and Close when a file is ready', () => {
    const onClose = vi.fn()
    const onDeliver = vi.fn()
    render(
      <ExportSheet
        open onClose={onClose} filename="a.xlsx"
        file={new Blob(['x'])} building={false}
        delivering={false} deliveredVia={null} onDeliver={onDeliver}
      />
    )
    expect(screen.getByText('a.xlsx')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Save to device/ }))
    expect(onDeliver).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
