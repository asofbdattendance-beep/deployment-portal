import { splitDayLabel } from '../lib/attendance'

/**
 * Per-sewadar × per-day presence grid. Purely presentational: `rows` come from
 * `buildAttendanceMatrixFromDayBadges` in src/lib/attendance.js and already carry the
 * ordered `columns` dates in their `byDate` maps (plus `presentCount`).
 *
 * The legend is `aria-hidden`: it restates what every day cell already
 * announces via its `title` + screen-reader label, so exposing it would only
 * double-announce. The `Days` column reuses the existing `.attendance-pill`
 * skin (`ok` = full house, `muted` = none yet, `att-mid` otherwise).
 *
 * @param {{columns?: string[], rows?: Array<object>, highlightDate?: string|null}} props
 */
export default function AttendanceMatrix({ columns = [], rows = [], highlightDate = null }) {
  const cols = Array.isArray(columns) ? columns : []
  const list = Array.isArray(rows) ? rows : []
  const total = cols.length
  if (list.length === 0) {
    return (
      <div className="att-matrix">
        <div className="att-empty">No sewadars in this department for the visit.</div>
      </div>
    )
  }
  return (
    <div className="att-matrix">
      <div className="att-legend" aria-hidden="true">
        <span className="att-legend-item">
          <span className="att-swatch att-present" />
          Present
        </span>
        <span className="att-legend-item">
          <span className="att-swatch att-absent" />
          Absent
        </span>
      </div>
      <div className="att-scroll" tabIndex={0} role="region" aria-label="Scrollable attendance grid">
        <table className="att-table">
          <caption>Daily attendance by sewadar</caption>
          <thead>
            <tr>
              <th scope="col" className="att-col-badge">Badge</th>
              <th scope="col" className="att-col-name">Name</th>
              <th scope="col">Centre</th>
              <th scope="col">Dept</th>
              {cols.map((date) => {
                const { mon, num } = splitDayLabel(date)
                const today = highlightDate != null && date === highlightDate
                return (
                  <th
                    key={date}
                    scope="col"
                    title={date}
                    className={`att-day${today ? ' att-today' : ''}`}
                  >
                    <span className="att-day-wd">{mon}</span>
                    <span className="att-day-num">{num}</span>
                  </th>
                )
              })}
              <th scope="col" className="att-days" title="Days present across the visit">Days</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => {
              const presentCount = typeof r.presentCount === 'number'
                ? r.presentCount
                : cols.filter((date) => !!r.byDate?.[date]).length
              const pill = presentCount >= total && total > 0
                ? 'ok'
                : presentCount === 0
                  ? 'muted'
                  : 'att-mid'
              return (
                <tr key={r.badge_number}>
                  <td className="att-col-badge att-badge">{r.badge_number}</td>
                  <td className="att-col-name att-name">{r.sewadar_name}</td>
                  <td>{r.centre}</td>
                  <td>{r.dept_name}</td>
                  {cols.map((date) => {
                    const present = !!r.byDate?.[date]
                    return (
                      <td
                        key={date}
                        title={present ? 'Present' : 'Absent'}
                        className={`att-cell ${present ? 'att-present' : 'att-absent'}`}
                      >
                        <span aria-hidden="true" className="att-mark">{present ? '✓' : '−'}</span>
                        <span className="sr-only">{present ? 'Present' : 'Absent'}</span>
                      </td>
                    )
                  })}
                  <td className="att-days">
                    <span className={`attendance-pill ${pill}`}>{presentCount}/{total}</span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
