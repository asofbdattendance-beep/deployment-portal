// @vitest-environment jsdom
// DataTable — skeleton while loading, teaching hint when empty, labelled
// sticky table otherwise (data-label on every td feeds the mobile cards).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import DataTable from './DataTable'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const COLUMNS = [
  { key: 'centre', label: 'Centre' },
  { key: 'badge', label: 'Badge', mono: true },
  { key: 'days', label: 'Days', numeric: true },
]
const ROWS = [
  { id: 'a', centre: 'Bhati', badge: 'FB1', days: 5 },
  { id: 'b', centre: 'Rohini', badge: 'FB2', days: 3 },
]

describe('DataTable', () => {
  it('shows skeleton rows while loading, never a spinner', () => {
    const { container } = render(<DataTable columns={COLUMNS} loading skeletonRows={4} />)
    // Shared Skeleton (variant="table") speaks .sk-*, not the hand-rolled .skeleton divs.
    expect(container.querySelector('.sk-table')).toBeTruthy()
    expect(container.querySelectorAll('.sk-table .sk-row').length).toBe(4)
    expect(container.querySelector('table')).toBeNull()
    expect(container.querySelector('.spin')).toBeNull()
  })

  it('shows the teaching hint when there are no rows', () => {
    render(<DataTable columns={COLUMNS} rows={[]} emptyHint="Nothing deployed yet." />)
    expect(screen.getByText('Nothing deployed yet.')).toBeTruthy()
  })

  it('renders the sticky labelled table with data-labels on every cell', () => {
    const { container } = render(<DataTable columns={COLUMNS} rows={ROWS} label="Deployed" />)
    const table = container.querySelector('table.table.table-sticky')
    expect(table).toBeTruthy()
    expect(table.getAttribute('aria-label')).toBe('Deployed')
    const cells = container.querySelectorAll('tbody td')
    expect(cells).toHaveLength(6)
    for (const td of cells) expect(td.getAttribute('data-label')).toBeTruthy()
    expect(screen.getByText('Bhati')).toBeTruthy()
  })

  it('right-aligns numeric cells and monos the identifier cells', () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} />)
    const days = screen.getByText('5').closest('td')
    expect(days.style.textAlign).toBe('right')
    const badge = screen.getByText('FB1').closest('td')
    expect(badge.style.fontFamily).toBe('monospace')
  })

  it('supports custom renderers and custom row keys', () => {
    const cols = [{ key: 'centre', label: 'Centre', render: (r) => <strong>{r.centre}!</strong> }]
    const { container } = render(
      <DataTable columns={cols} rows={ROWS} rowKey={(r) => `row-${r.id}`} sticky={false} />
    )
    expect(screen.getByText('Bhati!')).toBeTruthy()
    expect(container.querySelector('table').className).not.toContain('table-sticky')
  })
})

describe('DataTable onRowClick', () => {
  it('renders static rows with no button semantics when onRowClick is absent', () => {
    const { container } = render(<DataTable columns={COLUMNS} rows={ROWS} />)
    const trs = container.querySelectorAll('tbody tr')
    expect(trs.length).toBe(2)
    for (const tr of trs) {
      expect(tr.getAttribute('role')).toBeNull()
      expect(tr.classList.contains('row-clickable')).toBe(false)
    }
  })

  it('makes rows keyboard-operable buttons that report (row, index)', async () => {
    const onRowClick = vi.fn()
    const { container } = render(<DataTable columns={COLUMNS} rows={ROWS} onRowClick={onRowClick} />)
    const trs = container.querySelectorAll('tbody tr.row-clickable[role="button"]')
    expect(trs.length).toBe(2)
    expect(trs[0].getAttribute('tabindex')).toBe('0')
    fireEvent.click(trs[1])
    expect(onRowClick).toHaveBeenCalledTimes(1)
    expect(onRowClick).toHaveBeenCalledWith(ROWS[1], 1)
    fireEvent.keyDown(trs[0], { key: 'Enter' })
    fireEvent.keyDown(trs[0], { key: ' ' })
    fireEvent.keyDown(trs[0], { key: 'Tab' })
    expect(onRowClick).toHaveBeenCalledTimes(3)
    expect(onRowClick).toHaveBeenLastCalledWith(ROWS[0], 0)
  })
})
