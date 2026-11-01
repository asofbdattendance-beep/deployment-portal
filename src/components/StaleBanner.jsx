// src/components/StaleBanner.jsx
// Compact "data is stale / server busy" strip with a manual retry.
// Shown when a reload failed or the last successful refresh is older
// than ~3x the normal poll interval. Keeps the last good data on screen.
import { RefreshCw } from 'lucide-react'

export default function StaleBanner({ stale, error, onRetry, lastRefreshAt }) {
  if (!stale && !error) return null
  const ago = lastRefreshAt ? Math.round((Date.now() - lastRefreshAt) / 1000) : null
  return (
    <div
      aria-live="polite"
      style={{
        display: 'flex', alignItems: 'center', gap: '0.5rem',
        padding: '0.5rem 0.75rem', marginBottom: '0.75rem',
        borderRadius: 8, fontSize: 13,
        background: 'var(--warn-soft, #fef3c7)',
        border: '1px solid var(--warn, #f59e0b)',
        color: 'var(--warn-text, #92400e)',
      }}
    >
      <RefreshCw size={14} />
      <span style={{ flex: 1 }}>
        {error
          ? `Refresh failed — showing last data${ago ? ` (${ago}s ago)` : ''}.`
          : `Data may be stale${ago ? ` — last update ${ago}s ago` : ''}.`}
      </span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          style={{
            border: '1px solid currentColor', background: 'transparent',
            borderRadius: 6, padding: '0.2rem 0.6rem', cursor: 'pointer',
            fontSize: 12, color: 'inherit',
          }}
        >
          Try again
        </button>
      )}
    </div>
  )
}
