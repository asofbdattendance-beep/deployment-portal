import { useRef, useLayoutEffect, useEffect, useState, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useIsMobile } from '../hooks/useMediaQuery'
import { computeMenuPosition, isRectOffscreen, filterItems } from '../lib/dropdownPosition'

// Custom dropdown listing allocated departments, with per-option
// eligibility reasons and quota usage.
//
// The menu is portalled to <body> with position:fixed so no table
// overflow / transform can clip it. It FOLLOWS its trigger on page or
// table scroll (it used to close on any scroll — including scrolling the
// menu's own list, which made long department lists impossible to scroll).
// Scroll events that originate inside the menu are ignored. On phones the
// menu becomes a bottom sheet with large touch targets.

const SEARCH_THRESHOLD = 6 // show a filter box once the list gets long

function viewportSize() {
  return { width: window.innerWidth, height: window.innerHeight }
}

function focusSibling(menu, from, step) {
  if (!menu) return
  const opts = Array.from(menu.querySelectorAll('.dd-option'))
  if (!opts.length) return
  const at = opts.indexOf(from)
  const next = at === -1
    ? (step > 0 ? opts[0] : opts[opts.length - 1])
    : opts[(at + step + opts.length) % opts.length]
  next.focus()
}

function focusEdge(menu, last) {
  if (!menu) return
  const opts = menu.querySelectorAll('.dd-option')
  const el = last ? opts[opts.length - 1] : opts[0]
  if (el) el.focus()
}

function QuotaBadge({ q, full }) {
  if (!q) return <span className="dd-quota">0/0</span>
  const cls = full ? 'dd-quota dd-quota-full' : q.rem <= 2 ? 'dd-quota dd-quota-low' : 'dd-quota'
  return (
    <span className={cls} title={`${q.effective} of ${q.max} filled`}>
      {full ? 'Full · ' : ''}{q.effective}/{q.max}
    </span>
  )
}

