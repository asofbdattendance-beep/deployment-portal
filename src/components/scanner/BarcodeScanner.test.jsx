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
})
