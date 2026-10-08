// @vitest-environment jsdom
/**
 * BarcodeScanner — camera session lifecycle.
 *
 * The bug this file exists to prevent: the preview used to freeze on a black
 * box while the camera LED stayed on. Two `startScanner` runs raced over one
 * shared `openCamera` promise and the loser called `track.stop()` on the stream
 * the winner had already attached — a live track that nothing was painting.
 *
 * React 18 StrictMode (and the iOS camera-permission prompt) reliably produce
 * that second, overlapping run, so the regression test mounts inside
 * StrictMode and resolves the two open attempts out of order.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render, act, cleanup } from '@testing-library/react'

const mocks = vi.hoisted(() => ({ openCamera: vi.fn(), applyTapFocus: vi.fn() }))

// Override openCamera + spy on applyTapFocus; keep the real ownership,
// teardown, and focus semantics.
vi.mock('./cameraManager', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    openCamera: (...args) => mocks.openCamera(...args),
    applyTapFocus: (...args) => { mocks.applyTapFocus(...args); return actual.applyTapFocus(...args) },
  }
})

const BarcodeScanner = (await import('./BarcodeScanner')).default

/* ── fakes ─────────────────────────────────────────────────────────────────── */

function makeStream(name = 'stream') {
  const track = {
    kind: 'video',
    readyState: 'live',
    stop: vi.fn(function () { track.readyState = 'ended' }),
    getSettings: () => ({ facingMode: 'environment', width: 1280, height: 720 }),
    getCapabilities: () => ({ focusMode: ['continuous'], zoom: { min: 1, max: 2 } }),
    applyConstraints: vi.fn().mockResolvedValue(undefined),
  }
  return { name, getTracks: () => [track], getVideoTracks: () => [track], track }
}

/** A pending promise we can settle by hand, to force the race. */
function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

beforeEach(() => {
  mocks.openCamera.mockReset()
  mocks.applyTapFocus.mockReset()

  // jsdom ships no camera API; the component's secure-context guard needs one.
  Object.defineProperty(window.navigator, 'mediaDevices', {
    configurable: true, writable: true,
    value: { getUserMedia: vi.fn(), enumerateDevices: vi.fn().mockResolvedValue([]) },
  })

  // Keep the engine pool on the cheap native path so no WASM/ZXing bundle loads.
  window.BarcodeDetector = class {
    static getSupportedFormats = () => Promise.resolve(['code_39', 'code_128'])
    detect = () => Promise.resolve([])
  }

  // jsdom implements none of these; the component uses all three.
  Object.defineProperty(window.HTMLMediaElement.prototype, 'play', {
    configurable: true, writable: true, value: vi.fn().mockResolvedValue(undefined),
  })
  Object.defineProperty(window.HTMLMediaElement.prototype, 'pause', {
    configurable: true, writable: true, value: vi.fn(),
  })
  Object.defineProperty(window.HTMLMediaElement.prototype, 'load', {
    configurable: true, writable: true, value: vi.fn(),
  })
  // 2D context is enough for the quality checker + detection surface.
  window.HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    drawImage: vi.fn(), getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(64 * 48 * 4) })),
  }))
  window.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h } getContext() { return { drawImage: vi.fn() } } }
})

afterEach(() => {
  // Vitest runs without `globals: true`, so RTL's auto-cleanup never
  // registers — unmount here or earlier components leak into document.body and
  // make the container-scoped queries ambiguous.
  cleanup()
  delete window.BarcodeDetector
})

/* ── tests ─────────────────────────────────────────────────────────────────── */

