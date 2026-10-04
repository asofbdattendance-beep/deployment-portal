// @vitest-environment jsdom
// useSewadarSearch — the debounced directory search behind the ASO picker.
//
// Contracts pinned here:
//   1. <2 chars (or no schedule) short-circuits to [] with NO RPC — a
//      1-char prefix would match half the visit.
//   2. The RPC name + params are exactly the v68 signature.
//   3. A stale (superseded) response never paints over the newer one.
//   4. An RPC error surfaces as searchError with [] results — the picker
//      degrades to "type the badge", never a spinner forever.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useSewadarSearch } from './useSewadarSearch'

const rpc = vi.fn()

vi.mock('../lib/supabase', () => ({
  supabase: { rpc: (...args) => rpc(...args) },
}))

const ROWS = [
  { badge_number: 'FB001', sewadar_name: 'Ram Sewak', sewadar_centre: 'CENTRE A', dept_name: 'LANGAR', is_vss: false, deployed: true, open_now: false },
]

beforeEach(() => {
  rpc.mockReset()
  rpc.mockResolvedValue({ data: ROWS, error: null })
})

describe('useSewadarSearch', () => {
  it('does not call the RPC for queries shorter than 2 chars', async () => {
    const { result } = renderHook(() => useSewadarSearch('sched-1', 'F', { debounceMs: 0 }))
    await waitFor(() => expect(result.current.searching).toBe(false))
    expect(rpc).not.toHaveBeenCalled()
    expect(result.current.results).toEqual([])
  })

  it('does not call the RPC without a schedule', async () => {
    const { result } = renderHook(() => useSewadarSearch(null, 'FB00', { debounceMs: 0 }))
    await waitFor(() => expect(result.current.searching).toBe(false))
    expect(rpc).not.toHaveBeenCalled()
  })

  it('calls attendance_search_sewadars with the v68 params', async () => {
    const { result } = renderHook(() => useSewadarSearch('sched-1', 'FB00', { debounceMs: 0 }))
    await waitFor(() => expect(result.current.searching).toBe(false))
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('attendance_search_sewadars', {
      p_schedule: 'sched-1',
      p_query: 'FB00',
      p_limit: 10,
    })
    expect(result.current.results).toEqual(ROWS)
    expect(result.current.searchError).toBeNull()
  })

  it('a superseded response never paints over the newer query', async () => {
    let resolveFirst
    rpc
      .mockImplementationOnce(() => new Promise((res) => { resolveFirst = res }))
      .mockResolvedValueOnce({ data: [{ ...ROWS[0], badge_number: 'FB002' }], error: null })
    const { result, rerender } = renderHook(
      ({ q }) => useSewadarSearch('sched-1', q, { debounceMs: 0 }),
      { initialProps: { q: 'FB00' } },
    )
    // Let the first query's timer fire so its RPC is in flight…
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1))
    // …then supersede it before it resolves.
    rerender({ q: 'FB002' })
    resolveFirst({ data: ROWS, error: null })
    await waitFor(() => expect(result.current.searching).toBe(false))
    expect(result.current.results[0].badge_number).toBe('FB002')
  })

  it('surfaces RPC errors as searchError with empty results', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'PGRST202' } })
    const { result } = renderHook(() => useSewadarSearch('sched-1', 'FB00', { debounceMs: 0 }))
    await waitFor(() => expect(result.current.searching).toBe(false))
    expect(result.current.results).toEqual([])
    expect(result.current.searchError).toBeTruthy()
  })
})
