// @vitest-environment jsdom
// Skeleton + OfflineBanner + QuickPeekSheet — shared mobile primitives.
//
// Worth protecting: every variant renders its shape (never a bare spinner),
// OfflineBanner is silent while online and announces while offline,
// QuickPeekSheet traps nothing but closes on overlay tap and Close.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import Skeleton from './Skeleton'
import OfflineBanner from './OfflineBanner'
import QuickPeekSheet from './QuickPeekSheet'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('Skeleton', () => {
  it('renders a KPI tile shape', () => {
    const { container } = render(<Skeleton variant="kpi" />)
    expect(container.querySelector('.sk-kpi')).not.toBeNull()
  })

  it('renders N table rows', () => {
    const { container } = render(<Skeleton variant="table" rows={4} />)
    expect(container.querySelectorAll('.sk-row').length).toBe(4)
    expect(screen.getByRole('status')).not.toBeNull()
  })

  it('renders card and row variants', () => {
    const { container, rerender } = render(<Skeleton variant="card" lines={3} />)
    expect(container.querySelector('.sk-card')).not.toBeNull()
    rerender(<Skeleton variant="row" />)
    expect(container.querySelector('.sk-row')).not.toBeNull()
  })
})

describe('OfflineBanner', () => {
  function setOnline(value) {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, writable: true, value })
  }

  it('renders nothing while online', () => {
    setOnline(true)
    const { container } = render(<OfflineBanner />)
    expect(container.firstChild).toBeNull()
  })

  it('announces while offline and clears on reconnect', () => {
    setOnline(false)
    render(<OfflineBanner />)
    expect(screen.getByRole('alert')).not.toBeNull()
    // jsdom window events drive the reactive hook (inside act to flush)
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, writable: true, value: true })
    act(() => { window.dispatchEvent(new Event('online')) })
    expect(screen.queryByRole('alert')).toBeNull()
    setOnline(true)
  })
})

describe('QuickPeekSheet', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<QuickPeekSheet open={false} onClose={() => {}} title="T" />)
    expect(container.firstChild).toBeNull()
  })

  it('shows title + children and closes on overlay tap and Close button', () => {
    const onClose = vi.fn()
    render(<QuickPeekSheet open onClose={onClose} title="Badge A123"><p>detail</p></QuickPeekSheet>)
    expect(screen.getByRole('dialog', { name: 'Badge A123' })).not.toBeNull()
    expect(screen.getByText('detail')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
