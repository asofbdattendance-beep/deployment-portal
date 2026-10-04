import { Lock } from 'lucide-react'

/**
 * ViewOnlyPill — the one read-only marker every aso/super_admin surface shares.
 *
 * Render contract copied from the AttendancePage header: `pill` + `pill-gray`
 * (which is exactly the `#f1f5f9` / `#64748b` the old inline styles spelled
 * out), 12px lock, sentence-case "View-only" text. The `title` explains WHY
 * this surface is read-only — pass the page-specific reason.
 */
export function ViewOnlyPill({
  title = 'View-only access — downloads are available, changes are not',
}) {
  return (
    <span className="pill pill-gray" title={title}>
      <Lock size={12} aria-hidden="true" /> View-only
    </span>
  )
}

/**
 * PageHeader — the one page header every report/dashboard surface shares.
 *
 * Layout mirrors the AttendancePage header block exactly (same classes, same
 * inline skeleton): title block on the left (icon + title, sub, then a
 * pills/actions row), free-form `aside` on the right (scan-day pickers,
 * schedule selects, filter counts). Nothing here fetches or subscribes —
 * the page passes nodes in.
 *
 * @param {object} props
 * @param {React.ReactNode} [props.icon]    22px lucide icon next to the title
 * @param {string} props.title
 * @param {string} [props.sub]              one-line "what am I looking at"
 * @param {React.ReactNode} [props.pills]   ViewOnlyPill, filter-count pills…
 * @param {React.ReactNode} [props.actions] Refresh / Export / PDF buttons…
 * @param {React.ReactNode} [props.aside]   right-hand controls
 */
export default function PageHeader({ icon, title, sub, pills, actions, aside }) {
  return (
    <div className="page-header" style={{ alignItems: 'center', gap: '1.25rem' }}>
      <div style={{ flex: '1 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
        <h2 className="page-title">{icon}{title}</h2>
        {sub && <div className="page-sub">{sub}</div>}
        {(pills || actions) && (
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
            {pills}
            {actions}
          </div>
        )}
      </div>
      {aside && (
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {aside}
        </div>
      )}
    </div>
  )
}
