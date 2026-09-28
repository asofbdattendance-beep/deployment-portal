// @vitest-environment jsdom
// RecentScansTable — the compact "my last N scans" table on the scanner pages.
//
// The behaviour worth protecting is STRUCTURAL, not cosmetic. This table
// exists to opt OUT of the global mobile card-collapse in src/index.css
// (~line 287), where `.table, .table tbody, .table tr, .table td` are forced
// to `display: block` below 640px and every row stacks into a card. A
// regression that renames `scans-table` back to `table` would silently undo
// the one thing this component was built for, so the class names are asserted
// alongside the content.
//
// No @testing-library/jest-dom in this project, so every assertion below is a
// plain textContent / getAttribute / toBeNull check.
import { describe, it, expect, afterEach } from 'vitest'
import React from 'react'
import { render, screen, within, cleanup } from '@testing-library/react'
import RecentScansTable from './RecentScansTable'

// This project's vitest config has no `globals: true`, so testing-library's
// auto-cleanup never registers itself and every render would leak into the
// next test — `getByRole('table')` would then match a growing pile of tables.
afterEach(cleanup)

const DEPTS = new Map([
  ['d-1', 'Lekhwal'],
  ['d-2', 'Medical'],
])

// Newest first, mirroring what the caller hands us.
const ROWS = [
  { id: 's1', badge_number: 'FB5971GA0001', sewadar_name: 'Ramesh Sharma', sewadar_dept: 'd-1', in_time: '09:12', out_time: '17:40', is_vss: false, undeployed_scan: false },
  { id: 's2', badge_number: 'VS0001', sewadar_name: 'Anita Verma', sewadar_dept: 'd-2', in_time: '09:20', out_time: null, is_vss: true, undeployed_scan: false },
  { id: 's3', badge_number: 'BH7788', sewadar_name: 'Suresh Patil', sewadar_dept: null, in_time: '10:02', out_time: '12:30', is_vss: false, undeployed_scan: true },
]

// The thead row is the first `row` role; data rows follow in DOM order.
function dataRows() {
  return within(screen.getByRole('table')).getAllByRole('row').slice(1)
}

