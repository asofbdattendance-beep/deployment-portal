import { useRef } from 'react'

// Custom dropdown listing allocated departments, showing per-option
// eligibility reasons. Rendered with position:fixed so it isn't clipped
// by the table's overflow container.
export default function DeptDropdown({
  row,
  depts,
  items,
  open,
  disabled,
  onToggle,
  onSelect,
  openReasons,
  setOpenReasons,
}) {
  const posRef = useRef(null)

  const openMenu = () => {
    const btn = document.getElementById(`dept-btn-${row.centre}|${row.badge_number}`)
    if (!btn) return
    const r = btn.getBoundingClientRect()
    const menuH = 320
    const spaceBelow = window.innerHeight - r.bottom
    const above = spaceBelow < menuH
    posRef.current = {
      top: above ? Math.max(r.top - menuH, 8) : r.bottom + 4,
      left: Math.min(Math.max(r.left, 8), window.innerWidth - 350),
      width: Math.max(r.width, 280),
      above,
    }
    onToggle()
  }

  const current = depts.find(d => d.id === row.requested_dept)
  const id = `dept-btn-${row.centre}|${row.badge_number}`

  return (
    <div style={{ position: 'relative', display: 'inline-block', minWidth: 150 }}>
      <button
        type="button"
        id={id}
        onClick={e => { e.stopPropagation(); if (open) onToggle(false); else openMenu() }}
        disabled={disabled}
        className="select"
        style={{ width: '100%', textAlign: 'left', padding: '0.25rem 0.5rem', fontSize: '0.8rem', background: '#fff', cursor: disabled ? 'not-allowed' : 'pointer' }}
      >
        {current ? current.name : '—'}
        <span style={{ float: 'right', color: '#94a3b8', fontSize: '0.7rem' }}>{open ? '▲' : '▼'}</span>
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
            maxWidth: 340,
            maxHeight: 320,
            overflowY: 'auto',
            background: '#fff',
            border: '1px solid #e2e8f0',
            borderRadius: 10,
            boxShadow: '0 10px 40px rgba(15,23,42,0.15)',
          }}
        >
          {items.length === 0 && (
            <div style={{ padding: '0.75rem', fontSize: '0.78rem', color: '#94a3b8' }}>
              No departments allocated to your centre yet. Contact your super admin.
            </div>
          )}
          {items.map(it => {
            const disabled = it.reasons.length > 0 && !it.isCurrent
            const reasonKey = `${row.centre}|${row.badge_number}|${it.deptId}`
            const showReasons = openReasons === reasonKey
            return (
              <div key={it.deptId}>
                <div
                  className="dept-item"
                  onClick={e => {
                    e.stopPropagation()
                    if (disabled) {
                      setOpenReasons(showReasons ? null : reasonKey)
                      return
                    }
                    onSelect(it.deptId)
                  }}
                  onMouseEnter={() => { if (disabled) setOpenReasons(reasonKey) }}
                  onMouseLeave={() => { if (disabled) setOpenReasons(null) }}
                  style={{
                    position: 'relative',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '0.5rem',
                    padding: '0.5rem 0.75rem',
                    fontSize: '0.82rem',
                    cursor: 'pointer',
                    color: it.isCurrent ? '#4f46e5' : disabled ? '#94a3b8' : '#0f172a',
                    fontWeight: it.isCurrent ? 700 : 500,
                    background: it.isCurrent ? '#eef2ff' : 'transparent',
                    borderBottom: '1px solid #f1f5f9',
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', minWidth: 0 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.name}</span>
                    {disabled && <span style={{ color: '#f59e0b', fontSize: '0.7rem', flexShrink: 0 }}>✕</span>}
                    {it.isCurrent && <span style={{ color: '#4f46e5', fontSize: '0.7rem', flexShrink: 0 }}>✓</span>}
                  </span>
                  <span style={{ fontSize: '0.7rem', color: '#94a3b8', flexShrink: 0 }}>
                    {it.q ? `${it.q.local}/${it.q.max}` : '0/0'}
                  </span>
                </div>
                {showReasons && (
                  <div className="dept-reason" style={{ background: '#fffbeb', borderTop: '1px solid #fde68a', borderBottom: '1px solid #fde68a', padding: '0.45rem 0.75rem 0.55rem 1.25rem', fontSize: '0.75rem', color: '#92400e' }}>
                    <div style={{ fontWeight: 700, marginBottom: '0.15rem', fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: '#b45309' }}>Not eligible</div>
                    {it.reasons.map((reason, i) => <div key={i} style={{ padding: '0.05rem 0' }}>• {reason}</div>)}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
