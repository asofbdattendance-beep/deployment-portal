import { describe, it, expect, vi, afterEach } from 'vitest'
import { withTimeout, friendly, todayStrIST, hhmmIST, hmsIST, resolveForgotOutTime, FORGOT_OUT_MIN_GAP_MIN, safeOpenDB, rgbaToGray, computeRoi, waitForVideoReady, isSecureCameraContext, SCAN_RPC_TIMEOUT, MAX_DRAIN_ATTEMPTS, CACHE_TTL, isDecisionPopup, isEdgeDetection, detectionBox, isTimestampStale, CLOCK_SKEW_FUTURE_MS, CLOCK_SKEW_MAX_AGE_MS, rotateGray, SCAN_ROTATIONS, sanitizeBarcode, scoreSharpness, tileRois } from './scannerUtils'

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

/* ─── hhmmIST (A4 / L-05) ─── */
describe('hhmmIST', () => {
  it('formats in IST regardless of the device zone', () => {
    // 18:30Z = 00:00 IST next day. A device set to UTC would have said "18:30".
    expect(hhmmIST(new Date('2026-09-24T18:30:00Z'))).toBe('00:00')
    expect(hhmmIST(new Date('2026-09-24T04:05:00Z'))).toBe('09:35')  // UTC+5:30
    expect(hhmmIST(new Date('2026-09-24T12:00:00Z'))).toBe('17:30')
  })
  it('never emits the h24 "24:00" midnight form', () => {
    expect(hhmmIST(new Date('2026-09-24T18:05:00Z'))).toBe('23:35')  // 00:05 IST
  })
})

/* ─── hmsIST — the seconds-precision sibling, for the popup event stamp ─── */
describe('hmsIST', () => {
  it('formats HH:MM:SS in IST regardless of the device zone', () => {
    expect(hmsIST(new Date('2026-09-24T12:00:00Z'))).toBe('17:30:00')
    expect(hmsIST(new Date('2026-09-24T04:05:07Z'))).toBe('09:35:07')
    // Keeps seconds — the `in_time`/`out_time` columns are stored at second
    // resolution, so a minute-only stamp would disagree with the record.
    expect(hmsIST(new Date('2026-09-27T12:34:56Z'))).toBe('18:04:56')
  })
  it('rolls over midnight into a zero-padded IST second day', () => {
    // UTC 18:30 == IST 00:00 next day — the h23 rollover the h24 quirk hides.
    expect(hmsIST(new Date('2026-09-24T18:30:09Z'))).toBe('00:00:09')
    expect(hmsIST(new Date('2026-09-24T18:35:59Z'))).toBe('00:05:59')
  })
  it('never emits the h24 "24:00" form and always pads to 8 chars', () => {
    expect(hmsIST(new Date('2026-09-24T17:30:00Z'))).toBe('23:00:00')
    expect(hmsIST(new Date('2026-09-24T18:30:00Z'))).toBe('00:00:00')
    expect(hmsIST(new Date('2026-09-24T12:00:03Z'))).toMatch(/^.{2}:\d{2}:\d{2}$/)
  })
})

