// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const fetchAllRows = vi.fn()
vi.mock('../lib/supabase', () => ({
  fetchAllRows: (...args) => fetchAllRows(...args),
}))
vi.mock('../lib/sewadarDirectory', async (importOriginal) => {
  const real = await importOriginal()
  return {
    ...real,
    readDirectory: vi.fn(async () => ({ map: new Map(), stale: true, count: 0 })),
    writeDirectory: vi.fn(async () => true),
  }
})

const { useSewadarDirectory } = await import('./useSewadarDirectory')

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

beforeEach(() => {
  fetchAllRows.mockReset()
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
})

describe('useSewadarDirectory', () => {
  // A slow refresh for the previous schedule resolving AFTER a switch used to
  // overwrite the new schedule's map, so popups showed the old schedule's
  // department for every badge until the next refresh.
  it('drops a late refresh result from the previous schedule', async () => {
    const slowA = deferred()
    fetchAllRows.mockImplementation((table, _cols, filter) => {
      if (table === 'vss_sewadars') return Promise.resolve([])
      const q = { eq: (_k, v) => v }
      const sched = filter(q)
      if (sched === 'A') return slowA.promise
      return Promise.resolve([{ badge_number: 'FB0001', sewadar_name: 'B Name', centre: 'X', department_id: 'dept-B' }])
    })
    const { result, rerender } = renderHook(({ scheduleId }) => useSewadarDirectory({ scheduleId, enabled: true }), {
      initialProps: { scheduleId: 'A' },
    })
    await waitFor(() => expect(fetchAllRows).toHaveBeenCalled())
    rerender({ scheduleId: 'B' })
    await waitFor(() => expect(result.current.get('FB0001')?.deptId).toBe('dept-B'))
    await act(async () => {
      slowA.resolve([{ badge_number: 'FB0001', sewadar_name: 'A Name', centre: 'X', department_id: 'dept-A' }])
      await slowA.promise
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(result.current.get('FB0001')?.deptId).toBe('dept-B')
  })
})
