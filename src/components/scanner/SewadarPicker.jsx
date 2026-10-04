import { useRef, useState } from 'react'
import { useSewadarSearch } from '../../hooks/useSewadarSearch'

/**
 * SewadarPicker — "mark attendance for anyone" for aso/super_admin.
 *
 * A search box over the schedule directory (v68
 * `attendance_search_sewadars`): type ≥2 chars of badge, name or centre,
 * pick a row, and the caller starts the normal scan flow for that badge
 * (`onPick(badge)` → `handleScan`) — camera optional. Display-only: this
 * component never writes.
 *
 * Pills on each row say what happens next: OPEN = a session is already
 * open (the choice will be Mark OUT), undeployed = the scan will be
 * flagged, VSS = VSS roster.
 */
export default function SewadarPicker({ scheduleId, onPick, id = 'sewadar-picker' }) {
  const [query, setQuery] = useState('')
  const { results, searching, searchError } = useSewadarSearch(scheduleId, query)
  const trimmed = query.trim()
  const inputRef = useRef(null)
  const listRef = useRef(null)

  // Keyboard support for the listbox: real DOM focus moves between the row
  // buttons, so Enter/Space activate natively and screen readers follow.
  const rowButtons = () =>
    listRef.current ? Array.from(listRef.current.querySelectorAll('.picker-row')) : []
  const focusRow = (index) => {
    const rows = rowButtons()
    if (rows.length === 0) return
    rows[(index + rows.length) % rows.length].focus()
  }
  const onInputKeyDown = (e) => {
    if (e.key === 'ArrowDown' && results.length > 0) {
      e.preventDefault()
      focusRow(0)
    }
  }
  const onListKeyDown = (e) => {
    const rows = rowButtons()
    const at = rows.indexOf(document.activeElement)
    if (e.key === 'ArrowDown') { e.preventDefault(); focusRow(at + 1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusRow(at <= 0 ? rows.length - 1 : at - 1) }
    else if (e.key === 'Home') { e.preventDefault(); focusRow(0) }
    else if (e.key === 'End') { e.preventDefault(); focusRow(rows.length - 1) }
    else if (e.key === 'Escape') { inputRef.current?.focus() }
  }

  return (
    <div className="card picker-card" data-testid="sewadar-picker">
      <label className="picker-label" htmlFor={`${id}-input`}>
        Find a sewadar to mark
      </label>
      <input
        id={`${id}-input`}
        ref={inputRef}
        type="search"
        role="searchbox"
        className="picker-input"
        placeholder="Name, badge or centre (min 2 letters)"
        autoComplete="off"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onInputKeyDown}
      />
      {searching && (
        <p className="picker-status" role="status">Searching…</p>
      )}
      {!searching && searchError && (
        <p className="picker-status picker-error" role="alert">
          Search unavailable — type the badge above instead.
        </p>
      )}
      {!searching && !searchError && trimmed.length >= 2 && results.length === 0 && (
        <p className="picker-status">No match. Sewadar not listed? Type the badge above.</p>
      )}
      {results.length > 0 && (
        <ul
          ref={listRef}
          className="picker-results"
          role="listbox"
          aria-label={`Matching sewadars (${results.length})`}
          onKeyDown={onListKeyDown}
        >
          {results.map((r) => (
            <li key={r.badge_number} role="option" aria-selected="false">
              <button
                type="button"
                className="picker-row"
                onClick={() => onPick?.(r.badge_number)}
              >
                <span className="picker-badge mono">{r.badge_number}</span>
                <span className="picker-name">{r.sewadar_name || '—'}</span>
                <span className="picker-meta">
                  {[r.sewadar_centre, r.dept_name].filter(Boolean).join(' · ') || '—'}
                </span>
                <span className="picker-pills">
                  {r.is_vss && <span className="pill pill-indigo">VSS</span>}
                  {r.open_now
                    ? <span className="pill pill-amber">OPEN</span>
                    : <span className="pill pill-grey">not in</span>}
                  {!r.deployed && <span className="pill pill-red">undeployed</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
