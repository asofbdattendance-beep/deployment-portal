import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  perfStart,
  perfCurrentRun,
  perfMark,
  perfSummary,
  perfDump,
  __perfResetForTests,
} from './perfTimings'

describe('perfTimings (Phase-0 latency tripwires)', () => {
  beforeEach(() => {
    __perfResetForTests()
    // lib tests run in node (no jsdom localStorage) — stub the flag store.
    const store = {}
    vi.stubGlobal('localStorage', {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v) },
      removeItem: (k) => { delete store[k] },
    })
  })

  it('groups stages per run with deltas in time order', () => {
    const id = perfStart('login')
    perfMark('login', id, 'tap')
    perfMark('login', id, 'auth-end')
    const [run] = perfSummary()
    expect(run.flow).toBe('login')
    expect(run.id).toBe(id)
    expect(run.stages.map((s) => s.stage)).toEqual(['tap', 'auth-end'])
    expect(run.stages[0].atMs).toBe(0)
    expect(run.stages[0].deltaMs).toBe(0)
    expect(run.totalMs).toBe(run.stages[1].atMs)
    expect(run.totalMs).toBeGreaterThanOrEqual(run.stages[1].deltaMs)
  })

  it('keeps concurrent runs of the same flow separate', () => {
    const a = perfStart('scan')
    const b = perfStart('scan')
    expect(b).toBe(a + 1)
    perfMark('scan', b, 'tap')
    perfMark('scan', a, 'tap')
    const runs = perfSummary()
    expect(runs).toHaveLength(2)
    expect(runs.map((r) => r.id).sort()).toEqual([a, b])
  })

  it('perfCurrentRun tracks the latest run per flow', () => {
    expect(perfCurrentRun('login')).toBeNull()
    const id = perfStart('login')
    expect(perfCurrentRun('login')).toBe(id)
  })

  it('caps the buffer instead of growing forever', () => {
    const id = perfStart('viewer')
    for (let i = 0; i < 500; i++) perfMark('viewer', id, `rt-event-${i}`)
    const [run] = perfSummary()
    expect(run.stages.length).toBeLessThanOrEqual(400)
    // Oldest dropped, newest kept.
    expect(run.stages[run.stages.length - 1].stage).toBe('rt-event-499')
  })

  it('stays silent unless the portal_perf flag is set', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const id = perfStart('login')
      perfMark('login', id, 'tap')
      expect(spy).not.toHaveBeenCalled()
      localStorage.setItem('portal_perf', '1')
      perfMark('login', id, 'auth-end')
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0][0]).toContain('[perf] login#')
    } finally {
      spy.mockRestore()
    }
  })

  it('perfDump returns pasteable JSON of the summaries', () => {
    const id = perfStart('login')
    perfMark('login', id, 'tap')
    const parsed = JSON.parse(perfDump())
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({ flow: 'login', id })
  })
})
