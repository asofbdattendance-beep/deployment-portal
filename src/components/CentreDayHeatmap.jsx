import { splitDayLabel } from '../lib/attendance'

/**
 * CentreDayHeatmap — a centre × sewa-day grid of `present / deployed` cells
 * for the department-incharge dashboard. It reuses the `.att-*` vocabulary
 * that AttendanceMatrix already owns (scroll box, sticky header, pinned first
 * column, present/absent tints, sr-only state) so the two grids read as one
 * family; the only new idea is the `att-partial` tint, because a centre cell
 * is a RATIO rather than a boolean.
 *
 * Colour never carries meaning alone: every cell also has a `title` and an
 * sr-only "n of d present on <date>".
 */

/** Full / partial / none — or plain when the centre has no denominator. */
function heatClass(present, deployed) {
  if (deployed <= 0) return ''
  if (present <= 0) return 'att-absent'
  if (present >= deployed) return 'att-present'
  return 'att-partial'
}

function DayCell({ date, present, deployed }) {
  if (deployed <= 0) {
    return (
      <td className="att-cell" title="Nothing deployed here">
        <span aria-hidden="true" className="att-mark">—</span>
        <span className="sr-only">Nothing deployed here on {date}</span>
      </td>
    )
  }
  return (
    <td className={`att-cell ${heatClass(present, deployed)}`} title={`${present} of ${deployed} present`}>
      <span aria-hidden="true" className="att-mark">{present}/{deployed}</span>
      <span className="sr-only">{present} of {deployed} present on {date}</span>
    </td>
  )
}

export default function CentreDayHeatmap({ columns = [], rows = [], totals = null, emptyText = 'No centre has previsit sewa yet.', scope = 'visit' }) {
  // Scope switch mirrors the matrix card: 'visit' end totals read
  // "scanned on at least one visit day", 'day' reads "scanned today".
  const everTitle = (present, deployed) => `${present} of ${deployed} scanned ${scope === 'day' ? 'today' : 'on at least one visit day'}`
  if (!columns.length || !rows.length) {
    return (
      <div className="att-matrix">
        <div className="att-empty">{emptyText}</div>
      </div>
    )
  }

  return (
    <div className="att-matrix">
      <div className="att-legend" aria-hidden="true">
        <span className="att-legend-item"><span className="att-swatch att-present" /> All present</span>
        <span className="att-legend-item"><span className="att-swatch att-partial" /> Partly present</span>
        <span className="att-legend-item"><span className="att-swatch att-absent" /> None present</span>
      </div>

      <div className="att-scroll" tabIndex={0} role="region" aria-label="Scrollable centre attendance grid">
        <table
          className="att-table att-table-centre"
          /* The only floor on this grid. `.att-table` asks for 46rem (736px),
             which forces a horizontal scroll whatever the data says; fixed
             layout below sizes columns as shares of the box instead, so the
             floor only has to guarantee each cell its real content width —
             36% centre, 15% total, and ≥~30px per sewa day after those two
             are served. Below it the grid scrolls (unavoidable), above it the
             table fills the box with no scroll at all. Scales with the column
             count. */
          style={{ minWidth: `${Math.max(300, columns.length * 62)}px` }}
        >
          <caption>Present by centre and sewa day</caption>
          <thead>
            <tr>
              <th className="att-col-badge" scope="col">Centre</th>
              {columns.map((d) => {
                const { mon, num } = splitDayLabel(d)
                return (
                  <th key={d} className="att-day" scope="col" title={d}>
                    <span className="att-day-wd" aria-hidden="true">{mon}</span>
                    <span className="att-day-num" aria-hidden="true">{num}</span>
                    <span className="sr-only">{d}</span>
                  </th>
                )
              })}
              <th className="att-days" scope="col">Total</th>
            </tr>
          </thead>

          <tbody>
            {rows.map((r) => (
              <tr key={r.centre}>
                <th className="att-col-badge" scope="row">
                  <span className="att-name">{r.centre}</span>
                </th>
                {columns.map((d) => (
                  <DayCell key={d} date={d} present={r.byDate[d] || 0} deployed={r.deployed} />
                ))}
                <td className="att-days" title={r.everPresent != null ? everTitle(r.everPresent, r.everDeployed) : `${r.presentTotal} badge-days of ${r.possible} possible`}>{r.deployed > 0 ? (r.everPresent != null ? `${r.everPresent}/${r.everDeployed}` : `${r.presentTotal}/${r.possible}`) : '—'}</td>
              </tr>
            ))}

            {totals && (
              <tr className="att-total-row">
                <th className="att-col-badge" scope="row">All centres</th>
                {columns.map((d) => {
                  const p = totals.byDate[d] || 0
                  return (
                    <td key={d} className="att-cell" title={`${p} of ${totals.deployed} present`}>
                      <span aria-hidden="true" className="att-mark">{p}/{totals.deployed}</span>
                      <span className="sr-only">{p} of {totals.deployed} present on {d}</span>
                    </td>
                  )
                })}
                <td className="att-days" title={totals.everPresent != null ? everTitle(totals.everPresent, totals.everDeployed) : `${totals.present} badge-days of ${totals.possible} possible`}>{totals.everPresent != null ? `${totals.everPresent}/${totals.everDeployed}` : `${totals.present}/${totals.possible}`}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
