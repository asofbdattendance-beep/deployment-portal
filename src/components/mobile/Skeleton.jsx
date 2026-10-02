/**
 * Skeleton — loading placeholders that match the shape of what's loading.
 * Dense-dashboard rule: skeleton rows matching column structure, never a
 * generic spinner. The shimmer is disabled under prefers-reduced-motion.
 *
 * Variants: 'kpi' (stat tile) · 'row' (single list row) · 'card' (stacked
 * card) · 'table' (N body rows under a header bar) · 'text' (inline lines).
 */
export default function Skeleton({ variant = 'row', rows = 5, lines = 2, className = '' }) {
  if (variant === 'kpi') {
    return (
      <div className={`sk sk-kpi ${className}`} aria-hidden="true">
        <div className="sk-bar sk-w40" />
        <div className="sk-bar sk-big sk-w60" />
      </div>
    )
  }
  if (variant === 'card') {
    return (
      <div className={`sk sk-card ${className}`} aria-hidden="true">
        <div className="sk-bar sk-w70" />
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} className="sk-bar sk-w100" />
        ))}
      </div>
    )
  }
  if (variant === 'table') {
    return (
      <div className={`sk sk-table ${className}`} role="status" aria-label="Loading">
        <div className="sk-bar sk-head" />
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="sk-row">
            <div className="sk-bar sk-w25" />
            <div className="sk-bar sk-w50" />
            <div className="sk-bar sk-w25" />
          </div>
        ))}
      </div>
    )
  }
  if (variant === 'text') {
    return (
      <div className={`sk ${className}`} aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} className="sk-bar sk-w100" />
        ))}
      </div>
    )
  }
  // 'row'
  return (
    <div className={`sk sk-row ${className}`} aria-hidden="true">
      <div className="sk-bar sk-w25" />
      <div className="sk-bar sk-w50" />
      <div className="sk-bar sk-w25" />
    </div>
  )
}
