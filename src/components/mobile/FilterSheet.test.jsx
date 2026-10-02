// @vitest-environment jsdom
// FilterSheet + MobileFilterBar.
//
// Worth protecting: the sheet renders nothing when closed, exposes a
// labelled dialog, Escape closes, "Show results" closes, and the bar
// fires open/clear-chip/clear-all with the right keys.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import FilterSheet, { MobileFilterBar } from './FilterSheet'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const CHIPS = [
  { key: 'centre', label: 'Centre: Delhi' },
  { key: 'dept', label: 'Dept: Traffic' },
]

describe('FilterSheet', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <FilterSheet open={false} onClose={() => {}}>
        <input aria-label="Search" />
      </FilterSheet>
    )
    expect(container.textContent).toBe('')
  })

  it('hosts filter controls with result text and clear-all', () => {
    const onClose = vi.fn()
    const onClearAll = vi.fn()
    render(
      <FilterSheet open onClose={onClose} title="Filters" resultText="12 of 40" onClearAll={onClearAll} hasActive>
        <input aria-label="Search" />
      </FilterSheet>
    )
    expect(screen.getByRole('dialog', { name: 'Filters' })).toBeTruthy()
    expect(screen.getByLabelText('Search')).toBeTruthy()
    expect(screen.getByText('12 of 40')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }))
    expect(onClearAll).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Show results' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(<FilterSheet open onClose={onClose}><input aria-label="Search" /></FilterSheet>)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('MobileFilterBar', () => {
  it('opens the sheet and clears chips', () => {
    const onOpen = vi.fn()
    const onClearChip = vi.fn()
    const onClearAll = vi.fn()
    render(
      <MobileFilterBar
        onOpen={onOpen}
        chips={CHIPS}
        onClearChip={onClearChip}
        onClearAll={onClearAll}
        resultText="12 of 40"
        activeCount={2}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /Filters/ }))
    expect(onOpen).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Clear filter Centre: Delhi' }))
    expect(onClearChip).toHaveBeenCalledWith('centre')
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }))
    expect(onClearAll).toHaveBeenCalledTimes(1)
    expect(screen.getByText('12 of 40')).toBeTruthy()
  })

  it('renders without chips when no filters are active', () => {
    render(<MobileFilterBar onOpen={() => {}} chips={[]} resultText="40" activeCount={0} />)
    expect(screen.queryByRole('button', { name: /Clear filter/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Filters' })).toBeTruthy()
  })
})
