// @vitest-environment jsdom
// SewadarPicker — the ASO "mark for anyone" search box.
//
// Pinned: the hint contract (undeployed/not-listed badges fall back to
// the manual badge entry — the picker is display-only and never writes),
// the OPEN/deployed/VSS pills that preview the next scan direction, and
// that picking a row hands exactly the badge to onPick.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import SewadarPicker from './SewadarPicker'

const rpc = vi.fn()

vi.mock('../../hooks/useSewadarSearch', () => ({
  useSewadarSearch: () => ({ results: rpc(), searching: false, searchError: null }),
}))

const ROWS = [
  { badge_number: 'FB001', sewadar_name: 'Ram Sewak', sewadar_centre: 'CENTRE A', dept_name: 'LANGAR', is_vss: false, deployed: true, open_now: true },
  { badge_number: 'VS009', sewadar_name: 'Hari Das', sewadar_centre: 'CENTRE B', dept_name: null, is_vss: true, deployed: false, open_now: false },
]

beforeEach(() => {
  vi.clearAllMocks()
  cleanup()
  rpc.mockReturnValue(ROWS)
})

describe('SewadarPicker', () => {
  it('renders matching rows with identity and state pills', async () => {
    render(<SewadarPicker scheduleId="sched-1" onPick={() => {}} />)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'FB' } })
    expect(await screen.findByText('FB001')).toBeTruthy()
    expect(screen.getByText('Ram Sewak')).toBeTruthy()
    expect(screen.getByText('CENTRE A · LANGAR')).toBeTruthy()
    expect(screen.getByText('OPEN')).toBeTruthy()
    expect(screen.getByText('VSS')).toBeTruthy()
    expect(screen.getByText('undeployed')).toBeTruthy()
  })

  it('hands the picked badge to onPick and writes nothing itself', async () => {
    const onPick = vi.fn()
    render(<SewadarPicker scheduleId="sched-1" onPick={onPick} />)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'VS' } })
    fireEvent.click(await screen.findByText('VS009'))
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick).toHaveBeenCalledWith('VS009')
  })

  it('shows the manual-badge fallback hint when nothing matches', async () => {
    rpc.mockReturnValue([])
    render(<SewadarPicker scheduleId="sched-1" onPick={() => {}} />)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'ZZ' } })
    expect(await screen.findByText(/Type the badge above/)).toBeTruthy()
  })

  it('supports full keyboard operation: input → rows → Escape back', async () => {
    const onPick = vi.fn()
    render(<SewadarPicker scheduleId="sched-1" onPick={onPick} />)
    const input = screen.getByRole('searchbox')
    fireEvent.change(input, { target: { value: 'FB' } })
    await screen.findByText('FB001')
    // ArrowDown from the input enters the list on the first row.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(document.activeElement.textContent).toContain('FB001')
    // ArrowDown steps to the second row; activating the focused row picks it.
    fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' })
    expect(document.activeElement.textContent).toContain('VS009')
    document.activeElement.click()
    expect(onPick).toHaveBeenCalledWith('VS009')
    // ArrowUp steps back; from the first row it wraps to the last row.
    fireEvent.keyDown(document.activeElement, { key: 'ArrowUp' })
    expect(document.activeElement.textContent).toContain('FB001')
    fireEvent.keyDown(document.activeElement, { key: 'ArrowUp' })
    expect(document.activeElement.textContent).toContain('VS009')
    // Escape returns focus to the input.
    fireEvent.keyDown(document.activeElement, { key: 'Escape' })
    expect(document.activeElement).toBe(input)
  })
})
