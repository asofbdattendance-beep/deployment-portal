// @vitest-environment jsdom
// PullToRefresh + InstallPrompt + VirtualList.
//
// Worth protecting: pull only arms at scrollTop 0 and fires past threshold;
// InstallPrompt stays silent on desktop/standalone/dismissed and fires the
// deferred prompt on tap; VirtualList windows rows (no 700-node DOM).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import PullToRefresh from './PullToRefresh'
import InstallPrompt from './InstallPrompt'
import VirtualList from './VirtualList'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

// jsdom has no layout engine: ResizeObserver never fires and every rect is
// 0×0, so the virtualizer computes an empty range. Stub RO per target class
// (600px container, 64px rows) so windowing is exercised, not the DOM.
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    constructor(cb) { this.cb = cb }
    observe(el) {
      const h = el && el.classList && el.classList.contains('virt-list') ? 600 : 64
      this.cb([{
        target: el,
        borderBoxSize: [{ inlineSize: 360, blockSize: h }],
        contentRect: { width: 360, height: h },
      }], this)
    }
    unobserve() {}
    disconnect() {}
  })
})

describe('PullToRefresh', () => {
  function drag(node, fromY, toY) {
    fireEvent.touchStart(node, { touches: [{ clientY: fromY }], currentTarget: node })
    // currentTarget is set by the dispatcher; re-fire move/end on the node
    fireEvent.touchMove(node, { touches: [{ clientY: toY }] })
    fireEvent.touchEnd(node)
  }

  it('fires onRefresh on a past-threshold pull from the top', () => {
    const onRefresh = vi.fn()
    const { container } = render(
      <PullToRefresh onRefresh={onRefresh}>
        <div>content</div>
      </PullToRefresh>,
    )
    const node = container.querySelector('.ptr')
    Object.defineProperty(node, 'scrollTop', { configurable: true, value: 0 })
    drag(node, 100, 400) // dy 300 → 120px damped ≥ 72 threshold
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('ignores pulls when already scrolled', () => {
    const onRefresh = vi.fn()
    const { container } = render(
      <PullToRefresh onRefresh={onRefresh}>
        <div>content</div>
      </PullToRefresh>,
    )
    const node = container.querySelector('.ptr')
    Object.defineProperty(node, 'scrollTop', { configurable: true, value: 200 })
    drag(node, 100, 400)
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('ignores short pulls and shows the spinner while refreshing', () => {
    const onRefresh = vi.fn()
    const { container, rerender } = render(
      <PullToRefresh onRefresh={onRefresh}>
        <div>content</div>
      </PullToRefresh>,
    )
    const node = container.querySelector('.ptr')
    Object.defineProperty(node, 'scrollTop', { configurable: true, value: 0 })
    drag(node, 100, 150) // dy 50 → 20px damped < threshold
    expect(onRefresh).not.toHaveBeenCalled()
    rerender(<PullToRefresh onRefresh={onRefresh} refreshing><div>content</div></PullToRefresh>)
    expect(screen.getByText('Refreshing…')).not.toBeNull()
  })
})

describe('InstallPrompt', () => {
  it('stays silent on desktop widths', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1366 })
    const { container } = render(<InstallPrompt />)
    expect(container.firstChild).toBeNull()
  })

  it('renders on desktop when the install event was captured pre-hydration', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1366 })
    window.__portalInstallEvent = { prompt: vi.fn(), userChoice: Promise.resolve({ outcome: 'accepted' }) }
    try {
      const { container } = render(<InstallPrompt />)
      expect(container.querySelector('.install-banner')).not.toBeNull()
      expect(screen.getByText('Install Sewadar Portal as an app for faster scanning.')).not.toBeNull()
    } finally {
      delete window.__portalInstallEvent
    }
  })
})

describe('VirtualList', () => {
  const items = Array.from({ length: 700 }, (_, i) => ({ id: i, label: `row-${i}` }))

  it('windows rows instead of rendering all 700', () => {
    const { container } = render(
      <VirtualList
        items={items}
        estimateSize={64}
        renderRow={(it) => <div>{it.label}</div>}
      />,
    )
    const rendered = container.querySelectorAll('.virt-row')
    expect(rendered.length).toBeGreaterThan(0)
    expect(rendered.length).toBeLessThan(700)
    expect(container.querySelector('[data-index="0"]')).not.toBeNull()
  })

  it('renders the empty state with no items', () => {
    render(<VirtualList items={[]} empty={<div>no rows</div>} renderRow={() => null} />)
    expect(screen.getByText('no rows')).not.toBeNull()
  })
})