/* ─── resolveForgotOutTime (A4 / L-05 + L-37) ─── */
describe('resolveForgotOutTime', () => {
  const NOW = new Date('2026-09-24T10:00:00Z')  // 15:30 IST
  it('pre-fills with IST now, not the device clock', () => {
    const r = resolveForgotOutTime({ inDate: '2026-09-24', inTime: '08:00:00', nowMs: NOW.getTime() })
    expect(r.value).toBe('15:30')
    expect(r.clamped).toBeNull()
    expect(r.invalid).toBe(false)
  })
  it('clamps a future value to now (device clock ahead)', () => {
    const r = resolveForgotOutTime({ inDate: '2026-09-24', inTime: '08:00:00', value: '23:45', nowMs: NOW.getTime() })
    expect(r.value).toBe('15:30')
    expect(r.clamped).toBe('future')
    expect(r.ts).toBeLessThanOrEqual(NOW.getTime())
  })
  it('clamps a pre-IN value to in_time + 1 minute (v41 would raise)', () => {
    const r = resolveForgotOutTime({ inDate: '2026-09-24', inTime: '14:00:00', value: '09:00', nowMs: NOW.getTime() })
    expect(r.value).toBe('14:01')
    expect(r.clamped).toBe('before_in')
  })
  it('never returns the same minute as the IN (server rejects out <= in)', () => {
    const r = resolveForgotOutTime({ inDate: '2026-09-24', inTime: '15:30:00', value: '15:30', nowMs: NOW.getTime() })
    expect(r.value).toBe('15:31')   // same minute as IN → floored to in_time + 1
    expect(r.clamped).toBe('before_in')
    const floor = resolveForgotOutTime({ inDate: '2026-09-24', inTime: '15:31:00', value: '15:29', nowMs: NOW.getTime() })
    expect(floor.value).toBe('15:32')
    expect(FORGOT_OUT_MIN_GAP_MIN).toBe(1)
  })
  it('flags malformed values instead of throwing', () => {
    for (const v of ['', 'ab:cd', '25:00', '12:70', '9:5', null, undefined]) {
      expect(() => resolveForgotOutTime({ inDate: '2026-09-24', inTime: '08:00:00', value: v, nowMs: NOW.getTime() })).not.toThrow()
    }
    expect(resolveForgotOutTime({ inDate: '2026-09-24', inTime: '08:00:00', value: '25:00', nowMs: NOW.getTime() }).invalid).toBe(true)
    expect(resolveForgotOutTime({ inDate: '2026-09-24', inTime: '08:00:00', value: '09:00', nowMs: NOW.getTime() }).invalid).toBe(false)
  })
  it('degrades to future-only clamping when in_time is unknown (pre-v44 popup)', () => {
    const r = resolveForgotOutTime({ inDate: '2026-09-24', inTime: null, value: '09:00', nowMs: NOW.getTime() })
    expect(r.value).toBe('09:00'); expect(r.clamped).toBeNull(); expect(r.invalid).toBe(false)
  })
  it('prefers the IN floor when the window is empty (IN ahead of this clock)', () => {
    const r = resolveForgotOutTime({ inDate: '2026-09-24', inTime: '23:00:00', nowMs: NOW.getTime() })
    expect(r.value).toBe('23:01')
    expect(r.clamped).toBe('before_in')
  })
  it('round-trips: every returned ts is strictly after inTs', () => {
    const inTs = Date.parse('2026-09-24T08:00:00+05:30')
    for (const v of ['08:00', '08:01', '12:00', '15:30', '15:31', '23:59', null]) {
      const r = resolveForgotOutTime({ inDate: '2026-09-24', inTime: '08:00:00', value: v, nowMs: NOW.getTime() })
      expect(r.ts).toBeGreaterThan(inTs)
      expect(r.ts).toBeLessThanOrEqual(NOW.getTime())
    }
  })
  // T7: a true post-midnight OUT must credit the next day, not the IN's date.
  // IN 2026-10-01 09:00 IST, now 2026-10-02 10:00 IST (forgot context, >12h).
  // NOTE: the issued spec wrote "enter 18:00" here, but 18:00 is AFTER the
  // 09:00 IN so it never rolls — it stays on the IN day by design (pinned
  // below). The roll fires for a wall time BEFORE the IN time: 08:00.
  it('rolls a pre-IN wall time to the next day, accepted unclamped', () => {
    const nowMs = Date.parse('2026-10-02T10:00:00+05:30')
    const r = resolveForgotOutTime({ inDate: '2026-10-01', inTime: '09:00:00', value: '08:00', nowMs })
    expect(r.invalid).toBe(false)
    expect(r.clamped).toBeNull()
    expect(r.outDate).toBe('2026-10-02')
    expect(r.value).toBe('08:00')
    expect(r.ts).toBe(Date.parse('2026-10-02T08:00:00+05:30'))
  })
  it('keeps an evening wall time on the IN day (after IN — no roll)', () => {
    const nowMs = Date.parse('2026-10-02T10:00:00+05:30')
    const r = resolveForgotOutTime({ inDate: '2026-10-01', inTime: '09:00:00', value: '18:00', nowMs })
    expect(r.invalid).toBe(false)
    expect(r.clamped).toBeNull()
    expect(r.outDate).toBe('2026-10-01')
    expect(r.ts).toBe(Date.parse('2026-10-01T18:00:00+05:30'))
  })
  it('clamps before_in when the next-day occurrence has not happened yet', () => {
    const nowMs = Date.parse('2026-10-01T10:00:00+05:30')
    const r = resolveForgotOutTime({ inDate: '2026-10-01', inTime: '09:00:00', value: '08:00', nowMs })
    expect(r.invalid).toBe(false)
    expect(r.clamped).toBe('before_in')
    expect(r.value).toBe('09:01')
    expect(r.outDate).toBe('2026-10-01')
  })
  it('clamps a future wall time to now', () => {
    const nowMs = Date.parse('2026-10-01T10:00:00+05:30')
    const r = resolveForgotOutTime({ inDate: '2026-10-01', inTime: '09:00:00', value: '18:00', nowMs })
    expect(r.invalid).toBe(false)
    expect(r.clamped).toBe('future')
    expect(r.value).toBe('10:00')
    expect(r.ts).toBe(nowMs)
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

  // L-21: one decode per frame means one allocation per frame stalls low-end
  // phones in GC. Same-size frames must share a single scratch buffer.
  it('reuses one scratch buffer across same-size frames', () => {
    const a = rgbaToGray(img(2, 1, () => [255, 0, 0]))
    const b = rgbaToGray(img(2, 1, () => [0, 0, 0]))
    expect(b).toBe(a)
    expect([...b]).toEqual([0, 0])
  })

  it('reallocates when the frame size changes, values still correct', () => {
    rgbaToGray(img(2, 1, () => [255, 255, 255]))
    const out = rgbaToGray(img(3, 1, () => [0, 0, 0]))
    expect(out.length).toBe(3)
    expect([...out]).toEqual([0, 0, 0])
  })
})

/* ─── computeRoi ─── */describe('computeRoi', () => {
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

/* ─── isDecisionPopup (explicit choice + forgot camera pause) ─── */
describe('isDecisionPopup', () => {
  it('gates the choose popup, the forgot prompt (and retired confirm gates)', () => {
    expect(isDecisionPopup('choose')).toBe(true)
    expect(isDecisionPopup('forgot')).toBe(true)
    // Retired v44 gates are kept in the check so a stale popup can never
    // slip through and get swapped underneath the operator.
    expect(isDecisionPopup('confirm_out')).toBe(true)
    expect(isDecisionPopup('confirm_in')).toBe(true)
  })

  it('does NOT gate anything else — rapid scanning and retries must keep working', () => {
    // `error` is excluded on purpose: the lookup-timeout and storage-failure
    // paths explicitly ask the operator to retry the scan.
    for (const s of ['in', 'out', 'flagged', 'queued', 'offline', 'error', undefined, null, '']) {
      expect(isDecisionPopup(s)).toBe(false)
    }
  })
})

/* ─── isEdgeDetection (L-15: ZXing must be judged like Native) ─── */
describe('isEdgeDetection', () => {
  // Points arrive in detect-canvas coordinates; the helper maps them back to
  // video pixels exactly as the old inline guard did.
  const full = computeRoi(1280, 720, { mode: 'full', maxWidth: 720 })

  it('accepts a centred 4-point native quad (legacy behaviour unchanged)', () => {
    const quad = [{ x: 300, y: 150 }, { x: 420, y: 150 }, { x: 420, y: 250 }, { x: 300, y: 250 }]
    expect(isEdgeDetection(quad, full, 1280, 720)).toBe(false)
  })

  it('rejects a 4-point quad hugging the left edge', () => {
    const quad = [{ x: 0, y: 200 }, { x: 8, y: 200 }, { x: 8, y: 220 }, { x: 0, y: 220 }]
    expect(isEdgeDetection(quad, full, 1280, 720)).toBe(true)
  })

  it('judges a 2-point ZXing pair — centred pairs pass', () => {
    expect(isEdgeDetection([{ x: 300, y: 200 }, { x: 420, y: 200 }], full, 1280, 720)).toBe(false)
  })

  it('judges a 2-point ZXing pair — edge pairs are rejected', () => {
    expect(isEdgeDetection([{ x: 0, y: 200 }, { x: 8, y: 200 }], full, 1280, 720)).toBe(true)
  })

  it('never blocks on degenerate input: empty, short, missing, or video-less', () => {
    expect(isEdgeDetection([], full, 1280, 720)).toBe(false)
    expect(isEdgeDetection(undefined, full, 1280, 720)).toBe(false)
    expect(isEdgeDetection([{ x: 0, y: 0 }], full, 1280, 720)).toBe(false)
    expect(isEdgeDetection([{ x: 0, y: 200 }, { x: 8, y: 200 }], full, 0, 720)).toBe(false)
  })
})

/* ─── detectionBox (aim overlay: canvas → video → css under object-fit:cover) ─── */
describe('detectionBox', () => {
  const full = computeRoi(1280, 720, { mode: 'full', maxWidth: 720 }) // dw 720, dh 405

  it('maps a centred 2-point ZXing pair and grows the hairline to a usable target', () => {
    // ZXing's 1D readers emit only the two ends of the bar line: bbox height 0.
    const box = detectionBox([{ x: 200, y: 200 }, { x: 520, y: 200 }], full, 1280, 720, { width: 1280, height: 720 })
    expect(box).not.toBeNull()
    // rect matches the video exactly here, so cover scale is 1 and the maths
    // reduces to the plain canvas→video mapping (dw=720 over sw=1280).
    expect(box.width).toBeCloseTo(568.9, 0)
    // the raw bbox height is 0 (two collinear points) — the overlay must grow
    // it into something the operator can actually aim at
    expect(box.height).toBeGreaterThan(48)
    // grown around the same centre at the barcode-ish ~3.2:1 proportion
    expect(box.height).toBeCloseTo(box.width / 3.2, 0)
    expect(box.left + box.width / 2).toBeCloseTo(640, 0)
    expect(box.top + box.height / 2).toBeCloseTo(355.6, 0)
  })

  it('centres correctly through object-fit: cover letterboxing', () => {
    // Square container vs 16:9 video → cover scales on height and crops the
    // sides, so offX is negative. A detection at the video's centre must land
    // at the container's centre, not at video_width/2.
    const pts = [{ x: 340, y: 202.5 }, { x: 380, y: 202.5 }]
    const box = detectionBox(pts, full, 1280, 720, { width: 400, height: 400 })
    expect(box).not.toBeNull()
    expect(box.left + box.width / 2).toBeCloseTo(200, 0)
    expect(box.top + box.height / 2).toBeCloseTo(200, 0)
  })

  it('keeps the box inside the container when the detection is at the edge', () => {
    const pts = [{ x: 700, y: 200 }, { x: 719, y: 200 }]
    const rect = { width: 1280, height: 720 }
    const box = detectionBox(pts, full, 1280, 720, rect)
    expect(box).not.toBeNull()
    expect(box.left).toBeGreaterThanOrEqual(0)
    expect(box.top).toBeGreaterThanOrEqual(0)
    expect(box.left + box.width).toBeLessThanOrEqual(rect.width + 1e-6)
    expect(box.top + box.height).toBeLessThanOrEqual(rect.height + 1e-6)
  })

  it('grows a tall thin detection too (barcode held vertically)', () => {
    const pts = [{ x: 300, y: 40 }, { x: 300, y: 180 }]
    const box = detectionBox(pts, full, 1280, 720, { width: 1280, height: 720 })
    expect(box).not.toBeNull()
    expect(box.width).toBeGreaterThan(48)
    expect(box.width).toBeCloseTo(box.height / 3.2, 0)
  })

  it('returns null on degenerate input rather than drawing a bogus rectangle', () => {
    const rect = { width: 1280, height: 720 }
    const pts = [{ x: 300, y: 200 }, { x: 420, y: 200 }]
    expect(detectionBox([], full, 1280, 720, rect)).toBeNull()
    expect(detectionBox(undefined, full, 1280, 720, rect)).toBeNull()
    expect(detectionBox([{ x: 300, y: 200 }], full, 1280, 720, rect)).toBeNull()
    expect(detectionBox(pts, full, 0, 720, rect)).toBeNull()
    expect(detectionBox(pts, full, 1280, 720, null)).toBeNull()
    expect(detectionBox(pts, full, 1280, 720, { width: 0, height: 0 })).toBeNull()
    expect(detectionBox(pts, { sx: 0, sy: 0, sw: 0, sh: 0, dw: 0, dh: 0 }, 1280, 720, rect)).toBeNull()
    // non-finite coordinates must not produce NaN geometry
    expect(detectionBox([{ x: NaN, y: NaN }, { x: Infinity, y: 0 }], full, 1280, 720, rect)).toBeNull()
  })
})

/* ─── isTimestampStale (V14: client clock-skew budget) ─── */
// Mirrors the server guards (v26/v46: future beyond now()+5min raises
// 'Timestamp cannot be in the future'; older than now()-30d raises
// 'Timestamp too old'). The hook uses it to surface 'Device clock looks
// wrong' instead of the raw server text — without changing sent values.
describe('isTimestampStale (V14 clock-skew budget)', () => {
  const NOW = 1_757_000_000_000
  const MIN = 60_000
  const DAY = 24 * 3600_000

  it('exposes the server-matching budgets as constants', () => {
    expect(CLOCK_SKEW_FUTURE_MS).toBe(5 * MIN)
    expect(CLOCK_SKEW_MAX_AGE_MS).toBe(30 * DAY)
  })

  it('V14 flags a timestamp more than 5 min in the future as stale', () => {
    expect(isTimestampStale(NOW + 5 * MIN + 1, NOW)).toBe(true)
    expect(isTimestampStale(NOW + 3600_000, NOW)).toBe(true)
  })

  it('V14 accepts exactly +5 min (server leeway is inclusive: only > raises)', () => {
    expect(isTimestampStale(NOW + 5 * MIN, NOW)).toBe(false)
    expect(isTimestampStale(NOW, NOW)).toBe(false)
    expect(isTimestampStale(NOW - 1000, NOW)).toBe(false)
  })

  it('V14 flags a timestamp more than 30 days old as stale', () => {
    expect(isTimestampStale(NOW - 30 * DAY - 1, NOW)).toBe(true)
    expect(isTimestampStale(NOW - 60 * DAY, NOW)).toBe(true)
  })

  it('V14 accepts exactly -30 days (server floor is inclusive: only < raises)', () => {
    expect(isTimestampStale(NOW - 30 * DAY, NOW)).toBe(false)
    expect(isTimestampStale(NOW - 29 * DAY, NOW)).toBe(false)
  })

  it('V14 never flags an unknown timestamp — a missing ts must not strand a scan', () => {
    for (const bad of [NaN, undefined, null, Infinity, 'x']) {
      expect(isTimestampStale(bad, NOW)).toBe(false)
    }
    expect(isTimestampStale(NOW, NaN)).toBe(false)
  })

  it('V14 honours an explicit nowMs instead of the wall clock', () => {
    expect(isTimestampStale(1_000_000, 2_000_000)).toBe(false)
    expect(isTimestampStale(2_000_000 + 5 * MIN + 1, 2_000_000)).toBe(true)
  })
})

/* ─── rotateGray ─── */
describe('rotateGray', () => {
  // 4×3 source so the CW/CCW results are hand-checkable:
  //   0  1  2  3
  //   4  5  6  7
  //   8  9 10 11
  const src = new Uint8ClampedArray([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])

  it('90° swaps dimensions and rotates clockwise', () => {
    const r = rotateGray(src, 4, 3, 90)
    expect(r.width).toBe(3)
    expect(r.height).toBe(4)
    expect([...r.gray]).toEqual([8, 4, 0, 9, 5, 1, 10, 6, 2, 11, 7, 3])
  })

  it('270° swaps dimensions and rotates counter-clockwise', () => {
    const r = rotateGray(src, 4, 3, 270)
    expect(r.width).toBe(3)
    expect(r.height).toBe(4)
    expect([...r.gray]).toEqual([3, 7, 11, 2, 6, 10, 1, 5, 9, 0, 4, 8])
  })

  it('180° keeps dimensions and reverses the buffer', () => {
    const r = rotateGray(src, 4, 3, 180)
    expect(r.width).toBe(4)
    expect(r.height).toBe(3)
    expect([...r.gray]).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0])
  })

  it('90° then 270° is a lossless round-trip (the hard path relies on this)', () => {
    const rt = rotateGray(rotateGray(src, 4, 3, 90).gray, 3, 4, 270)
    expect(rt.width).toBe(4)
    expect(rt.height).toBe(3)
    expect([...rt.gray]).toEqual([...src])
  })

  it('exposes exactly the three worth-trying angles', () => {
    expect(SCAN_ROTATIONS).toEqual([90, 180, 270])
  })

  it('returns the input untouched for 0° and unsupported angles', () => {
    for (const deg of [0, 45, 12, NaN]) {
      const r = rotateGray(src, 4, 3, deg)
      expect(r.width).toBe(4)
      expect(r.height).toBe(3)
      expect([...r.gray]).toEqual([...src])
    }
  })

  it('normalises signed / oversized angles instead of rejecting them', () => {
    // −90° is 270°, and 450° is 90° — both are real rotations a caller may
    // legitimately compute, so they must rotate rather than silently no-op.
    expect([...rotateGray(src, 4, 3, -90).gray]).toEqual([...rotateGray(src, 4, 3, 270).gray])
    expect([...rotateGray(src, 4, 3, 450).gray]).toEqual([...rotateGray(src, 4, 3, 90).gray])
    expect(rotateGray(src, 4, 3, -90).width).toBe(3)
    expect(rotateGray(src, 4, 3, 450).width).toBe(3)
  })

  it('rejects empty/short buffers instead of reading out of bounds', () => {
    for (const bad of [null, undefined, new Uint8ClampedArray(0), new Uint8ClampedArray(4)]) {
      const r = rotateGray(bad, 4, 3, 90)
      expect(r.width).toBe(0)
      expect(r.gray.length).toBe(0)
    }
  })
})

/* ─── sanitizeBarcode ─── */
describe('sanitizeBarcode', () => {
  it('passes a canonical badge through unchanged', () => {
    expect(sanitizeBarcode('FB5978GA0005')).toBe('FB5978GA0005')
    expect(sanitizeBarcode('VSFB5978GA2644')).toBe('VSFB5978GA2644')
    expect(sanitizeBarcode('982762371')).toBe('982762371')
  })

  it('strips Code 39 start/stop guards (the common bad read)', () => {
    expect(sanitizeBarcode('*FB5978GA0005*')).toBe('FB5978GA0005')
    expect(sanitizeBarcode('**VS123**')).toBe('VS123')
  })

  it('uppercases and trims printer noise / whitespace / separators', () => {
    expect(sanitizeBarcode('  fb5978ga0005  ')).toBe('FB5978GA0005')
    expect(sanitizeBarcode('FB5978-GA0005')).toBe('FB5978GA0005')
    expect(sanitizeBarcode('982 762 371')).toBe('982762371')
    expect(sanitizeBarcode('FB5978GA0005\n')).toBe('FB5978GA0005')
  })

  it('never touches digit identity (leading zeros are meaningful)', () => {
    expect(sanitizeBarcode('FB0001')).toBe('FB0001')
    expect(sanitizeBarcode('VS000')).toBe('VS000')
    expect(sanitizeBarcode('000123')).toBe('000123')
  })

  it('returns an empty string for empty/undefined input', () => {
    for (const bad of [null, undefined, '', '   ', '*', '***']) {
      expect(sanitizeBarcode(bad)).toBe('')
    }
  })
})

/* ─── scoreSharpness ─── */
describe('scoreSharpness', () => {
  it('a flat frame has no detail — score 0', () => {
    const flat = new Uint8ClampedArray(100).fill(128)
    expect(scoreSharpness(flat, 10, 10)).toBe(0)
  })

  it('a hard edge scores higher than a smeared one (why we pick the best frame)', () => {
    const n = 16
    const sharp = new Uint8ClampedArray(n * n)
    const soft = new Uint8ClampedArray(n * n)
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        sharp[y * n + x] = x < 8 ? 0 : 255          // a crisp vertical edge
        // soft: same layout but a 1px gradient on each side of the edge
        const d = Math.abs(x - 7.5)
        soft[y * n + x] = d <= 1 ? 128 : (x < 8 ? 0 : 255)
      }
    }
    expect(scoreSharpness(sharp, n, n)).toBeGreaterThan(scoreSharpness(soft, n, n))
  })

  it('returns 0 for buffers too small to convolve (never throws)', () => {
    expect(scoreSharpness(new Uint8ClampedArray(4), 2, 2)).toBe(0)
    expect(scoreSharpness(new Uint8ClampedArray(0), 10, 10)).toBe(0)
    expect(scoreSharpness(null, 10, 10)).toBe(0)
    expect(scoreSharpness(undefined, 10, 10)).toBe(0)
  })
})

