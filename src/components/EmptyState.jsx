/**
 * EmptyState — the one "nothing here" block every table/list shares.
 *
 * Dense-dashboard rule: one-line teaching hint, never a vague placeholder.
 * Optional action (keyboard shortcut shown inline so shortcuts stay visible).
 *
 * @param {object} props
 * @param {string} [props.title]        bold lead line, e.g. "No scanners yet"
 * @param {string} props.hint           what this means / what to do next
 * @param {string} [props.actionLabel]  button caption, e.g. "Open Scanner"
 * @param {() => void} [props.onAction]
 * @param {string} [props.shortcut]     shown as a kbd hint, e.g. "⌘K"
 */
export default function EmptyState({ title, hint, actionLabel, onAction, shortcut }) {
  return (
    <div className="empty-text" style={{ textAlign: 'center', padding: '1.5rem 1rem' }}>
      {title && <div style={{ fontWeight: 700, color: 'var(--text)', marginBottom: '0.25rem' }}>{title}</div>}
      <div>{hint}</div>
      {(actionLabel && onAction) && (
        <div style={{ marginTop: '0.6rem' }}>
          <button type="button" onClick={onAction} className="btn">
            {actionLabel}
            {shortcut && (
              <kbd style={{ marginLeft: '0.45rem', fontFamily: 'inherit', fontSize: '0.72em', opacity: 0.7 }}>{shortcut}</kbd>
            )}
          </button>
        </div>
      )}
    </div>
  )
}
