// src/lib/queryCache.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { cached, invalidate, clear, __reset } from './queryCache'

beforeEach(() => __reset())

describe('queryCache.cached', () => {
  it('calls loader once for concurrent callers (dedup)', async () => {
    const loader = vi.fn(async () => 42)
    const a = cached('k', 1000, loader)
    const b = cached('k', 1000, loader)
    const c = cached('k', 1000, loader)
    expect(await a).toBe(42)
    expect(await b).toBe(42)
    expect(await c).toBe(42)
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('returns cached value within ttl without calling loader', async () => {
    const loader = vi.fn(async () => 7)
    await cached('k', 1000, loader)
    const v = await cached('k', 1000, loader)
    expect(v).toBe(7)
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('refetches after ttl expires', async () => {
    const loader = vi.fn(async () => Math.random())
    await cached('k', 1, loader)
    await new Promise((r) => setTimeout(r, 5))
    await cached('k', 1, loader)
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('serves stale and revalidates within staleMs', async () => {
    let n = 0
    const loader = vi.fn(async () => ++n)
    await cached('k', 1, loader)
    await new Promise((r) => setTimeout(r, 5))
    const stale = await cached('k', 1, loader, { staleMs: 1000 })
    expect(stale).toBe(1)
    // revalidation happened in background
    await new Promise((r) => setTimeout(r, 5))
    const fresh = await cached('k', 10000, loader)
    expect(fresh).toBe(2)
  })

  it('deletes entry on loader error', async () => {
    const loader = vi.fn(async () => { throw new Error('boom') })
    await expect(cached('k', 1000, loader)).rejects.toThrow('boom')
    const loader2 = vi.fn(async () => 'ok')
    expect(await cached('k', 1000, loader2)).toBe('ok')
    expect(loader2).toHaveBeenCalledTimes(1)
  })
})

describe('queryCache.invalidate', () => {
  it('removes keys by prefix', async () => {
    await cached('dash:1', 1000, async () => 'a')
    await cached('dash:2', 1000, async () => 'b')
    await cached('other', 1000, async () => 'c')
    invalidate('dash:')
    const l = vi.fn(async () => 'new')
    expect(await cached('dash:1', 1000, l)).toBe('new')
    expect(l).toHaveBeenCalledTimes(1)
    const l2 = vi.fn(async () => 'x')
    // 'other' still cached -> no loader call
    expect(await cached('other', 1000, l2)).toBe('c')
    expect(l2).not.toHaveBeenCalled()
  })
})

describe('queryCache.clear', () => {
  it('empties the store', async () => {
    await cached('k', 1000, async () => 1)
    clear()
    const l = vi.fn(async () => 2)
    expect(await cached('k', 1000, l)).toBe(2)
    expect(l).toHaveBeenCalled()
  })
})
