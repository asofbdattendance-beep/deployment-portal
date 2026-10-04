// KpiTile — the shared `.stat` tile contract (label / value / sub).
// Extraction source: DeptInchargeDashboardPage.jsx TILE + every page's
// `.stat > .stat-label + .stat-value + .stat-sub` strips. Static pages render
// a div; launcher tiles pass onPress and get a real, focusable,
// keyboard-operable <button> with the same skin (no visual change).
// The '—'-on-error convention stays in the pages, not here.
const TILE_RESET = { appearance: 'none', font: 'inherit', textAlign: 'left', cursor: 'pointer', width: '100%' }

export default function KpiTile({ label, value, sub, tone, onPress, title }) {
  const body = (
    <>
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={tone ? { color: tone } : undefined}>{value}</div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </>
  )
  if (onPress) {
    return (
      <button type="button" onClick={onPress} className="stat" style={TILE_RESET} title={title}>
        {body}
      </button>
    )
  }
  return <div className="stat">{body}</div>
}
