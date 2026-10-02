// @vitest-environment jsdom
// MobileTabBar — the phone bottom navigation.
//
// Worth protecting: flatten keeps registry order (PAGES is the single
// source), roles with ≤5 pages never see a dead More button, the active
// tab (incl. active overflow → More) is exposed via aria-current, and
// More announces its count.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { Calendar, Users, ClipboardCheck, Star, Tags, ScanLine } from 'lucide-react'
import MobileTabBar, { flattenNavItems, splitBarItems, MAX_BAR_ITEMS } from './MobileTabBar'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const pagesOf = (n) => {
  const icons = [Calendar, Users, ClipboardCheck, Star, Tags, ScanLine]
  const labels = ['Schedule', 'Overview', 'Consent', 'VSS', 'Finalize', 'Scanner']
  return Array.from({ length: n }, (_, i) => [`p${i}`, { label: labels[i % labels.length], icon: icons[i % icons.length] }])
}

describe('flattenNavItems', () => {
  it('keeps registry order with keys, labels and icons', () => {
    const out = flattenNavItems(pagesOf(3))
    expect(out.map((i) => i.key)).toEqual(['p0', 'p1', 'p2'])
    expect(out[0].label).toBe('Schedule')
    expect(out[0].icon).toBeTruthy()
  })

  it('tolerates empty input', () => {
    expect(flattenNavItems([])).toEqual([])
    expect(flattenNavItems(null)).toEqual([])
  })
})

describe('splitBarItems', () => {
  it(`shows all items with no More at ≤${MAX_BAR_ITEMS}`, () => {
    const { primary, overflow } = splitBarItems(flattenNavItems(pagesOf(5)))
    expect(primary).toHaveLength(5)
    expect(overflow).toHaveLength(0)
  })

  it('moves the tail behind More when overflowing', () => {
    const { primary, overflow } = splitBarItems(flattenNavItems(pagesOf(7)))
    expect(primary).toHaveLength(MAX_BAR_ITEMS - 1)
    expect(overflow).toHaveLength(3)
    // Order preserved across the split.
    expect([...primary, ...overflow].map((i) => i.key)).toEqual(
      ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6']
    )
  })
})

describe('MobileTabBar', () => {
  it('renders nothing without items', () => {
    const { container } = render(
      <MobileTabBar items={[]} currentPage="p0" onSelect={() => {}} onMore={() => {}} />
    )
    expect(container.textContent).toBe('')
  })

  it('marks the active tab with aria-current and fires onSelect', () => {
    const onSelect = vi.fn()
    render(<MobileTabBar items={flattenNavItems(pagesOf(3))} currentPage="p1" onSelect={onSelect} onMore={() => {}} />)
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    expect(nav).toBeTruthy()
    const active = screen.getByRole('button', { name: /Overview/ })
    expect(active.getAttribute('aria-current')).toBe('page')
    fireEvent.click(screen.getByRole('button', { name: /Consent/ }))
    expect(onSelect).toHaveBeenCalledWith('p2')
  })

  it('shows More with a count and highlights it when an overflow page is active', () => {
    const onMore = vi.fn()
    render(<MobileTabBar items={flattenNavItems(pagesOf(7))} currentPage="p5" onSelect={() => {}} onMore={onMore} />)
    const more = screen.getByRole('button', { name: /More pages, 3 more/ })
    expect(more.getAttribute('aria-current')).toBe('page')
    fireEvent.click(more)
    expect(onMore).toHaveBeenCalledTimes(1)
  })

  it('hides More entirely when everything fits', () => {
    render(<MobileTabBar items={flattenNavItems(pagesOf(4))} currentPage="p0" onSelect={() => {}} onMore={() => {}} />)
    expect(screen.queryByRole('button', { name: /More pages/ })).toBeNull()
  })
})
