import Skeleton from './mobile/Skeleton'

/**
 * DataTable — the one table every centre-wise report shares.
 *
 * Render contract copied from the AttendancePage tables: `.table-wrap` (+
 * `.table-wrap-sticky` scrollbox) around `table.table` (+ `.table-sticky`
 * pinned header). Every `td` carries `data-label` — the ≤768px CSS turns
 * rows into labelled cards off that attribute, so a column WITHOUT a label
 * renders labelless on phones (see index.css "Responsive tables → cards").
 * Numeric cells right-align; `.table tbody td` already sets tabular-nums.
 *
 * @param {object} props
 * @param {Array<{key:string,label:string,numeric?:boolean,mono?:boolean,render?:(row:any)=>React.ReactNode}>} props.columns
 * @param {Array} [props.rows=[]]
 * @param {(row:any,index:number)=>string|number} [props.rowKey]
 * @param {boolean} [props.loading=false]   skeleton rows, never a spinner
 * @param {number} [props.skeletonRows=6]
 * @param {string} [props.emptyHint='No rows for the current filters.']
 * @param {boolean} [props.sticky=true]
 * @param {string} [props.label]             accessible name for the table
 */
export default function DataTable({
  columns,
  rows = [],
  rowKey,
  loading = false,
  skeletonRows = 6,
  emptyHint = 'No rows for the current filters.',
  sticky = true,
  label,
}) {
  if (loading) return <Skeleton variant="table" rows={skeletonRows} />
  if (!rows.length) {
    return (
      <div className="empty-text" style={{ textAlign: 'center', padding: '1.5rem 1rem' }}>
        {emptyHint}
      </div>
    )
  }
  const keyOf = rowKey || ((r, i) => r?.id ?? r?.key ?? i)
  return (
    <div className={`table-wrap${sticky ? ' table-wrap-sticky' : ''}`}>
      <table className={`table${sticky ? ' table-sticky' : ''}`} aria-label={label}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" style={c.numeric ? { textAlign: 'right' } : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={keyOf(r, i)}>
              {columns.map((c) => (
                <td
                  key={c.key}
                  data-label={c.label}
                  style={{
                    ...(c.numeric ? { textAlign: 'right' } : null),
                    ...(c.mono ? { fontFamily: 'monospace' } : null),
                  }}
                >
                  {typeof c.render === 'function' ? c.render(r) : r[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
