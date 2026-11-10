import { describe, it, expect, vi } from 'vitest'
import {
  detectInAppBrowser,
  deviceContext,
  sanitizeEvent,
  createTelemetry,
  isFatalTelemetryError,
  TELEMETRY_FLUSH_AT,
  TELEMETRY_MAX_QUEUE,
  TELEMETRY_RETRY_BACKOFF_MS,
} from './scanTelemetry'

const UA = {
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; SM-A356E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 13; SM-M146B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
  iosSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iosChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1',
  whatsappAndroid: 'Mozilla/5.0 (Linux; Android 12; RMX3511 Build/SP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.0.0 Mobile Safari/537.36 WhatsApp/2.24.1',
  instagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 340.0.0.22.109',
  facebook: 'Mozilla/5.0 (Linux; Android 14; Pixel 7; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/480.0.0.0;]',
  androidWebview: 'Mozilla/5.0 (Linux; Android 11; V2027; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36',
  iosWebview: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
}

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: k => { map.delete(k) },
    dump: () => Object.fromEntries(map),
  }
}

describe('detectInAppBrowser', () => {
  it('names the in-app browsers operators open links from', () => {
    expect(detectInAppBrowser(UA.whatsappAndroid)).toBe('whatsapp')
    expect(detectInAppBrowser(UA.instagram)).toBe('instagram')
    expect(detectInAppBrowser(UA.facebook)).toBe('facebook')
  })

  it('flags unnamed Android and iOS web views', () => {
    expect(detectInAppBrowser(UA.androidWebview)).toBe('android_webview')
    expect(detectInAppBrowser(UA.iosWebview)).toBe('ios_webview')
  })

  it('returns null for real browsers', () => {
    for (const ua of [UA.androidChrome, UA.samsung, UA.iosSafari, UA.iosChrome]) {
      expect(detectInAppBrowser(ua)).toBeNull()
    }
    expect(detectInAppBrowser('')).toBeNull()
    expect(detectInAppBrowser(undefined)).toBeNull()
  })
})

describe('deviceContext', () => {
  it('classifies platform and browser', () => {
    expect(deviceContext(UA.androidChrome)).toMatchObject({ platform: 'android', browser: 'chrome', in_app: null })
    expect(deviceContext(UA.samsung)).toMatchObject({ platform: 'android', browser: 'samsung' })
    expect(deviceContext(UA.iosSafari)).toMatchObject({ platform: 'ios', browser: 'safari' })
    expect(deviceContext(UA.iosChrome)).toMatchObject({ platform: 'ios', browser: 'chrome' })
    expect(deviceContext(UA.whatsappAndroid)).toMatchObject({ platform: 'android', browser: 'webview', in_app: 'whatsapp' })
  })

  it('truncates the user agent', () => {
    expect(deviceContext('x'.repeat(1000)).user_agent).toHaveLength(300)
  })
})

describe('sanitizeEvent', () => {
  it('keeps only known fields and rounds numbers', () => {
    const out = sanitizeEvent({ event: 'read', input: 'live', ms: 840.7, misses: 3.2, zoom: 1.2549, secret: 'x', badge: 'FB5978GA0013' })
    expect(out).toEqual({ event: 'read', input: 'live', ms: 841, misses: 3, zoom: 1.255 })
  })

  it('drops unknown events, bad numbers and oversize detail', () => {
    expect(sanitizeEvent({ event: 'nope' })).toBeNull()
    expect(sanitizeEvent(null)).toBeNull()
    expect(sanitizeEvent({ event: 'read', ms: -5, stream_w: NaN })).toEqual({ event: 'read' })
    expect(sanitizeEvent({ event: 'session', detail: { big: 'x'.repeat(3000) } })).toEqual({ event: 'session' })
    expect(sanitizeEvent({ event: 'session', detail: { reads: 2 } })).toEqual({ event: 'session', detail: { reads: 2 } })
  })

  it('does not mutate its input', () => {
    const input = Object.freeze({ event: 'read', ms: 10.4 })
    expect(() => sanitizeEvent(input)).not.toThrow()
  })
})