/* ─── tileRois ─── */
describe('tileRois', () => {
  const roi = { sx: 10, sy: 20, sw: 100, sh: 60, dw: 720, dh: 432, scale: 0.72 }

  it('a 1×1 grid returns the parent roi itself', () => {
    const tiles = tileRois(roi, { rows: 1, cols: 1 })
    expect(tiles).toHaveLength(1)
    expect(tiles[0].sx).toBe(10)
    expect(tiles[0].sw).toBe(100)
    expect(tiles[0].dw).toBe(72)
  })

  it('produces exactly rows×cols tiles, all inside the parent bounds', () => {
    const tiles = tileRois(roi, { rows: 3, cols: 2 })
    expect(tiles).toHaveLength(6)
    for (const t of tiles) {
      expect(t.sx).toBeGreaterThanOrEqual(roi.sx)
      expect(t.sy).toBeGreaterThanOrEqual(roi.sy)
      expect(t.sx + t.sw).toBeLessThanOrEqual(roi.sx + roi.sw)
      expect(t.sy + t.sh).toBeLessThanOrEqual(roi.sy + roi.sh)
      expect(t.dw).toBeGreaterThan(0)
      expect(t.dh).toBeGreaterThan(0)
    }
  })

  it('tiles overlap so a barcode straddling a seam still fits a whole tile', () => {
    const tiles = tileRois(roi, { rows: 3 })
    // With overlap each tile is taller than a plain 1/3 slice.
    expect(tiles[0].sh).toBeGreaterThan(roi.sh / 3)
    // ...and the seam between tile 0 and tile 1 is covered by both.
    const first = tiles[0]
    const second = tiles[1]
    expect(second.sy).toBeLessThan(first.sy + first.sh)
  })

  it('the last tile still reaches the far edge of the roi', () => {
    const tiles = tileRois(roi, { rows: 3 })
    const last = tiles[tiles.length - 1]
    expect(last.sy + last.sh).toBe(roi.sy + roi.sh)
  })

  it('scales every tile by the roi scale (the canvas the surface expects)', () => {
    const tiles = tileRois(roi, { rows: 2, cols: 2 })
    for (const t of tiles) {
      expect(t.dw).toBe(Math.max(1, Math.round(t.sw * roi.scale)))
      expect(t.dh).toBe(Math.max(1, Math.round(t.sh * roi.scale)))
    }
  })

  it('falls back to the parent when every tile would be below minSize', () => {
    const tiny = { sx: 0, sy: 0, sw: 4, sh: 4, dw: 720, dh: 720, scale: 1 }
    const tiles = tileRois(tiny, { rows: 4, cols: 4 })
    expect(tiles).toHaveLength(1)
    expect(tiles[0].sw).toBe(4)
  })

  it('degrades absurd row/col counts to 1 and rejects a missing roi', () => {
    expect(tileRois(roi, { rows: 0, cols: 0 })).toHaveLength(1)
    expect(tileRois(roi, { rows: -5 })).toHaveLength(1)
    expect(tileRois(null)).toEqual([])
    expect(tileRois({ sx: 0, sy: 0, sw: 0, sh: 0 })).toEqual([])
  })
})
