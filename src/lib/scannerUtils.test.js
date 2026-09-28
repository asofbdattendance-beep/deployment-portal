import { describe, it, expect, vi, afterEach } from 'vitest'
import { withTimeout, friendly, todayStrIST, safeOpenDB, rgbaToGray, computeRoi, waitForVideoReady, isSecureCameraContext, SCAN_RPC_TIMEOUT, MAX_DRAIN_ATTEMPTS, CACHE_TTL, withinToggleGuard, minutesSince, SCAN_TOGGLE_GUARD_MS, isDecisionPopup } from './scannerUtils'

afterEach(() => { vi.useRealTimers() })

/* ─── withTimeout ─── */
describe('withTimeout', () => {
  it('resolves when the promise settles in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000)).resolves.toBe('ok')
  })

  it('rejects with the label and the timeout in ms', async () => {
    const never = new Promise(() => {})
    await expect(withTimeout(never, 20, 'scan_in')).rejects.toThrow('scan_in timed out after 20ms')
  })

  it('propagates the original rejection, not a timeout', async () => {
    await expect(withTimeout(Promise.reject(new Error('Invalid badge')), 1000)).rejects.toThrow('Invalid badge')
  })

  it('defaults to a label when none is given', async () => {
    const never = new Promise(() => {})
    await expect(withTimeout(never, 20)).rejects.toThrow('Operation timed out after 20ms')
  })

  it('prefers whichever settles first', async () => {
    // fast success must not be overtaken by the timer
    await expect(withTimeout(Promise.resolve(1), 10_000)).resolves.toBe(1)
  })

  it('does not raise an unhandled rejection when the wrapped promise loses the race', async () => {
    // Rejects AFTER the timeout already fired. `withTimeout` attaches a no-op
    // late handler, so the rejection is swallowed — and Vitest fails the whole
    // run on any unhandled rejection, so reaching the end of this test clean
    // IS the assertion.
    const slow = new Promise((_, rej) => setTimeout(() => rej(new Error('too late')), 40))
    await expect(withTimeout(slow, 10)).rejects.toThrow('timed out')
    // outlive the late rejection so it has a chance to escape
    await new Promise((r) => setTimeout(r, 80))
    expect(true).toBe(true)
  })

  // ── Regression: the only real callers pass a supabase rpc builder ──
  //
  // `supabase.rpc(...)` returns a PostgrestBuilder, which is a bare
  // PromiseLike: it implements `then` and has NO `catch` method (verified in
  // node_modules/@supabase/postgrest-js/src/PostgrestBuilder.ts). Every test
  // above passes a genuine Promise, so none of them exercised the actual call
  // site — and calling `.catch()` on the builder threw
  // "promise.catch is not a function" inside every scan RPC, which the Scanner
  // page surfaced verbatim in its error toast.
  const thenable = (impl) => ({ then: impl })

  it('accepts a thenable that has no .catch — a supabase rpc builder', async () => {
    const builder = thenable((onFulfilled) => onFulfilled({ data: 'row', error: null }))
    expect(typeof builder.catch).toBe('undefined') // the shape under test
    await expect(withTimeout(builder, 1000)).resolves.toEqual({ data: 'row', error: null })
  })

  it('still times out when a thenable never settles', async () => {
    const builder = thenable(() => {}) // never calls back
    await expect(withTimeout(builder, 20, 'scan_in')).rejects.toThrow('scan_in timed out after 20ms')
  })

  it('propagates a thenable rejection, not a timeout', async () => {
    const builder = thenable((_onFulfilled, onRejected) => onRejected(new Error('Invalid badge')))
    await expect(withTimeout(builder, 1000, 'scan_in')).rejects.toThrow('Invalid badge')
  })
})

