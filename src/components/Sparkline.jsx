// Sparkline — inline single-colour SVG micro-trend (dense-dashboard rule:
// 24–40px tall, horizontal context inside KPI tiles; area/time-series charts
// stay in the pages). aria-hidden: the tile's value already carries the number.
export default function Sparkline({ values = [], width = 72, height = 28, stroke = 'currentColor', strokeWidth = 1.5 }) {
  const pts = values.filter((v) => Number.isFinite(v))
  if (pts.length === 0) return null
  const min = Math.min(...pts)
  const max = Math.max(...pts)
  const span = max - min || 1
  const stepX = pts.length === 1 ? 0 : width / (pts.length - 1)
  const coords = pts.map((v, i) => {
    const x = pts.length === 1 ? width / 2 : i * stepX
    const y = height - 2 - ((v - min) / span) * (height - 4)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const d = pts.length === 1 ? `M 0,${(height / 2).toFixed(1)} L ${width},${(height / 2).toFixed(1)}` : `M ${coords.join(' L ')}`
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" focusable="false">
      <path d={d} fill="none" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
