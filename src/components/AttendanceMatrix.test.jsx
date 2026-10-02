import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import AttendanceMatrix from './AttendanceMatrix'
import { buildAttendanceMatrixFromDayBadges } from '../lib/attendance'

// End-to-end shape test: logic builds the grid, the component renders it.
// One present sewadar (1 of 2 days) + one absentee over a 2-day strip, built
// through the dayBadges shaper (present + absent lists per date).
function fixture() {
  const columns = ['2026-10-07', '2026-10-08']
  const dayBadges = {
    '2026-10-07': {
      present: [{ badge_number: 'B1', sewadar_name: 'Asha', sewadar_centre: 'DELHI', dept_name: 'Traffic', is_vss: false }],
      absent: [{ badge_number: 'B2', sewadar_name: 'Zed', sewadar_centre: 'NOIDA', dept_name: 'Medical', is_vss: false }],
    },
    '2026-10-08': {
      present: [],
      absent: [
        { badge_number: 'B1', sewadar_name: 'Asha', sewadar_centre: 'DELHI', dept_name: 'Traffic', is_vss: false },
        { badge_number: 'B2', sewadar_name: 'Zed', sewadar_centre: 'NOIDA', dept_name: 'Medical', is_vss: false },
      ],
    },
  }
  return buildAttendanceMatrixFromDayBadges(dayBadges, columns)
}

describe('AttendanceMatrix', () => {
  it('renders one present cell and three absent cells across the 2x2 grid', () => {
    const { columns, rows } = fixture()
    const html = renderToStaticMarkup(createElement(AttendanceMatrix, { columns, rows }))

    // 1 present + 3 absent day cells; meaning stays on title + sr-only text.
    expect(html.match(/att-cell att-present/g) || []).toHaveLength(1)
    expect(html.match(/att-cell att-absent/g) || []).toHaveLength(3)
    expect(html.match(/title="Present"/g) || []).toHaveLength(1)
    expect(html.match(/title="Absent"/g) || []).toHaveLength(3)
  })

  it('renders both sewadars plus the date headers and a caption', () => {
    const { columns, rows } = fixture()
    expect(rows).toHaveLength(2)
    const html = renderToStaticMarkup(createElement(AttendanceMatrix, { columns, rows }))

    expect(html).toContain('Asha')
    expect(html).toContain('Zed')
    // UTC-derived stacked labels (short month over date number) with the
    // full date on hover.
    expect(html).toContain('att-day-wd">Oct')
    expect(html).toContain('att-day-num">7')
    expect(html).toContain('att-day-num">8')
    expect(html).toContain('title="2026-10-07"')
    expect(html).toContain('<caption>')
    expect(html).toContain('Badge')
  })

  it('shows a legend and a Days summary column', () => {
    const { columns, rows } = fixture()
    const html = renderToStaticMarkup(createElement(AttendanceMatrix, { columns, rows }))

    expect(html).toContain('att-legend')
    expect(html).toContain('Days')
    // B1 present 1 of 2 days, B2 none.
    expect(html).toContain('>1/2<')
    expect(html).toContain('>0/2<')
  })

  it('highlights the selected scan day column', () => {
    const { columns, rows } = fixture()
    const html = renderToStaticMarkup(
      createElement(AttendanceMatrix, { columns, rows, highlightDate: '2026-10-08' }),
    )
    expect(html.match(/att-today/g) || []).toHaveLength(1)
  })

  it('renders an empty state instead of a headless table', () => {
    const html = renderToStaticMarkup(createElement(AttendanceMatrix, { columns: ['2026-10-07'], rows: [] }))
    expect(html).toContain('att-empty')
    expect(html).not.toContain('<table')
  })
})