/* ─── friendly ─── */
describe('friendly', () => {
  it('maps the scanner RPC errors to human text', () => {
    expect(friendly('Invalid badge format')).toBe('Invalid badge format')
    expect(friendly('Badge not found')).toBe('Badge not found in sewadars/VSS')
    expect(friendly('No open session to close')).toBe('No open session to close')
    expect(friendly('Not authorized to scan')).toBe('Not authorized to scan')
    expect(friendly('Already IN — please OUT first')).toBe('Already checked IN — please OUT first')
  })
  it('maps network failures to the offline message', () => {
    expect(friendly('Failed to fetch')).toBe('Network error — will retry when online')
  })
  it('passes a timeout message through unchanged', () => {
    expect(friendly('scan_in timed out after 8000ms')).toBe('scan_in timed out after 8000ms')
  })
  it('returns an unmapped message verbatim', () => {
    expect(friendly('Department quota already exhausted')).toBe('Department quota already exhausted')
  })
  it('falls back to a generic message for empty input', () => {
    expect(friendly('')).toBe('Scan failed — try again')
    expect(friendly(null)).toBe('Scan failed — try again')
    expect(friendly(undefined)).toBe('Scan failed — try again')
  })
  it('tolerates non-string input', () => {
    expect(friendly({ message: 'x' })).toBe('[object Object]')
  })
})