describe('BarcodeScanner camera session lifecycle', () => {
  it('attaches the live stream to the video element', async () => {
    const stream = makeStream()
    mocks.openCamera.mockResolvedValue({ stream, track: stream.track, torchSupported: true, deviceId: 'rear', resolutionIndex: 0, adopted: false })

    const { container } = render(<BarcodeScanner onScan={vi.fn()} />)
    await flush()

    const video = container.querySelector('video')
    expect(video.srcObject).toBe(stream)
  })

  it('a stale session never stops a stream a newer session adopted', async () => {
    // One stream, two overlapping open attempts — exactly what StrictMode and
    // the iOS permission prompt produce.
    const shared = makeStream('shared')
    const first = deferred()
    const second = deferred()
    mocks.openCamera.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    const { container, unmount } = render(
      <React.StrictMode><BarcodeScanner onScan={vi.fn()} /></React.StrictMode>,
    )

    // Newer session wins the race and attaches the stream.
    await act(async () => {
      second.resolve({ stream: shared, track: shared.track, torchSupported: false, deviceId: 'rear', resolutionIndex: 0, adopted: false })
      await flush()
    })
    expect(container.querySelector('video').srcObject).toBe(shared)

    // Now the stale session resolves with the same stream. It must walk away.
    await act(async () => {
      first.resolve({ stream: shared, track: shared.track, torchSupported: false, deviceId: 'rear', resolutionIndex: 0, adopted: true })
      await flush()
    })

    expect(shared.track.stop).not.toHaveBeenCalled()
    expect(container.querySelector('video').srcObject).toBe(shared)

    unmount()
  })

  it('stops the stream on a real unmount so the camera LED is not left on', async () => {
    const stream = makeStream()
    mocks.openCamera.mockResolvedValue({ stream, track: stream.track, torchSupported: false, deviceId: 'rear', resolutionIndex: 0, adopted: false })

    const { unmount } = render(<BarcodeScanner onScan={vi.fn()} />)
    await flush()

    unmount()
    await flush()

    expect(stream.track.stop).toHaveBeenCalled()
  })

  it('reclaims a stream that resolves after a real unmount (no orphaned camera)', async () => {
    const stream = makeStream()
    const late = deferred()
    mocks.openCamera.mockReturnValue(late.promise)

    const { unmount } = render(<BarcodeScanner onScan={vi.fn()} />)
    unmount()

    await act(async () => {
      late.resolve({ stream, track: stream.track, torchSupported: false, deviceId: 'rear', resolutionIndex: 0, adopted: false })
      await flush()
    })

    expect(stream.track.stop).toHaveBeenCalled()
  })

  it('surfaces a permission error with a retry affordance instead of a black box', async () => {
    const err = new Error('denied')
    err.name = 'NotAllowedError'
    mocks.openCamera.mockRejectedValue(err)

    const { getByText, getByRole } = render(<BarcodeScanner onScan={vi.fn()} />)
    await flush()

    expect(getByText(/permission denied/i)).toBeTruthy()
    expect(getByRole('button', { name: /retry/i })).toBeTruthy()
  })

  it('never mutates state after unmount (no act() warnings from late resolutions)', async () => {
    const stream = makeStream()
    const late = deferred()
    mocks.openCamera.mockReturnValue(late.promise)

    const { unmount } = render(<BarcodeScanner onScan={vi.fn()} />)
    unmount()

    await act(async () => {
      late.resolve({ stream, track: stream.track, torchSupported: false, deviceId: 'rear', resolutionIndex: 0, adopted: false })
      await flush()
    })

    // The only assertion that matters here: the track was reclaimed, not leaked.
    expect(stream.track.stop).toHaveBeenCalled()
  })

  // L-20: a Retry/restart must not inherit the previous run's 2s duplicate
  // suppressor — otherwise the first post-restart scan of the same badge is
  // silently dropped and the operator taps a dead button.
  it('accepts the same badge immediately after restart (no inherited suppressor)', async () => {
    vi.useFakeTimers()
    try {
      const stream = makeStream()
      mocks.openCamera.mockResolvedValue({ stream, track: stream.track, torchSupported: false, deviceId: 'rear', resolutionIndex: 0, adopted: false })
      window.BarcodeDetector = class {
        static getSupportedFormats = () => Promise.resolve(['code_39'])
        detect = () => Promise.resolve([{ rawValue: 'FB5971GA0001', cornerPoints: [] }])
      }
      const onScan = vi.fn()
      let ref = null
      const { container } = render(<BarcodeScanner ref={(r) => { ref = r }} onScan={onScan} />)
      const video = container.querySelector('video')
      Object.defineProperty(video, 'videoWidth', { value: 1280, configurable: true })
      Object.defineProperty(video, 'videoHeight', { value: 720, configurable: true })

      await act(async () => { await vi.advanceTimersByTimeAsync(800) })
      expect(onScan).toHaveBeenCalledTimes(1)

      await act(async () => { ref.restart(); await vi.advanceTimersByTimeAsync(800) })
      expect(onScan).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

    // L-22: the watchdog error unmounts <video>, so a Retry that reads the ref
  // synchronously dies at "Video element missing" and the error is permanent.
  it('recovers on Retry after the watchdog errors (no dead Video-element-missing)', async () => {    // React 18 schedules commits over MessageChannel (a REAL macrotask), which
    // never runs while only the fake clock advances — so the test yields to
    // the real event loop once to let the loading state commit, exactly as a
    // real browser's event loop would interleave it.
    const realSetTimeout = setTimeout
    const realYield = () => new Promise(r => realSetTimeout(r, 0))
    vi.useFakeTimers()
    try {
      const stream = makeStream()
      mocks.openCamera.mockResolvedValue({ stream, track: stream.track, torchSupported: false, deviceId: 'rear', resolutionIndex: 0, adopted: false })
      const { container, getByRole } = render(<BarcodeScanner onScan={vi.fn()} />)
      const video = container.querySelector('video')
      Object.defineProperty(video, 'videoWidth', { value: 1280, configurable: true })
      Object.defineProperty(video, 'videoHeight', { value: 720, configurable: true })

      // 20s of live preview with zero decodes trips the watchdog.
      await act(async () => { await vi.advanceTimersByTimeAsync(21000) })
      expect(getByRole('button', { name: /retry/i })).toBeTruthy()

      await act(async () => {
        getByRole('button', { name: /retry/i }).click()
        await realYield()
      })
      await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
      expect(mocks.openCamera).toHaveBeenCalledTimes(2)
      expect(container.querySelector('video')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  // L-17: tap-to-focus was a bare <video onClick> — unreachable by keyboard
  // and announced with no purpose. It must be a labelled, focusable control.
  it('exposes tap-to-focus as a keyboard-operable labelled control', async () => {
    const stream = makeStream()
    mocks.openCamera.mockResolvedValue({ stream, track: stream.track, torchSupported: false, deviceId: 'rear', resolutionIndex: 0, adopted: false })

    const { getByRole } = render(<BarcodeScanner onScan={vi.fn()} />)
    await flush()

    const video = getByRole('button', { name: /focus/i })
    expect(video.tagName).toBe('VIDEO')
    expect(video.tabIndex).toBe(0)
  })

  it('keyboard Enter focuses the frame centre (no pointer coordinates needed)', async () => {
    const stream = makeStream()
    mocks.openCamera.mockResolvedValue({ stream, track: stream.track, torchSupported: false, deviceId: 'rear', resolutionIndex: 0, adopted: false })

    const { getByRole } = render(<BarcodeScanner onScan={vi.fn()} />)
    await flush()

    const video = getByRole('button', { name: /focus/i })
    await act(async () => {
      video.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await flush()
    })
    expect(mocks.applyTapFocus).toHaveBeenCalledWith(stream.track, 0.5, 0.5)
  })

  // L-18: the torch label flipped to a bare "ON" (AT: "ON pressed", no
  // subject) and the icon was exposed to AT. The label must keep its subject.
  it('torch button keeps its subject label and hides the icon from AT', async () => {
    const stream = makeStream()
    mocks.openCamera.mockResolvedValue({ stream, track: stream.track, torchSupported: true, deviceId: 'rear', resolutionIndex: 0, adopted: false })

    const { container, getByRole } = render(<BarcodeScanner onScan={vi.fn()} />)
    await flush()

    const btn = getByRole('button', { name: /torch/i })
    expect(btn.textContent).toMatch(/torch/i)
    await act(async () => { btn.click(); await flush() })
    const on = getByRole('button', { name: 'Torch on' })
    expect(on.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('svg[aria-hidden="true"]')).toBeTruthy()
  })

  // L-16: the guide box (full-frame inset) did not match the decode ROI
  // (centred 92%x62% band), so operators aimed at a box the decoder never
  // read. The guide must mirror the band geometry.
  it('guide box mirrors the decode ROI band (92% x 62%, centred)', async () => {
    const stream = makeStream()
    mocks.openCamera.mockResolvedValue({ stream, track: stream.track, torchSupported: false, deviceId: 'rear', resolutionIndex: 0, adopted: false })

    const { getByTestId } = render(<BarcodeScanner onScan={vi.fn()} />)
    await flush()

    const guide = getByTestId('roi-guide')
    expect(guide.style.left).toBe('4%')
    expect(guide.style.right).toBe('4%')
    expect(guide.style.top).toBe('19%')
    expect(guide.style.bottom).toBe('19%')
  })

  // L-46: the pages' "camera paused" claim must actually halt the decode
  // loop — not just drop scans with a toast while the loop keeps burning.
  it('pause() halts decoding and resume() restarts it without a second chain', async () => {
    // React 18 commits over MessageChannel (real macrotask); yield once so
    // the assertions below observe committed state, as a real browser would.
    const realSetTimeout = setTimeout
    const realYield = () => new Promise(r => realSetTimeout(r, 0))
    vi.useFakeTimers()
    try {
      const stream = makeStream()
      mocks.openCamera.mockResolvedValue({ stream, track: stream.track, torchSupported: false, deviceId: 'rear', resolutionIndex: 0, adopted: false })
      let decodeCalls = 0
      window.BarcodeDetector = class {
        static getSupportedFormats = () => Promise.resolve(['code_39'])
        detect = () => { decodeCalls++; return Promise.resolve([]) }
      }
      let ref = null
      const { container } = render(<BarcodeScanner ref={(r) => { ref = r }} onScan={vi.fn()} />)
      const video = container.querySelector('video')
      Object.defineProperty(video, 'videoWidth', { value: 1280, configurable: true })
      Object.defineProperty(video, 'videoHeight', { value: 720, configurable: true })

      await act(async () => { await vi.advanceTimersByTimeAsync(800); await realYield() })
      expect(decodeCalls).toBeGreaterThan(0)

      await act(async () => { ref.pause(); await realYield() })
      const frozen = decodeCalls
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); await realYield() })
      expect(decodeCalls).toBe(frozen)

      await act(async () => { ref.resume(); await vi.advanceTimersByTimeAsync(800); await realYield() })
      expect(decodeCalls).toBeGreaterThan(frozen)
    } finally {
      vi.useRealTimers()
    }
  })

  // V8(a): a rejected video.play() used to leave the track live with a black
  // preview and the camera LED on — the error path never released the stream.
  // The start path must stop the stream (LED releases) before erroring, so a
  // Retry starts from a clean slate.
  it('stops the stream when video.play() rejects (no orphaned camera LED)', async () => {
    const stream = makeStream()
    mocks.openCamera.mockResolvedValue({ stream, track: stream.track, torchSupported: false, deviceId: 'rear', resolutionIndex: 0, adopted: false })
    window.HTMLMediaElement.prototype.play.mockRejectedValueOnce(new Error('play failed'))

    const { getByText, getByRole } = render(<BarcodeScanner onScan={vi.fn()} />)
    await flush()

    expect(stream.track.stop).toHaveBeenCalled()
    expect(getByText(/could not start video playback/i)).toBeTruthy()
    expect(getByRole('button', { name: /retry/i })).toBeTruthy()
  })

  // V8(b): the decision pause (confirm/forgot popup open) must survive a
  // restart — startScanner and the visibility resume must never clear it, or
  // the restart silently resumes scanning behind the operator's pending
  // question. Re-asserted after the restart; resume() releases it.
  it('a restart while decision-paused stays paused until resume()', async () => {
    const realSetTimeout = setTimeout
    const realYield = () => new Promise(r => realSetTimeout(r, 0))
    vi.useFakeTimers()
    try {
      const stream = makeStream()
      mocks.openCamera.mockResolvedValue({ stream, track: stream.track, torchSupported: false, deviceId: 'rear', resolutionIndex: 0, adopted: false })
      let decodeCalls = 0
      window.BarcodeDetector = class {
        static getSupportedFormats = () => Promise.resolve(['code_39'])
        detect = () => { decodeCalls++; return Promise.resolve([]) }
      }
      let ref = null
      const { container } = render(<BarcodeScanner ref={(r) => { ref = r }} onScan={vi.fn()} />)
      const video = container.querySelector('video')
      Object.defineProperty(video, 'videoWidth', { value: 1280, configurable: true })
      Object.defineProperty(video, 'videoHeight', { value: 720, configurable: true })

      await act(async () => { await vi.advanceTimersByTimeAsync(800); await realYield() })
      expect(decodeCalls).toBeGreaterThan(0)

      // Decision popup opens → pause; then a restart (Retry) happens behind it.
      await act(async () => { ref.pause(); await realYield() })
      const frozen = decodeCalls
      await act(async () => { ref.restart(); await vi.advanceTimersByTimeAsync(800); await realYield() })
      expect(decodeCalls).toBe(frozen)

      // Answering the popup resumes the single chain — no second chain, so the
      // count grows but a further resume() without pause adds nothing extra.
      await act(async () => { ref.resume(); await vi.advanceTimersByTimeAsync(800); await realYield() })
      expect(decodeCalls).toBeGreaterThan(frozen)
    } finally {
      vi.useRealTimers()
    }
  })
})

// T11(a): the 2s duplicate suppressor records only on handler acceptance.
// A declined scan (handler returned exactly `false` — busy/decision-pending
// per the useScanHandler contract) never ran, so the immediate retry must be
// accepted, not swallowed as a duplicate.
describe('BarcodeScanner camera suppressor acceptance (T11)', () => {
  async function renderDetectingBadge(onScan) {
    const stream = makeStream()
    mocks.openCamera.mockResolvedValue({ stream, track: stream.track, torchSupported: false, deviceId: 'rear', resolutionIndex: 0, adopted: false })
    window.BarcodeDetector = class {
      static getSupportedFormats = () => Promise.resolve(['code_39'])
      detect = () => Promise.resolve([{ rawValue: 'FB5971GA0001', cornerPoints: [] }])
    }
    const view = render(<BarcodeScanner onScan={onScan} />)
    const video = view.container.querySelector('video')
    Object.defineProperty(video, 'videoWidth', { value: 1280, configurable: true })
    Object.defineProperty(video, 'videoHeight', { value: 720, configurable: true })
    return view
  }

  it('a declined scan does not arm the suppressor — the retry is accepted', async () => {
    vi.useFakeTimers()
    try {
      const onScan = vi.fn(() => false)
      renderDetectingBadge(onScan)
      await act(async () => { await vi.advanceTimersByTimeAsync(800) })
      // Every confirmed frame re-offers the badge: nothing was ever recorded.
      expect(onScan.mock.calls.length).toBeGreaterThan(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('an accepted scan still suppresses immediate duplicates', async () => {
    vi.useFakeTimers()
    try {
      const onScan = vi.fn() // undefined return = accepted
      renderDetectingBadge(onScan)
      await act(async () => { await vi.advanceTimersByTimeAsync(800) })
      expect(onScan).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

// T4: the camera decode gate runs through sanitizeScannedBadge. Code-39
// start/stop guards, lower case and O↔0-style confusion misreads used to die
// silently at the BADGE_REGEX gate (raw `*FB5971GA0001*` never matched, so a
// perfectly good badge scanned nothing). Now: guards/confusions are recovered
// and the CLEANED value flows downstream; unreadable values surface a dedicated
// transient reject hint instead of vanishing.
describe('BarcodeScanner decode gate routes through the sanitizer (T4)', () => {
  function renderDecoding(rawValue, { rejectCalls = Infinity, onScan = vi.fn() } = {}) {
    const stream = makeStream()
    mocks.openCamera.mockResolvedValue({ stream, track: stream.track, torchSupported: false, deviceId: 'rear', resolutionIndex: 0, adopted: false })
    let calls = 0
    window.BarcodeDetector = class {
      static getSupportedFormats = () => Promise.resolve(['code_39'])
      // Reject the first `rejectCalls` detects, then go quiet — so the hint's
      // hide-timeout has nothing to re-show it. NB: the component's
      // device-profiling warmup (ensureEngines) consumes the first 3 detects
      // before the decode loop starts, so the loop only sees rejects from
      // call #4 — rejectCalls must exceed 3 or the loop never sees a barcode.
      detect = () => Promise.resolve(++calls <= rejectCalls ? [{ rawValue, cornerPoints: [] }] : [])
    }
    const view = render(<BarcodeScanner onScan={onScan} />)
    const video = view.container.querySelector('video')
    Object.defineProperty(video, 'videoWidth', { value: 1280, configurable: true })
    Object.defineProperty(video, 'videoHeight', { value: 720, configurable: true })
    return view
  }

  it('strips Code-39 guards — onScan fires with the cleaned badge', async () => {
    vi.useFakeTimers()
    try {
      const onScan = vi.fn()
      const view = renderDecoding('*FB5971GA0001*', { onScan })
      await act(async () => { await vi.advanceTimersByTimeAsync(800) })
      expect(onScan).toHaveBeenCalledWith('FB5971GA0001')
      expect(onScan).toHaveBeenCalledTimes(1)
      // The debug pill keeps showing the RAW read (guards included).
      expect(view.getByText('*FB5971GA0001*')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('repairs a 1-char confusion misread — onScan fires with the repaired badge', async () => {
    vi.useFakeTimers()
    try {
      const onScan = vi.fn()
      // Letter O read for zero at both digit slots: repairBadgeConfusions
      // fixes exactly those two positions and the result matches BADGE_REGEX.
      renderDecoding('FB5971GAOO01', { onScan })
      await act(async () => { await vi.advanceTimersByTimeAsync(800) })
      expect(onScan).toHaveBeenCalledWith('FB5971GA0001')
      expect(onScan).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a 1-char misread shows the reject hint once, then hides — no throw, no onScan', async () => {
    vi.useFakeTimers()
    try {
      const onScan = vi.fn()
      const view = renderDecoding('F', { rejectCalls: 6, onScan })
      await act(async () => { await vi.advanceTimersByTimeAsync(800) })

      // Rejected: never reaches onScan, and the hint is up.
      expect(onScan).not.toHaveBeenCalled()
      const hint = view.getByText(/invalid badge/i)
      expect(hint).toBeTruthy()

      // Throttle: within the 2s window the same hint element persists — no
      // re-set, no blink, no throw, no matter how many frames reject.
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      expect(view.getByText(/invalid badge/i)).toBe(hint)

      // Timeout state: once rejects stop, the hide-timeout takes the pill down.
      await act(async () => { await vi.advanceTimersByTimeAsync(2200) })
      expect(view.queryByText(/invalid badge/i)).toBeNull()
      expect(onScan).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
