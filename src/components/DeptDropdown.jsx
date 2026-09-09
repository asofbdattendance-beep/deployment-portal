import { useRef, useLayoutEffect, useState, useCallback } from 'react'

// Custom dropdown listing allocated departments, showing per-option
// eligibility reasons. Rendered with position:fixed so it isn't clipped
// by the table's overflow container.
//
// Positioning strategy:
//  1. On open, immediately calculate position from getBoundingClientRect()
//     and store in a ref so the menu renders without a flash.
//  2. useLayoutEffect recalculates after the menu renders to correct any
//     drift caused by accordion animations, scroll containers, or
//     stale refs.
//  3. A scroll listener on the nearest scrollable ancestor closes the
//     menu when the table scrolls (simpler and more reliable than
//     repositioning mid-scroll).
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
  const btnRef = useRef(null)
  const menuRef = useRef(null)
  const [forceUpdate, setForceUpdate] = useState(0)

  // ── Position calculation ──────────────────────────────────
  const calcPos = useCallback(() => {
    const btn = btnRef.current
    if (!btn) return null
    const r = btn.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return null // button not yet laid out
    const menuH = 320
    const spaceBelow = window.innerHeight - r.bottom
    const above = spaceBelow < menuH && r.top > menuH
    return {
      top: above ? Math.max(r.top - menuH - 4, 8) : r.bottom + 4,
      left: Math.min(Math.max(r.left, 8), window.innerWidth - 350),
      width: Math.max(r.width, 280),
      above,
    }
  }, [])

  // ── Open: calculate position synchronously, then verify after paint ──
  const openMenu = useCallback(() => {
    const pos = calcPos()
    if (pos) posRef.current = pos
    onToggle()
  }, [calcPos, onToggle])

  // After the menu renders, recalculate to fix any drift
  useLayoutEffect(() => {
    if (!open) return
    const pos = calcPos()
    if (pos && (
      !posRef.current ||
      Math.abs(pos.top - posRef.current.top) > 2 ||
      Math.abs(pos.left - posRef.current.left) > 2
    )) {
      posRef.current = pos
      setForceUpdate(n => n + 1) // ensure the DOM picks up the corrected position
    }
  }, [open, calcPos, forceUpdate])

  // Close menu on scroll of any ancestor (avoids stale positions)
  useLayoutEffect(() => {
    if (!open) return
    const btn = btnRef.current
    if (!btn) return
    let el = btn.parentElement
    const onScroll = () => { if (open) onToggle(false) }
    while (el && el !== document.documentElement) {
      if (el.scrollHeight > el.clientHeight + 4) {
        el.addEventListener('scroll', onScroll, { passive: true, capture: true })
        break
      }
      el = el.parentElement
    }
    return () => {
      if (el) el.removeEventListener('scroll', onScroll, { capture: true })
    }
  }, [open, onToggle])

  const current = depts.find(d => d.id === row.requested_dept)
  const id = `dept-btn-${row.centre}|${row.badge_number}`

  return (
    <div style={{ position: 'relative', display: 'inline-block', minWidth: 150 }}>
      <button
        type="button"
        ref={btnRef}
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
          ref={menuRef}
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
              No departments with an allocated quota for your centre yet. Contact your ASO.
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
                    {it.q ? `${it.q.effective}/${it.q.max}` : '0/0'}
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
          {current && (
            <div
              className="dept-item"
              onClick={e => { e.stopPropagation(); onSelect('') }}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.35rem',
                padding: '0.55rem 0.75rem',
                fontSize: '0.78rem',
                cursor: 'pointer',
                color: '#dc2626',
                fontWeight: 500,
                borderTop: '1px solid #e2e8f0',
                background: '#fef2f2',
                borderRadius: '0 0 10px 10px',
              }}
            >
              <span>✕ Clear department</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
