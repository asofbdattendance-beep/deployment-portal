// @vitest-environment jsdom
// PhaseSwitch — the Deployment | Attendance top-level switch.
//
// Worth protecting: single-phase roles get no switch at all, the active
// phase reads selected to assistive tech, clicks and arrow keys both move.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import PhaseSwitch from './PhaseSwitch'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('PhaseSwitch', () => {
  it('renders nothing for a single-phase role', () => {
    const { container } = render(<PhaseSwitch activePhase={2} availablePhases={[2]} onChange={() => {}} />)
    expect(container.textContent).toBe('')
  })

  it('marks the active phase tab selected', () => {
    render(<PhaseSwitch activePhase={1} availablePhases={[1, 2]} onChange={() => {}} />)
    expect(screen.getByRole('tab', { name: 'Deployment' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: 'Attendance' }).getAttribute('aria-selected')).toBe('false')
  })

  it('calls onChange with the picked phase', () => {
    const onChange = vi.fn()
    render(<PhaseSwitch activePhase={1} availablePhases={[1, 2]} onChange={onChange} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Attendance' }))
    expect(onChange).toHaveBeenCalledWith(2)
  })

  it('moves with arrow keys', () => {
    const onChange = vi.fn()
    render(<PhaseSwitch activePhase={1} availablePhases={[1, 2]} onChange={onChange} />)
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' })
    expect(onChange).toHaveBeenCalledWith(2)
  })

  it('moves focus to the newly selected tab on arrow keys', () => {
    const onChange = vi.fn()
    render(<PhaseSwitch activePhase={1} availablePhases={[1, 2]} onChange={onChange} />)
    screen.getByRole('tab', { name: 'Deployment' }).focus()
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Attendance' }))
  })
})
