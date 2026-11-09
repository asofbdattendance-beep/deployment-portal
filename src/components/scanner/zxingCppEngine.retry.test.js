/**
 * zxingCppEngine — download retry policy.
 *
 * zxing-wasm caches its module promise, so a failed .wasm download would be
 * handed straight back to every later call. These tests pin that a failed or
 * stalled download is purged and retried, and that the loader gives up (null,
 * so the pool falls back to ZXing-JS) only after the last attempt.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ attempts: [], purges: 0 }))

vi.mock('zxing-wasm/reader', () => ({
  prepareZXingModule: vi.fn(() => {
    const next = mocks.attempts.shift()
    if (next === 'fail') return Promise.reject(new Error('Failed to fetch'))
    if (next === 'stall') return new Promise(() => {})
    return Promise.resolve({})
  }),
  purgeZXingModule: vi.fn(() => { mocks.purges++ }),
  readBarcodes: vi.fn(async () => [{ text: 'FB5971GA0001', isValid: true, position: {} }]),
}))

const { loadZxingCpp } = await import('./zxingCppEngine')
const zxing = await import('zxing-wasm/reader')

const FAST = { retryDelayMs: 1, attemptTimeoutMs: 30 }

beforeEach(() => {
  mocks.attempts = []
  mocks.purges = 0
  zxing.prepareZXingModule.mockClear()
})

describe('loadZxingCpp download retry', () => {
  it('loads on the first try without purging anything', async () => {
    mocks.attempts = ['ok']
    const decode = await loadZxingCpp(FAST)
    expect(typeof decode).toBe('function')
    expect(zxing.prepareZXingModule).toHaveBeenCalledTimes(1)
    expect(mocks.purges).toBe(0)
  })

  it('purges the cached failure and retries a failed download', async () => {
    mocks.attempts = ['fail', 'fail', 'ok']
    const decode = await loadZxingCpp(FAST)
    expect(typeof decode).toBe('function')
    expect(zxing.prepareZXingModule).toHaveBeenCalledTimes(3)
    expect(mocks.purges).toBe(2)
    expect((await decode({ data: new Uint8ClampedArray(4), width: 1, height: 1 }, {}))[0].rawValue).toBe('FB5971GA0001')
  })

  it('gives a stalled download a deadline, then retries it', async () => {
    mocks.attempts = ['stall', 'ok']
    const decode = await loadZxingCpp(FAST)
    expect(typeof decode).toBe('function')
    expect(zxing.prepareZXingModule).toHaveBeenCalledTimes(2)
  })

  it('returns null after the last failed attempt so the pool uses ZXing-JS', async () => {
    mocks.attempts = ['fail', 'fail', 'fail', 'ok']
    expect(await loadZxingCpp(FAST)).toBeNull()
    expect(zxing.prepareZXingModule).toHaveBeenCalledTimes(3)
  })

  it('honours a custom attempt count', async () => {
    mocks.attempts = ['fail', 'ok']
    expect(await loadZxingCpp({ ...FAST, attempts: 1 })).toBeNull()
    expect(zxing.prepareZXingModule).toHaveBeenCalledTimes(1)
  })
})
