// src/lib/jitter.test.js
import { describe, it, expect, vi } from 'vitest'
import { jitter, jitteredInterval } from './jitter'

describe('jitter', () => {
  it('stays within +/- factor of ms', () => {
    for (let i = 0; i < 200; i++) {
      const v = jitter(1000, 0.2)
      expect(v).toBeGreaterThanOrEqual(800)
      expect(v).toBeLessThanOrEqual(1200)
    }
  })
  it('handles zero and negative ms', () => {
    expect(jitter(0, 0.2)).toBe(0)
    expect(jitter(-5, 0.2)).toBe(0)
  })
})

describe('jitteredInterval', () => {
  it('calls fn and reschedules until cleared', async () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const clear = jitteredInterval(fn, 10, 0)
    // advance enough for at least one fire
    vi.advanceTimersByTime(20)
    expect(fn).toHaveBeenCalled()
    clear()
    const calls = fn.mock.calls.length
    vi.advanceTimersByTime(100)
    expect(fn.mock.calls.length).toBe(calls)
    vi.useRealTimers()
  })
})