export default function DeptDropdown({
  row,
  depts,
  items,
  open,
  disabled,
  title,
  onToggle,
  onSelect,
  openReasons,
  setOpenReasons,
}) {
  const btnRef = useRef(null)
  const menuRef = useRef(null)
  const searchRef = useRef(null)
  const rafRef = useRef(0)
  const [pos, setPos] = useState(null)
  const [query, setQuery] = useState('')
  const isMobile = useIsMobile()
  // Parents pass an inline onToggle; a ref keeps listeners/effects stable.
  const onToggleRef = useRef(onToggle)
  useLayoutEffect(() => { onToggleRef.current = onToggle })

  const close = useCallback((restoreFocus) => {
    onToggleRef.current(false)
    if (restoreFocus && btnRef.current) btnRef.current.focus()
  }, [])

  const measure = useCallback(() => {
    const btn = btnRef.current
    if (!btn) return
    const rect = btn.getBoundingClientRect()
    const vp = viewportSize()
    if ((rect.width || rect.height) && isRectOffscreen(rect, vp)) { onToggleRef.current(false); return }
    setPos(computeMenuPosition(rect, vp))
  }, [])

  // Position before paint whenever the menu opens; reset the filter on close.
  useLayoutEffect(() => {
    if (!open) { setPos(null); setQuery(''); return }
    measure()
  }, [open, measure])

  // Follow the trigger on scroll/resize (any scroller, captured at window).
  useEffect(() => {
    if (!open || isMobile) return undefined
    const schedule = (e) => {
      // Scrolling the menu itself must never move or close it.
      if (e && e.target instanceof Node && menuRef.current?.contains(e.target)) return
      cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(measure)
    }
    window.addEventListener('scroll', schedule, { capture: true, passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(rafRef.current)
      window.removeEventListener('scroll', schedule, { capture: true })
      window.removeEventListener('resize', schedule)
    }
  }, [open, isMobile, measure])

  // Initial focus: filter box on desktop, current/first option otherwise
  // (focusing an input on a phone would throw the keyboard up).
  const showSearch = items.length > SEARCH_THRESHOLD
  useEffect(() => {
    if (!open || !pos) return
    const menu = menuRef.current
    if (!menu) return
    if (showSearch && !isMobile && searchRef.current) { searchRef.current.focus({ preventScroll: true }); return }
    const target = menu.querySelector('.dd-option[aria-selected="true"]') || menu.querySelector('.dd-option')
    if (target) target.focus({ preventScroll: true })
    // Only on open — not on every reposition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, !!pos])

  // Keep the selected option in view when the list opens.
  useLayoutEffect(() => {
    if (!open || !pos) return
    const sel = menuRef.current?.querySelector('.dd-option[aria-selected="true"]')
    if (sel && typeof sel.scrollIntoView === 'function') sel.scrollIntoView({ block: 'nearest' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, !!pos])

  const filtered = useMemo(() => filterItems(items, query), [items, query])
  const current = depts.find(d => d.id === row.requested_dept)
  const id = `dept-btn-${row.centre}|${row.badge_number}`
  const listId = `${id}-list`

  const choose = (it) => {
    const blocked = it.reasons.length > 0 && !it.isCurrent
    const reasonKey = `${row.centre}|${row.badge_number}|${it.deptId}`
    if (blocked) { setOpenReasons(openReasons === reasonKey ? null : reasonKey); return }
    onSelect(it.deptId)
    if (btnRef.current) btnRef.current.focus({ preventScroll: true })
  }

  const onMenuKeyDown = (e) => {
    const menu = menuRef.current
    const onOption = e.target.classList?.contains('dd-option')
    switch (e.key) {
      case 'Escape': e.preventDefault(); e.stopPropagation(); close(true); break
      case 'Tab': e.preventDefault(); close(true); break
      case 'ArrowDown': e.preventDefault(); focusSibling(menu, onOption ? e.target : null, 1); break
      case 'ArrowUp': e.preventDefault(); focusSibling(menu, onOption ? e.target : null, -1); break
      case 'Home': if (onOption) { e.preventDefault(); focusEdge(menu, false) } break
      case 'End': if (onOption) { e.preventDefault(); focusEdge(menu, true) } break
      default: break
    }
  }

  const onSearchKeyDown = (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const first = filtered.find(it => it.reasons.length === 0 || it.isCurrent)
    if (first) choose(first)
  }

  const onButtonKeyDown = (e) => {
    if (open || disabled) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); onToggle() }
  }

  const menuStyle = isMobile || !pos ? undefined : {
    top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight,
  }

  const menu = open && pos && (
    <>
      {isMobile && (
        <div className="dd-backdrop" onClick={e => { e.stopPropagation(); close(false) }} aria-hidden="true" />
      )}
      <div
        ref={menuRef}
        className={`dept-menu dd-menu${isMobile ? ' dd-sheet' : ''}${pos.above ? ' dd-above' : ''}`}
        style={menuStyle}
        onClick={e => e.stopPropagation()}
        onKeyDown={onMenuKeyDown}
      >
        {isMobile && (
          <div className="dd-sheet-head">
            <span className="dd-sheet-grip" aria-hidden="true" />
            <div className="dd-sheet-title">
              <strong>Choose department</strong>
              <span>{row.sewadar_name || row.badge_number}</span>
            </div>
            <button type="button" className="dd-sheet-close" onClick={() => close(true)} aria-label="Close">✕</button>
          </div>
        )}
        {showSearch && (
          <div className="dd-search">
            <input
              ref={searchRef}
              type="search"
              className="input"
              placeholder="Search departments…"
              aria-label="Search departments"
              aria-controls={listId}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
            />
          </div>
        )}
        <div className="dd-list" id={listId} role="listbox" aria-labelledby={id}>
          {items.length === 0 && (
            <div className="dd-empty">No departments with an allocated quota for your centre yet. Contact your ASO.</div>
          )}
          {items.length > 0 && filtered.length === 0 && (
            <div className="dd-empty">No department matches “{query}”.</div>
          )}
          {filtered.map(it => {
            const blocked = it.reasons.length > 0 && !it.isCurrent
            const reasonKey = `${row.centre}|${row.badge_number}|${it.deptId}`
            const showReasons = openReasons === reasonKey
            const cls = ['dd-option', 'dept-item', it.isCurrent && 'is-current', blocked && 'is-blocked'].filter(Boolean).join(' ')
            return (
              <div key={it.deptId}>
                <div
                  className={cls}
                  role="option"
                  aria-selected={!!it.isCurrent}
                  aria-disabled={blocked || undefined}
                  tabIndex={-1}
                  onClick={e => { e.stopPropagation(); choose(it) }}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); choose(it) }
                  }}
                  onMouseEnter={() => { if (blocked && !isMobile) setOpenReasons(reasonKey) }}
                  onMouseLeave={() => { if (blocked && !isMobile && showReasons) setOpenReasons(null) }}
                >
                  <span className="dd-option-name">
                    <span className="dd-option-label">{it.name}</span>
                    {it.isCurrent && <span className="dd-check" aria-hidden="true">✓</span>}
                    {blocked && <span className="dd-lock" aria-hidden="true">ⓘ</span>}
                  </span>
                  <QuotaBadge q={it.q} full={it.full} />
                </div>
                {showReasons && (
                  <div className="dd-reason dept-reason" role="note">
                    <div className="dd-reason-title">Not eligible</div>
                    {it.reasons.map((reason, i) => <div key={i}>• {reason}</div>)}
                  </div>
                )}
              </div>
            )
          })}
        </div>
        {current && (
          <div
            className="dd-option dd-clear dept-item"
            role="option"
            aria-selected={false}
            tabIndex={-1}
            onClick={e => { e.stopPropagation(); onSelect('') }}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onSelect('') }
            }}
          >
            ✕ Clear department
          </div>
        )}
      </div>
    </>
  )

  return (
    <div className="dd-root">
      <button
        type="button"
        ref={btnRef}
        id={id}
        onClick={e => { e.stopPropagation(); if (open) onToggle(false); else onToggle() }}
        onKeyDown={onButtonKeyDown}
        disabled={disabled}
        title={title}
        className={`select dd-trigger${open ? ' is-open' : ''}${current ? '' : ' is-empty'}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
      >
        <span className="dd-trigger-label">{current ? current.name : 'Select department'}</span>
        <span className="dd-caret" aria-hidden="true">▾</span>
      </button>
      {menu && createPortal(menu, document.body)}
    </div>
  )
}
