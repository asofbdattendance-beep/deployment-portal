// @vitest-environment jsdom
// MoreSheet — the overflow bottom sheet behind the More button.
//
// Worth protecting: renders nothing when closed, exposes a labelled
// dialog with the active page marked, Escape/backdrop/item all close or
// select correctly, and focus returns to the invoker on close.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { Calendar, Users } from 'lucide-react'
import MoreSheet from './MoreSheet'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const ITEMS = [
  { key: 'a', label: 'Schedule', icon: Calendar },
  { key: 'b', label: 'Overview', icon: Users },
]

describe('MoreSheet', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <MoreSheet open={false} items={ITEMS} currentPage="a" onSelect={() => {}} onClose={() => {}} />
    )
    expect(container.textContent).toBe('')
  })

  it('lists overflow pages with the active one marked', () => {
    render(<MoreSheet open items={ITEMS} currentPage="b" onSelect={() => {}} onClose={() => {}} />)
    const dialog = screen.getByRole('dialog', { name: 'More pages' })
    expect(dialog).toBeTruthy()
    expect(screen.getByRole('button', { name: /Overview/ }).getAttribute('aria-current')).toBe('page')
  })

  it('selects an item, closes on Escape and backdrop', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(<MoreSheet open items={ITEMS} currentPage="a" onSelect={onSelect} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /Overview/ }))
    expect(onSelect).toHaveBeenCalledWith('b')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: /^Close$/ }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('restores body scroll on unmount', () => {
    document.body.style.overflow = ''
    const { unmount } = render(
      <MoreSheet open items={ITEMS} currentPage="a" onSelect={() => {}} onClose={() => {}} />
    )
    expect(document.body.style.overflow).toBe('hidden')
    unmount()
    expect(document.body.style.overflow).toBe('')
  })
})
