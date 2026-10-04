// @vitest-environment jsdom
// EmptyState — teaching hint always, action + shortcut only when provided.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import EmptyState from './EmptyState'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('EmptyState', () => {
  it('renders title and hint with no action', () => {
    const { container } = render(<EmptyState title="No scanners yet" hint="Scans appear here once the visit starts." />)
    expect(screen.getByText('No scanners yet')).toBeTruthy()
    expect(screen.getByText('Scans appear here once the visit starts.')).toBeTruthy()
    expect(container.querySelector('button')).toBeNull()
  })

  it('fires the action and shows the shortcut', () => {
    const onAction = vi.fn()
    render(<EmptyState hint="Nothing here." actionLabel="Open Scanner" onAction={onAction} shortcut="S" />)
    const btn = screen.getByRole('button', { name: /open scanner/i })
    expect(screen.getByText('S')).toBeTruthy()
    fireEvent.click(btn)
    expect(onAction).toHaveBeenCalledTimes(1)
  })
})
