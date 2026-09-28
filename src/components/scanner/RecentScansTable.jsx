// RecentScansTable — the "my last N scans" list on the scanner pages
// (ScannerPage / DeptInchargePage), as a COMPACT horizontal table.
//
// Why this is its own component instead of the inline `<table className="table">`
// it replaces: `src/index.css` (~line 287) turns every `.table` row into a
// stacked card below 640px — `.table, .table tbody, .table tr, .table td
// { display: block; width: 100% }`. A scanner reading "who is still in?" wants
// one line per sewadar at every viewport, so this table deliberately uses its
// OWN class (`scans-table` inside `scans-wrap`) and never opts into `.table`.
// That is the whole trick — the mobile rules simply do not match. Do not
// "simplify" these class names back to `table`, and do not fight the collapse
// with specificity overrides; the isolation is the feature.
//
// Compact by design: five columns, `white-space: nowrap` everywhere, tabular
// numerals on the times, and no Status column — an empty Out cell already reads
// as "still in".
const COLUMNS = ['Badge', 'Name', 'Dept', 'In', 'Out']

const EM_DASH = '—'

export default function RecentScansTable({ rows = [], deptNameById, limit, emptyMessage }) {
  const list = typeof limit === 'number' ? rows.slice(0, limit) : rows

  // The department NAME is the point of the Dept column; the stored uuid is not
  // meaningful to a human, so an unresolvable id degrades to an em dash.
  const deptNameFor = (row) => (row.sewadar_dept ? deptNameById?.get(row.sewadar_dept) : null)

  return (
    <div
      className="scans-wrap"
      role="region"
      tabIndex={0}
      aria-label="Recent attendance scans (scrollable)"
    >
      <table className="scans-table">
        <caption className="sr-only">
          Recent attendance scans — newest first. An empty Out time means the sewadar is still in.
        </caption>
        <thead>
          <tr>
            {COLUMNS.map((col) => (
              <th key={col} scope="col">{col}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {list.length === 0 ? (
            <tr>
              <td className="scans-empty" colSpan={5}>{emptyMessage}</td>
            </tr>
          ) : (
            list.map((row) => {
              const deptName = deptNameFor(row)
              return (
                <tr key={row.id ?? row.badge_number}>
                  <td className="scans-badge">
                    {row.badge_number}
                    {row.is_vss ? <span className="pill pill-amber scans-pill">VSS</span> : null}
                    {row.undeployed_scan ? <span className="pill pill-red scans-pill">Flagged</span> : null}
                  </td>
                  <td className="scans-name" title={row.sewadar_name || undefined}>
                    {row.sewadar_name || EM_DASH}
                  </td>
                  <td className="scans-dept">
                    {deptName ? <span className="pill pill-blue">{deptName}</span> : EM_DASH}
                  </td>
                  <td className="scans-time">{row.in_time}</td>
                  <td className="scans-time">{row.out_time || EM_DASH}</td>
                </tr>
              )
            })
          )}
        </tbody>
      </table>
    </div>
  )
}
