// @vitest-environment jsdom
// AttendanceMatrix — grid + the phone quick-peek sheet (plan decision D-C).
//
// Worth protecting: the grid still renders every day cell with its present /
// absent meaning; on phones the Badge cell becomes a real button that opens a
// sheet carrying that sewadar's full breakdown, because a 46rem grid in a
// 320px viewport can otherwise only be reached by horizontal scroll.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import AttendanceMatrix from './AttendanceMatrix'

const COLUMNS = ['2026-10-07', '2026-10-08', '2026-10-09']
const ROWS = [
  {
    badge_number: 'A1',
    sewadar_name: 'Ramesh Kumar',
    centre: 'SECTOR-15-A',
    dept_name: 'TRAFFIC',
    presentCount: 2,
    byDate: { '2026-10-07': true, '2026-10-08': false, '2026-10-09': true },
  },
  {
    badge_number: 'A2',
    sewadar_name: 'Sita Devi',
    centre: 'DELHI MC',
    dept_name: 'KITCHEN',
    presentCount: 0,
    byDate: { '2026-10-07': false, '2026-10-08': false, '2026-10-09': false },
  },
]

function stubViewport(width) {
  window.matchMedia = vi.fn((q) => ({
    matches: q.includes('max-width') ? width <= 768 : false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }))
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('AttendanceMatrix', () => {
  it('shows the empty state with no rows', () => {
    stubViewport(1400)
    render(<AttendanceMatrix columns={COLUMNS} rows={[]} />)
    expect(screen.getByText(/No sewadars in this department/)).not.toBeNull()
  })

  it('renders a row per sewadar with name, centre and days', () => {
    stubViewport(1400)
    render(<AttendanceMatrix columns={COLUMNS} rows={ROWS} />)
    expect(screen.getByText('Ramesh Kumar')).not.toBeNull()
    expect(screen.getByText('SECTOR-15-A')).not.toBeNull()
    expect(screen.getByText('2/3')).not.toBeNull()
    expect(screen.getByText('0/3')).not.toBeNull()
  })

  it('marks the highlighted day column', () => {
    stubViewport(1400)
    const { container } = render(<AttendanceMatrix columns={COLUMNS} rows={ROWS} highlightDate="2026-10-08" />)
    expect(container.querySelectorAll('.att-today').length).toBeGreaterThan(0)
  })

  it('desktop: the badge is plain text, no peek affordance', () => {
    stubViewport(1400)
    render(<AttendanceMatrix columns={COLUMNS} rows={ROWS} />)
    expect(screen.queryByRole('button', { name: /day-by-day attendance/ })).toBeNull()
  })

  it('phone: tapping a badge opens the day-by-day peek sheet', () => {
    stubViewport(390)
    render(<AttendanceMatrix columns={COLUMNS} rows={ROWS} />)
    const btn = screen.getByRole('button', { name: /day-by-day attendance for Ramesh Kumar/ })
    fireEvent.click(btn)
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('Ramesh Kumar')
    expect(dialog.textContent).toContain('A1')
    // every day is spelled out in the sheet
    expect(dialog.textContent).toContain('Present')
    expect(dialog.textContent).toContain('Absent')
  })

  it('phone: the legend advertises the peek', () => {
    stubViewport(390)
    render(<AttendanceMatrix columns={COLUMNS} rows={ROWS} />)
    expect(screen.getByText(/Tap a badge/)).not.toBeNull()
  })

  it('phone: the peek sheet closes', () => {
    stubViewport(390)
    render(<AttendanceMatrix columns={COLUMNS} rows={ROWS} />)
    fireEvent.click(screen.getByRole('button', { name: /day-by-day attendance for Sita Devi/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('computes presentCount from byDate when absent', () => {
    stubViewport(1400)
    render(
      <AttendanceMatrix
        columns={COLUMNS}
        rows={[{ ...ROWS[0], presentCount: undefined }]}
      />,
    )
    expect(screen.getByText('2/3')).not.toBeNull()
  })
})