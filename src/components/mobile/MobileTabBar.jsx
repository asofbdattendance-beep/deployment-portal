import { useEffect, useRef } from 'react'
import { LayoutGrid } from 'lucide-react'
import { safeBottom } from '../../lib/mobile'

/**
 * flattenNavItems — expand the PAGES registry (with `group` dropdowns)
 * into a flat ordered list of { key, label, icon } for the mobile bar.
 * Groups expand to their member pages: on a phone every destination is
 * one tap away instead of a tap + a 230px floating menu.
 */
export function flattenNavItems(visiblePages) {
  const out = []
  for (const [key, cfg] of visiblePages || []) {
    if (!cfg) continue
    out.push({ key, label: cfg.label, icon: cfg.icon })
  }
  return out
}

/** Max tabs on the bar itself (5th slot becomes More when overflowing). */
export const MAX_BAR_ITEMS = 5

/**
 * splitBarItems — first N items stay on the bar, the rest go to More.
 * Roles with ≤MAX items never see a More button (no dead affordance).
 */
export function splitBarItems(items, max = MAX_BAR_ITEMS) {
  const list = Array.isArray(items) ? items : []
  if (list.length <= max) return { primary: list, overflow: [] }
  return { primary: list.slice(0, max - 1), overflow: list.slice(max - 1) }
}

/**
 * MobileTabBar — fixed bottom navigation, rendered ONLY when
 * useIsMobile() is true (see App.jsx). Desktop keeps .tab-nav untouched.
 *
 * - 48px+ targets, safe-area bottom inset, thumb-reachable.
 * - aria-current="page" on the active tab; More announces its count.
 * - Active overflow item highlights More (aria-current + dot).
 */
export default function MobileTabBar({ items, currentPage, onSelect, onMore }) {
  const { primary, overflow } = splitBarItems(items)
  const moreActive = overflow.some((i) => i.key === currentPage)
  const barRef = useRef(null)

  // Keep the active tab visible when the bar scrolls horizontally on
  // very narrow phones (5 items × ~72px > 320px viewport).
  useEffect(() => {
    const el = barRef.current?.querySelector('[aria-current="page"]')
    if (el && typeof el.scrollIntoView === 'function') {
      try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }) } catch { /* ignore */ }
    }
  }, [currentPage])

  if (primary.length === 0) return null

  return (
    <nav className="mobile-tabbar" aria-label="Primary" ref={barRef} style={{ paddingBottom: safeBottom('0.4rem') }}>
      {primary.map((item) => {
        const active = currentPage === item.key
        const Icon = item.icon || LayoutGrid
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => onSelect(item.key)}
            className={`mobile-tab${active ? ' mobile-tab-active' : ''}`}
            aria-current={active ? 'page' : undefined}
          >
            <Icon size={21} aria-hidden="true" />
            <span className="mobile-tab-label">{item.label}</span>
            {active && <span className="mobile-tab-dot" aria-hidden="true" />}
          </button>
        )
      })}
      {overflow.length > 0 && (
        <button
          type="button"
          onClick={onMore}
          className={`mobile-tab${moreActive ? ' mobile-tab-active' : ''}`}
          aria-current={moreActive ? 'page' : undefined}
          aria-haspopup="dialog"
          aria-label={`More pages, ${overflow.length} more`}
        >
          <LayoutGrid size={21} aria-hidden="true" />
          <span className="mobile-tab-label">More</span>
          {moreActive && <span className="mobile-tab-dot" aria-hidden="true" />}
        </button>
      )}
    </nav>
  )
}