describe('RecentScansTable', () => {
  it('renders a header cell for each of the five columns', () => {
    render(<RecentScansTable rows={ROWS} deptNameById={DEPTS} />)
    const headers = within(screen.getByRole('table'))
      .getAllByRole('columnheader')
      .map((h) => h.textContent)
    expect(headers).toEqual(['Badge', 'Name', 'Dept', 'In', 'Out'])
  })

  it('gives every column header a scope so screen readers can pair it with its cells', () => {
    render(<RecentScansTable rows={ROWS} deptNameById={DEPTS} />)
    const headers = within(screen.getByRole('table')).getAllByRole('columnheader')
    expect(headers).toHaveLength(5)
    headers.forEach((h) => expect(h.getAttribute('scope')).toBe('col'))
  })

  it('renders one row per scan, plus the single header row', () => {
    render(<RecentScansTable rows={ROWS} deptNameById={DEPTS} />)
    expect(screen.getAllByRole('row')).toHaveLength(ROWS.length + 1)
  })

  it('resolves the department name from its uuid and never leaks the uuid', () => {
    render(<RecentScansTable rows={ROWS} deptNameById={DEPTS} />)
    const rows = dataRows()
    expect(within(rows[0]).getByText('Lekhwal')).toBeTruthy()
    expect(rows[0].textContent).not.toContain('d-1')
  })

  it('renders an em dash in the Dept cell when the row has no department at all', () => {
    render(<RecentScansTable rows={ROWS} deptNameById={DEPTS} />)
    // row 3 has sewadar_dept: null
    expect(within(dataRows()[2]).getByText('—')).toBeTruthy()
  })

  it('renders an em dash in the Dept cell when the department id is missing from the map', () => {
    render(
      <RecentScansTable
        rows={[{ id: 's9', badge_number: 'FB9', sewadar_name: 'Test', sewadar_dept: 'nope', in_time: '11:00', out_time: null }]}
        deptNameById={DEPTS}
      />
    )
    expect(within(dataRows()[0]).getAllByRole('cell')[2].textContent).toBe('—')
  })

  it('truncates to limit rows when limit is given', () => {
    render(<RecentScansTable rows={ROWS} deptNameById={DEPTS} limit={2} />)
    expect(screen.getAllByRole('row')).toHaveLength(3) // 2 data rows + header
    expect(screen.getByText('Ramesh Sharma')).toBeTruthy()
    expect(screen.queryByText('Suresh Patil')).toBeNull()
  })

  it('renders emptyMessage in a full-width cell and no data rows', () => {
    render(<RecentScansTable rows={[]} deptNameById={DEPTS} emptyMessage="No scans by you yet today" />)
    const cell = screen.getByText('No scans by you yet today')
    expect(cell.tagName).toBe('TD')
    expect(cell.getAttribute('colspan')).toBe('5')
    // header + the single empty-state row
    expect(screen.getAllByRole('row')).toHaveLength(2)
  })

  it('shows the VSS and Flagged pills only on the rows that carry those flags', () => {
    render(<RecentScansTable rows={ROWS} deptNameById={DEPTS} />)
    const rows = dataRows()

    expect(within(rows[1]).getByText('VSS')).toBeTruthy()
    expect(within(rows[0]).queryByText('VSS')).toBeNull()
    expect(within(rows[2]).queryByText('VSS')).toBeNull()

    expect(within(rows[2]).getByText('Flagged')).toBeTruthy()
    expect(within(rows[0]).queryByText('Flagged')).toBeNull()
    expect(within(rows[1]).queryByText('Flagged')).toBeNull()

    expect(screen.getAllByText('VSS')).toHaveLength(1)
    expect(screen.getAllByText('Flagged')).toHaveLength(1)
  })

  it('renders an em dash rather than an empty cell when sewadar_name is blank', () => {
    render(
      <RecentScansTable
        rows={[{ id: 'x', badge_number: 'FB1', sewadar_name: '', sewadar_dept: 'd-1', in_time: '09:00', out_time: null }]}
        deptNameById={DEPTS}
      />
    )
    const cells = within(dataRows()[0]).getAllByRole('cell')
    expect(cells[1].textContent).toBe('—')
  })

  it('renders an em dash in the Out cell while a session is still open', () => {
    render(<RecentScansTable rows={ROWS} deptNameById={DEPTS} />)
    const rows = dataRows()
    const outCell = (row) => within(row).getAllByRole('cell')[4].textContent
    expect(outCell(rows[0])).toBe('17:40') // closed
    expect(outCell(rows[1])).toBe('—')   // still in
  })

  it('uses the new scans-table / scans-wrap classes and NOT the global .table card-collapse', () => {
    const { container } = render(<RecentScansTable rows={ROWS} deptNameById={DEPTS} />)
    const table = container.querySelector('table')
    expect(table.getAttribute('class')).toBe('scans-table')
    // the collapse trigger is the literal `.table` class
    expect(table.classList.contains('table')).toBe(false)

    const wrap = container.querySelector('.scans-wrap')
    expect(wrap).toBeTruthy()
    expect(wrap.classList.contains('table-wrap-sticky')).toBe(false)
  })

  it('exposes the table and its scroll container to assistive tech', () => {
    const { container } = render(<RecentScansTable rows={ROWS} deptNameById={DEPTS} />)
    // the table is named (via the sr-only caption)
    expect(screen.getByRole('table').getAttribute('aria-label') || screen.getByRole('table').textContent).toBeTruthy()
    expect(container.querySelector('caption')).toBeTruthy()
    expect(container.querySelector('caption').className).toBe('sr-only')

    // a horizontally scrollable region must be reachable by keyboard
    const wrap = container.querySelector('.scans-wrap')
    expect(wrap.getAttribute('role')).toBe('region')
    expect(wrap.getAttribute('tabindex')).toBe('0')
    expect(wrap.getAttribute('aria-label')).toBeTruthy()
  })
})