describe('isFatalTelemetryError', () => {
  it('treats only a missing RPC as permanent', () => {
    expect(isFatalTelemetryError({ code: 'PGRST202' })).toBe(true)
    expect(isFatalTelemetryError({ code: '42883' })).toBe(true)
    expect(isFatalTelemetryError({ status: 404 })).toBe(true)
  })

  it('treats an expired session (42501) as retryable', () => {
    expect(isFatalTelemetryError({ code: '42501' })).toBe(false)
  })

  it('treats network and server errors as retryable', () => {
    expect(isFatalTelemetryError({ message: 'Failed to fetch' })).toBe(false)
    expect(isFatalTelemetryError({ code: '57014' })).toBe(false)
    expect(isFatalTelemetryError(null)).toBe(false)
  })
})

describe('createTelemetry', () => {
  const ctx = () => ({ platform: 'android', browser: 'chrome', in_app: null, user_agent: 'ua' })

  it('stamps events with time and device context, then sends them in one batch', async () => {
    const send = vi.fn().mockResolvedValue({ error: null })
    const t = createTelemetry({ send, storage: memoryStorage(), now: () => 1762750000000, context: ctx })
    t.record({ event: 'read', input: 'live', ms: 800 })
    t.record({ event: 'photo_fail', input: 'photo' })
    await t.flush()
    expect(send).toHaveBeenCalledTimes(1)
    const batch = send.mock.calls[0][0]
    expect(batch).toHaveLength(2)
    expect(batch[0]).toMatchObject({ event: 'read', ts: 1762750000000, platform: 'android', browser: 'chrome', user_agent: 'ua' })
    expect(t.pending()).toBe(0)
  })

  it('keeps events when sending fails, and retries them on the next flush', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ error: { message: 'Failed to fetch' } })
      .mockResolvedValueOnce({ error: null })
    const t = createTelemetry({ send, storage: memoryStorage(), now: () => 1, context: ctx })
    t.record({ event: 'read' })
    await t.flush()
    expect(t.pending()).toBe(1)
    await t.flush()
    expect(t.pending()).toBe(0)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('switches off for good when the RPC is not deployed', async () => {
    const send = vi.fn().mockResolvedValue({ error: { code: 'PGRST202' } })
    const t = createTelemetry({ send, storage: memoryStorage(), now: () => 1, context: ctx })
    t.record({ event: 'read' })
    await t.flush()
    expect(t.disabled()).toBe(true)
    t.record({ event: 'read' })
    await t.flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(t.pending()).toBe(0)
  })

  it('keeps the queue through an expired session and sends it after', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ error: { code: '42501', message: 'not authorised' } })
      .mockResolvedValueOnce({ error: null })
    const t = createTelemetry({ send, storage: memoryStorage(), now: () => 1, context: ctx })
    t.record({ event: 'read' })
    await t.flush()
    expect(t.disabled()).toBe(false)
    expect(t.pending()).toBe(1)
    await t.flush()
    expect(t.pending()).toBe(0)
  })

  it('drops a batch the server keeps rejecting, so later events still go out', async () => {
    const send = vi.fn().mockResolvedValue({ error: { code: '22P02', message: 'bad input' } })
    const t = createTelemetry({ send, storage: memoryStorage(), now: () => 1, context: ctx, autoFlush: false })
    t.record({ event: 'read' })
    await t.flush(); await t.flush()
    expect(t.pending()).toBe(1)
    await t.flush()
    expect(t.pending()).toBe(0)
  })

  it('never drops on network failures, however many', async () => {
    const send = vi.fn().mockResolvedValue({ error: { message: 'Failed to fetch' } })
    const t = createTelemetry({ send, storage: memoryStorage(), now: () => 1, context: ctx, autoFlush: false })
    t.record({ event: 'read' })
    for (let i = 0; i < 6; i++) await t.flush()
    expect(t.pending()).toBe(1)
  })

  it('removes only the rows it sent when the queue was trimmed mid-flight', async () => {
    let release
    const send = vi.fn(() => new Promise(r => { release = () => r({ error: null }) }))
    const t = createTelemetry({ send, storage: memoryStorage(), now: () => 1, context: ctx, autoFlush: false })
    t.record({ event: 'read', misses: 0 })
    const inflight = t.flush()
    // Fill past the cap while the first row is in flight: the head is trimmed.
    for (let i = 1; i <= TELEMETRY_MAX_QUEUE; i++) t.record({ event: 'read', misses: i })
    release()
    await inflight
    expect(t.pending()).toBe(TELEMETRY_MAX_QUEUE)
  })

  it('treats a thrown send like a retryable failure', async () => {
    const send = vi.fn().mockRejectedValue(new Error('offline'))
    const t = createTelemetry({ send, storage: memoryStorage(), now: () => 1, context: ctx })
    t.record({ event: 'read' })
    await expect(t.flush()).resolves.toBeUndefined()
    expect(t.pending()).toBe(1)
  })

  it('flushes on its own once the batch threshold is reached', async () => {
    const send = vi.fn().mockResolvedValue({ error: null })
    const t = createTelemetry({ send, storage: memoryStorage(), now: () => 1, context: ctx })
    for (let i = 0; i < TELEMETRY_FLUSH_AT; i++) t.record({ event: 'read' })
    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('backs off auto-flushing after a failed send', async () => {
    let clock = 1000
    const send = vi.fn().mockResolvedValue({ error: { message: 'Failed to fetch' } })
    const t = createTelemetry({ send, storage: memoryStorage(), now: () => clock, context: ctx })
    for (let i = 0; i < TELEMETRY_FLUSH_AT; i++) t.record({ event: 'read' })
    await Promise.resolve(); await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 5; i++) t.record({ event: 'read' })
    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(1)
    clock += TELEMETRY_RETRY_BACKOFF_MS
    t.record({ event: 'read' })
    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('never sends two batches at once', async () => {
    let release
    const send = vi.fn(() => new Promise(r => { release = () => r({ error: null }) }))
    const t = createTelemetry({ send, storage: memoryStorage(), now: () => 1, context: ctx })
    t.record({ event: 'read' })
    const first = t.flush()
    const second = t.flush()
    release()
    await Promise.all([first, second])
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('caps the queue, dropping the oldest events', () => {
    const t = createTelemetry({ send: vi.fn(() => new Promise(() => {})), storage: memoryStorage(), now: () => 1, context: ctx, autoFlush: false })
    for (let i = 0; i < TELEMETRY_MAX_QUEUE + 25; i++) t.record({ event: 'read', misses: i })
    expect(t.pending()).toBe(TELEMETRY_MAX_QUEUE)
  })

  it('persists the queue so events survive a reload while offline', () => {
    const storage = memoryStorage()
    const a = createTelemetry({ send: vi.fn(), storage, now: () => 1, context: ctx, autoFlush: false })
    a.record({ event: 'read', ms: 5 })
    const b = createTelemetry({ send: vi.fn(), storage, now: () => 1, context: ctx, autoFlush: false })
    expect(b.pending()).toBe(1)
  })

  it('survives broken storage', () => {
    const storage = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('full') } }
    const t = createTelemetry({ send: vi.fn(), storage, now: () => 1, context: ctx, autoFlush: false })
    expect(() => t.record({ event: 'read' })).not.toThrow()
    expect(t.pending()).toBe(1)
  })

  it('ignores corrupt stored data', () => {
    const storage = memoryStorage({ 'sdp.scanTelemetry.v1': '{not json' })
    const t = createTelemetry({ send: vi.fn(), storage, now: () => 1, context: ctx, autoFlush: false })
    expect(t.pending()).toBe(0)
  })
})