/* ─── todayStrIST ─── */
describe('todayStrIST', () => {
  it('formats as YYYY-MM-DD in IST regardless of the input instant', () => {
    // 2026-09-23T18:30:00Z is already the 24th in IST (+05:30)
    expect(todayStrIST(new Date('2026-09-23T18:30:00Z'))).toBe('2026-09-24')
  })
  it('does not shift a mid-IST-morning instant back a day', () => {
    // 2026-09-24T04:00:00Z is 09:30 IST on the 24th
    expect(todayStrIST(new Date('2026-09-24T04:00:00Z'))).toBe('2026-09-24')
  })
  it('defaults to now', () => {
    expect(todayStrIST()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

/* ─── safeOpenDB ─── */
describe('safeOpenDB in node (no window.indexedDB)', () => {
  it('resolves null instead of throwing when IndexedDB is unavailable', async () => {
    // this suite runs in the default node env, where `window` is undefined
    await expect(safeOpenDB('sewadar_offline_q_test', 1)).resolves.toBeNull()
  })
})

/* ─── constants ─── */
describe('scanner constants', () => {
  it('keeps the documented timeouts', () => {
    expect(SCAN_RPC_TIMEOUT).toBe(8000)
    expect(CACHE_TTL).toBe(10 * 60 * 1000)
    expect(MAX_DRAIN_ATTEMPTS).toBe(12)
  })
})

/* ─── rgbaToGray ─── */
describe('rgbaToGray', () => {
  const img = (w, h, pixelAt) => {
    const data = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const [r, g, b] = pixelAt(x, y)
        const i = (y * w + x) * 4
        data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255
      }
    }
    return { data, width: w, height: h }
  }

  it('collapses 4 bytes-per-pixel RGBA down to 1 byte-per-pixel', () => {
    const out = rgbaToGray(img(4, 3, () => [10, 20, 30]))
    expect(out).toBeInstanceOf(Uint8ClampedArray)
    expect(out.length).toBe(4 * 3)          // NOT 4*3*4
  })

  it('uses luma weights, not a flat channel average', () => {
    // Pure red luma = 0.299*255 ~= 76. A flat average would give 85.
    const out = rgbaToGray(img(1, 1, () => [255, 0, 0]))
    expect(out[0]).toBeGreaterThanOrEqual(75)
    expect(out[0]).toBeLessThanOrEqual(77)
  })

  it('maps black to 0 and white to 255', () => {
    expect(rgbaToGray(img(1, 1, () => [0, 0, 0]))[0]).toBe(0)
    expect(rgbaToGray(img(1, 1, () => [255, 255, 255]))[0]).toBe(255)
  })

  it('preserves row-major order so the bitmap is not transposed', () => {
    const out = rgbaToGray(img(2, 2, (x, y) => (y === 0 ? [0, 0, 0] : [255, 255, 255])))
    expect([...out]).toEqual([0, 0, 255, 255])
  })

  it('ignores the alpha channel', () => {
    const imageData = img(1, 1, () => [255, 255, 255])
    imageData.data[3] = 0
    expect(rgbaToGray(imageData)[0]).toBe(255)
  })
})

/* ─── computeRoi ─── */
describe('computeRoi', () => {
  it('crops a centred horizontal band and downscales it to maxWidth', () => {
    const roi = computeRoi(1280, 720, { mode: 'band', maxWidth: 720 })
    expect(roi.sx).toBe(51)            // (1280 - 1178) / 2
    expect(roi.sy).toBe(137)           // (720 - 446) / 2
    expect(roi.sw).toBe(1178)          // 92% of width
    expect(roi.sh).toBe(446)           // 62% of height
    expect(roi.dw).toBe(720)           // clamped to maxWidth
    expect(roi.dh).toBeLessThan(roi.sh)
    expect(roi.scale).toBeLessThan(1)
  })

  it('uses the whole frame in full mode (adaptive widening after repeated misses)', () => {
    const roi = computeRoi(1280, 720, { mode: 'full', maxWidth: 720 })
    expect(roi.sx).toBe(0)
    expect(roi.sy).toBe(0)
    expect(roi.sw).toBe(1280)
    expect(roi.sh).toBe(720)
    expect(roi.dw).toBe(720)
  })

  it('does not upscale when the crop is already narrower than maxWidth', () => {
    const roi = computeRoi(640, 480, { mode: 'band', maxWidth: 720 })
    expect(roi.scale).toBe(1)
    expect(roi.dw).toBe(roi.sw)
    expect(roi.dh).toBe(roi.sh)
  })

  it('returns a zero rect for an unready video instead of NaN', () => {
    expect(computeRoi(0, 0)).toEqual({ sx: 0, sy: 0, sw: 0, sh: 0, dw: 0, dh: 0, scale: 1 })
  })

  it('always produces a destination of at least 1px', () => {
    const roi = computeRoi(1, 1, { mode: 'band', maxWidth: 0.0001 })
    expect(roi.dw).toBeGreaterThanOrEqual(1)
    expect(roi.dh).toBeGreaterThanOrEqual(1)
  })
})

/* ─── waitForVideoReady ─── */
describe('waitForVideoReady', () => {
  const makeVideo = (init = {}) => {
    const listeners = {}
    return {
      readyState: init.readyState ?? 0,
      videoWidth: init.videoWidth ?? 0,
      videoHeight: init.videoHeight ?? 0,
      addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn) },
      removeEventListener: (t, fn) => { listeners[t] = (listeners[t] || []).filter(f => f !== fn) },
      emit: (t) => { (listeners[t] || []).slice().forEach(f => f()) },
      pending: (t) => (listeners[t] || []).length,
    }
  }

  it('resolves immediately when the video already has frames', async () => {
    const v = makeVideo({ readyState: 4, videoWidth: 640, videoHeight: 480 })
    await expect(waitForVideoReady(v, 50)).resolves.toEqual({ width: 640, height: 480 })
  })

  it('resolves once loadeddata reports real dimensions', async () => {
    const v = makeVideo()
    const p = waitForVideoReady(v, 500)
    v.readyState = 2; v.videoWidth = 1280; v.videoHeight = 720
    v.emit('loadeddata')
    await expect(p).resolves.toEqual({ width: 1280, height: 720 })
  })

  it('resolves (not throws) on timeout so a slow device still gets a preview', async () => {
    const v = makeVideo()
    await expect(waitForVideoReady(v, 20)).resolves.toEqual({ width: 0, height: 0, timedOut: true })
  })

  it('detaches every listener it registered', async () => {
    const v = makeVideo()
    await waitForVideoReady(v, 20)
    expect(v.pending('loadeddata')).toBe(0)
    expect(v.pending('loadedmetadata')).toBe(0)
    expect(v.pending('canplay')).toBe(0)
  })
})

/* ─── isSecureCameraContext ─── */
describe('isSecureCameraContext', () => {
  it('is false in the node env (no window / no mediaDevices)', () => {
    expect(isSecureCameraContext()).toBe(false)
  })
})

/* ─── withinToggleGuard (v44) ─── */
describe('withinToggleGuard', () => {
  const NOW = 1_757_000_000_000
  const H = 3600_000

  it('guards a toggle 1 minute after the previous event', () => {
    expect(withinToggleGuard(NOW - 60_000, NOW)).toBe(true)
  })

  it('guards a toggle 59 minutes 59s after the previous event', () => {
    expect(withinToggleGuard(NOW - (59 * 60_000 + 59_000), NOW)).toBe(true)
  })

  it('does NOT guard at exactly 1h (strictly-less-than boundary)', () => {
    expect(withinToggleGuard(NOW - H, NOW)).toBe(false)
  })

  it('does not guard past the window', () => {
    expect(withinToggleGuard(NOW - (H + 1), NOW)).toBe(false)
    expect(withinToggleGuard(NOW - (3 * H), NOW)).toBe(false)
  })

  it('does NOT guard an unknown timestamp — a first-ever scan must never be prompted', () => {
    expect(withinToggleGuard(NaN, NOW)).toBe(false)
    expect(withinToggleGuard(undefined, NOW)).toBe(false)
    expect(withinToggleGuard('yesterday', NOW)).toBe(false)
  })

  it('DOES guard a future timestamp (device/server clock skew) — ask when in doubt', () => {
    expect(withinToggleGuard(NOW + 60_000, NOW)).toBe(true)
    expect(withinToggleGuard(NOW + (5 * H), NOW)).toBe(true)
  })

  it('honours a custom window', () => {
    expect(withinToggleGuard(NOW - (3 * H), NOW, 4 * H)).toBe(true)
    expect(withinToggleGuard(NOW - (5 * H), NOW, 4 * H)).toBe(false)
  })

  it('defaults to a 1-hour window', () => {
    expect(SCAN_TOGGLE_GUARD_MS).toBe(60 * 60 * 1000)
    expect(withinToggleGuard(Date.now() - (30 * 60_000))).toBe(true)
    expect(withinToggleGuard(Date.now() - (90 * 60_000))).toBe(false)
  })
})

/* ─── minutesSince (v44) ─── */
describe('minutesSince', () => {
  const NOW = 1_757_000_000_000
  it('rounds to the nearest minute', () => {
    expect(minutesSince(NOW - (8 * 60_000), NOW)).toBe('8')
    expect(minutesSince(NOW - (8 * 60_000 + 20_000), NOW)).toBe('8')
    expect(minutesSince(NOW - (8 * 60_000 + 40_000), NOW)).toBe('9')
  })
  it('floors at 0 for a future or unknown timestamp — never a negative age', () => {
    expect(minutesSince(NOW + (10 * 60_000), NOW)).toBe('0')
    expect(minutesSince(NaN, NOW)).toBe('0')
  })
})

/* ─── isDecisionPopup (v44 camera pause) ─── */
describe('isDecisionPopup', () => {
  it('gates the two confirm gates and the forgot prompt', () => {
    expect(isDecisionPopup('confirm_out')).toBe(true)
    expect(isDecisionPopup('confirm_in')).toBe(true)
    expect(isDecisionPopup('forgot')).toBe(true)
  })

  it('does NOT gate anything else — rapid scanning and retries must keep working', () => {
    // `error` is excluded on purpose: the lookup-timeout and storage-failure
    // paths explicitly ask the operator to retry the scan.
    for (const s of ['in', 'out', 'flagged', 'queued', 'offline', 'error', undefined, null, '']) {
      expect(isDecisionPopup(s)).toBe(false)
    }
  })
})
