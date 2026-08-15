import { useRef, useState, useEffect, useMemo } from 'react'
import { Search, X, Check } from 'lucide-react'

/* ─── Searchable combobox for picking the department incharge ───
   Lists only the eligible sewadars passed in (consented + assigned to the
   department). Type to filter by name or badge; after selection the trigger
   shows "BADGE · Name". The menu is position:fixed (like DeptDropdown) so it
   is never clipped by the card/grid containers.                      */

export default function InchargePicker({ id, value, currentName = '', sewadars, onChange, open, onToggle, disabled }) {
  const [query, setQuery] = useState('')
  const posRef = useRef(null)
  const inputRef = useRef(null)

  // If the stored incharge is no longer in the eligible list (their
  // department/consent changed, cleanup happens on save), still show who it
  // is so the trigger never silently disagrees with the database.
  const current = sewadars.find(s => s.badge_number === value)
    || (value && currentName ? { badge_number: value, sewadar_name: currentName } : null)

  // reset the search box each time the menu opens + focus it
  useEffect(() => {
    if (!open) return
    setQuery('')
    const t = setTimeout(() => inputRef.current && inputRef.current.focus(), 0)
    return () => clearTimeout(t)
  }, [open])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sewadars
    return sewadars.filter(s =>
      `${s.sewadar_name || ''} ${s.badge_number || ''}`.toLowerCase().includes(q)
    )
  }, [sewadars, query])

  const openMenu = () => {
    const btn = document.getElementById(id)
    if (!btn) { onToggle(true); return }
    const r = btn.getBoundingClientRect()
    const menuH = Math.min(filtered.length * 40 + 96, 300)
    const spaceBelow = window.innerHeight - r.bottom
    const above = spaceBelow < menuH
    posRef.current = {
      top: above ? Math.max(r.top - menuH, 8) : r.bottom + 4,
      left: Math.min(Math.max(r.left, 8), window.innerWidth - 330),
      width: Math.max(r.width, 280),
      above,
    }
    onToggle(true)
  }

  const pick = (badge) => {
    onChange(badge)
    onToggle(false)
  }

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <button
        type="button"
        id={id}
        onClick={e => { e.stopPropagation(); if (open) onToggle(false); else openMenu() }}
        disabled={disabled}
        className="select"
        title={disabled
          ? 'Editing is disabled'
          : (current ? `${current.badge_number} · ${current.sewadar_name}` : 'Search and pick the incharge for this department')}
        style={{
          width: '100%',
          textAlign: 'left',
          padding: '0.3rem 0.5rem',
          fontSize: '0.78rem',
          background: '#fff',
          cursor: disabled ? 'not-allowed' : 'pointer',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {current ? (
          <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: '0.1rem', minWidth: 0, lineHeight: 1.25, paddingRight: '0.9rem' }}>
            <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#4f46e5', fontSize: '0.68rem', letterSpacing: '0.02em' }}>{current.badge_number}</span>
            <span style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{current.sewadar_name}</span>
          </span>
        ) : (
          <span style={{ color: '#94a3b8' }}>— None —</span>
        )}
        <span style={{ float: 'right', color: '#94a3b8', fontSize: '0.7rem', marginLeft: '0.35rem' }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && posRef.current && (
        <div
          className="dept-menu"
          onClick={e => e.stopPropagation()}
          style={{
            position: 'fixed',
            zIndex: 100,
            top: posRef.current.top,
            left: posRef.current.left,
            width: posRef.current.width,
            maxWidth: 320,
            maxHeight: 300,
            display: 'flex',
            flexDirection: 'column',
            background: '#fff',
            border: '1px solid #e2e8f0',
            borderRadius: 10,
            boxShadow: '0 10px 40px rgba(15,23,42,0.15)',
            overflow: 'hidden',
          }}
        >
          {/* search box */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.5rem 0.6rem', borderBottom: '1px solid #f1f5f9' }}>
            <Search size={13} style={{ color: '#94a3b8', flexShrink: 0 }} />
            <input
              ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') onToggle(false) }}
              placeholder="Search name / badge…"
              className="input"
              style={{ flex: 1, padding: '0.3rem 0.5rem', fontSize: '0.78rem' }}
            />
            {query && (
              <button type="button" onClick={() => setQuery('')} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#94a3b8', display: 'inline-flex', padding: 0 }} title="Clear search">
                <X size={13} />
              </button>
            )}
          </div>

          <div style={{ overflowY: 'auto', maxHeight: 240 }}>
            {current && (
              <div
                className="dept-item"
                onClick={e => { e.stopPropagation(); pick('') }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  padding: '0.5rem 0.75rem',
                  fontSize: '0.82rem',
                  cursor: 'pointer',
                  color: '#dc2626',
                  fontWeight: 500,
                  borderBottom: '1px solid #f1f5f9',
                }}
              >
                <span>✕ None (clear incharge)</span>
              </div>
            )}
            {filtered.length === 0 && (
              <div style={{ padding: '0.75rem', fontSize: '0.78rem', color: '#94a3b8' }}>
                {query.trim() ? `No sewadars match “${query.trim()}”.` : 'No eligible sewadars for this department yet.'}
              </div>
            )}
            {filtered.map(s => {
              const isCurrent = s.badge_number === value
              return (
                <div
                  key={s.badge_number}
                  className="dept-item"
                  onClick={e => { e.stopPropagation(); pick(s.badge_number) }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    padding: '0.45rem 0.75rem',
                    fontSize: '0.8rem',
                    cursor: 'pointer',
                    background: isCurrent ? '#eef2ff' : 'transparent',
                    color: isCurrent ? '#4f46e5' : '#0f172a',
                    fontWeight: isCurrent ? 700 : 500,
                    borderBottom: '1px solid #f1f5f9',
                  }}
                >
                  <span style={{ fontFamily: 'monospace', fontSize: '0.74rem', color: isCurrent ? '#4f46e5' : '#64748b', flexShrink: 0 }}>{s.badge_number}</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.sewadar_name}</span>
                  {isCurrent && <Check size={14} style={{ color: '#4f46e5', flexShrink: 0 }} />}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
