// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import { ToastProvider, useToast } from './Toast'

let api = null
function Grab() { api = useToast(); return null }

function mount() {
  return render(<ToastProvider><Grab /></ToastProvider>)
}

afterEach(() => { cleanup(); vi.useRealTimers(); api = null })

describe('ToastProvider', () => {
  it('shows one toast when the same message fires repeatedly (camera busy storm)', () => {
    const { getAllByText } = mount()

    act(() => { for (let i = 0; i < 10; i++) api.warning('Scanner busy — retry this badge') })

    expect(getAllByText('Scanner busy — retry this badge')).toHaveLength(1)
  })

  it('still shows distinct messages side by side', () => {
    const { getByText } = mount()

    act(() => { api.success('Marked IN'); api.warning('Scanner busy — retry this badge') })

    expect(getByText('Marked IN')).toBeTruthy()
    expect(getByText('Scanner busy — retry this badge')).toBeTruthy()
  })

  it('shows the same message again once the first copy has expired', () => {
    vi.useFakeTimers()
    const { getAllByText, queryByText } = mount()

    act(() => { api.info('Saved') })
    act(() => { vi.advanceTimersByTime(3100) })
    expect(queryByText('Saved')).toBeNull()

    act(() => { api.info('Saved') })
    expect(getAllByText('Saved')).toHaveLength(1)
  })

  it('a manually closed toast does not let its old timer unblock a newer copy', () => {
    vi.useFakeTimers()
    const { getAllByText, getByRole } = mount()

    act(() => { api.warning('Busy') })                              // copy A, expires at 3000
    act(() => { getByRole('button', { name: /dismiss/i }).click() }) // closed by hand at t=0
    act(() => { vi.advanceTimersByTime(1000) })
    act(() => { api.warning('Busy') })                              // copy B, expires at 4000
    act(() => { vi.advanceTimersByTime(2100) })                     // A's stale timer fires (t=3100)
    act(() => { api.warning('Busy') })                              // B still showing: must dedupe

    expect(getAllByText('Busy')).toHaveLength(1)
  })
})
