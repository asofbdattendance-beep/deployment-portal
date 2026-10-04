// @vitest-environment jsdom
/**
 * cameraManager — device-facing camera acquisition, ownership and capabilities.
 *
 * These tests stub `navigator.mediaDevices` so the whole module can be driven
 * without hardware. They pin the invariants that keep the scanner's preview
 * alive: a single writer owns the stream, a live stream is adopted rather than
 * re-opened, and capability probes degrade instead of throwing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  openCamera,
  stopStream,
  getActiveStream,
  isStreamLive,
  pickRearDeviceId,
  probeTorch,
  cancelPendingOpen,
  applyFocusConstraints,
  applyTapFocus,
  toggleTorch,
  focusHunt,
  setZoom,
  getZoom,
  zoomRampForMisses,
  shouldSuggestTorch,
  beginFocusHunt,
  platform,
} from './cameraManager'

/* ── helpers ────────────────────────────────────────────────────────────────── */

function makeTrack(overrides = {}) {
  const track = {
    kind: 'video',
    readyState: 'live',
    settings: {},
    caps: {},
    applied: [],
    stop: vi.fn(function () { track.readyState = 'ended' }),
    getSettings: () => track.settings,
    getCapabilities: () => track.caps,
    applyConstraints: vi.fn(async (c) => { track.applied.push(c); return undefined }),
    ...overrides,
  }
  return track
}

function makeStream(track = makeTrack()) {
  return {
    getTracks: () => [track],
    getVideoTracks: () => [track],
    track,
  }
}

function gumError(name, message = name) {
  const e = new Error(message)
  e.name = name
  return e
}

/**
 * A Safari-like track: no `torch` in capabilities, but applyConstraints honours
 * it and getSettings reports the current value. Models the real device.
 */
function makeTorchTrack() {
  const track = makeTrack({ caps: {} })
  track.applyConstraints = vi.fn(async function (c) {
    const adv = c?.advanced?.[0]
    if (adv && 'torch' in adv) track.settings.torch = !!adv.torch
  })
  return track
}

const gum = vi.fn()

beforeEach(() => {
  gum.mockReset()
  navigator.mediaDevices = {
    getUserMedia: gum,
    enumerateDevices: vi.fn().mockResolvedValue([]),
  }
  stopStream(getActiveStream()) // reset module-level ownership between tests
})

afterEach(() => {
  stopStream(getActiveStream())
})

/* ── openCamera: ownership ──────────────────────────────────────────────────── */

describe('openCamera ownership', () => {
  it('opens a stream and reports it as the active one', async () => {
    const stream = makeStream()
    gum.mockResolvedValue(stream)

    const res = await openCamera()

    expect(res.stream).toBe(stream)
    expect(res.adopted).toBe(false)
    expect(getActiveStream()).toBe(stream)
  })

  it('adopts an already-live stream instead of opening a second camera', async () => {
    const stream = makeStream()
    gum.mockResolvedValue(stream)

    await openCamera()
    const second = await openCamera()

    expect(gum).toHaveBeenCalledTimes(1)   // the whole point: no second getUserMedia
    expect(second.stream).toBe(stream)
    expect(second.adopted).toBe(true)
  })

  it('replaces a dead active stream instead of adopting it', async () => {
    const dead = makeStream()
    dead.track.readyState = 'ended'
    gum.mockResolvedValueOnce(dead).mockResolvedValueOnce(makeStream())

    await openCamera()          // adopts / registers the ended stream
    const res = await openCamera()

    expect(gum).toHaveBeenCalledTimes(2)
    expect(res.adopted).toBe(false)
    expect(isStreamLive(res.stream)).toBe(true)
  })
})

/* ── openCamera: constraints + fallbacks ────────────────────────────────────── */

describe('openCamera acquisition', () => {
  it('asks for the rear camera by exact deviceId when one is enumerated', async () => {
    const stream = makeStream()
    gum.mockResolvedValue(stream)
    navigator.mediaDevices.enumerateDevices = vi.fn().mockResolvedValue([
      { kind: 'videoinput', deviceId: 'front', label: 'User Facing Camera' },
      { kind: 'videoinput', deviceId: 'rear', label: 'Back Camera' },
    ])

    const res = await openCamera()

    const video = gum.mock.calls[0][0].video
    expect(video.deviceId).toEqual({ exact: 'rear' })
    expect(res.deviceId).toBe('rear')
  })

  it('falls back to facingMode when no rear device can be enumerated', async () => {
    gum.mockResolvedValue(makeStream())
    navigator.mediaDevices.enumerateDevices = vi.fn().mockResolvedValue([
      { kind: 'videoinput', deviceId: 'front', label: 'User Facing Camera' },
    ])

    await openCamera()

    expect(gum.mock.calls[0][0].video.facingMode).toEqual({ ideal: 'environment' })
  })

  it('does not stop a stream it never owned (no mid-open teardown)', async () => {
    gum.mockResolvedValue(makeStream())
    await openCamera()
    expect(gum.mock.results.length).toBe(1)
  })

  it('surfaces NotAllowedError immediately without walking the resolution chain', async () => {
    gum.mockRejectedValue(gumError('NotAllowedError'))

    await expect(openCamera()).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(gum).toHaveBeenCalledTimes(1)
  })

  it('walks the resolution chain on OverconstrainedError, then succeeds', async () => {
    gum
      .mockRejectedValueOnce(gumError('OverconstrainedError'))
      .mockRejectedValueOnce(gumError('OverconstrainedError'))
      .mockResolvedValueOnce(makeStream())

    const res = await openCamera()

    expect(gum).toHaveBeenCalledTimes(3)
    expect(res.resolutionIndex).toBe(2)
  })

  it('rethrows the original error when every resolution fails', async () => {
    gum.mockRejectedValue(gumError('NotReadableError', 'camera busy'))

    await expect(openCamera()).rejects.toMatchObject({ name: 'NotReadableError' })
  })
})

describe('cancelPendingOpen', () => {
  it('is a no-op when nothing is opening', () => {
    expect(cancelPendingOpen()).toBe(false)
  })

  it('stops a stream from an abandoned open instead of adopting it', async () => {
    const stream = makeStream()
    let resolveGum
    gum.mockReturnValueOnce(new Promise(r => { resolveGum = r }))

    const opening = openCamera()
    expect(cancelPendingOpen()).toBe(true)
    resolveGum(stream)

    await expect(opening).rejects.toMatchObject({ name: 'AbortError' })
    expect(stream.track.stop).toHaveBeenCalled()
    expect(getActiveStream()).toBeNull()
  })

  it('lets a later open acquire the camera normally', async () => {
    const first = makeStream()
    const second = makeStream()
    let resolveFirst
    gum.mockReturnValueOnce(new Promise(r => { resolveFirst = r })).mockResolvedValueOnce(second)

    const abandoned = openCamera()
    cancelPendingOpen()
    resolveFirst(first)
    await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' })

    const res = await openCamera()
    expect(res.stream).toBe(second)
    expect(getActiveStream()).toBe(second)
  })
})

/* ── stopStream ─────────────────────────────────────────────────────────────── */

describe('stopStream', () => {
  it('stops every track and clears ownership', async () => {
    const t1 = makeTrack()
    const t2 = makeTrack()
    const stream = { getTracks: () => [t1, t2], getVideoTracks: () => [t1] }
    gum.mockResolvedValue(stream)
    await openCamera()

    stopStream(stream)

    expect(t1.stop).toHaveBeenCalled()
    expect(t2.stop).toHaveBeenCalled()
    expect(getActiveStream()).toBeNull()
  })

  it('is a no-op for a null stream', () => {
    expect(() => stopStream(null)).not.toThrow()
  })

  it('leaves an unrelated active stream owned when stopping a foreign one', async () => {
    const mine = makeStream()
    gum.mockResolvedValue(mine)
    await openCamera()

    stopStream(makeStream()) // some other stream

    expect(getActiveStream()).toBe(mine)
  })
})

/* ── isStreamLive ───────────────────────────────────────────────────────────── */

describe('isStreamLive', () => {
  it('is false for null, track-less and ended streams', () => {
    expect(isStreamLive(null)).toBe(false)
    expect(isStreamLive({ getVideoTracks: () => [] })).toBe(false)
    expect(isStreamLive(makeStream(makeTrack({ readyState: 'ended' })))).toBe(false)
  })

  it('is true while a video track is live', () => {
    expect(isStreamLive(makeStream())).toBe(true)
  })
})

/* ── pickRearDeviceId ───────────────────────────────────────────────────────── */

describe('pickRearDeviceId', () => {
  it('prefers a device whose label says back/rear/environment', async () => {
    navigator.mediaDevices.enumerateDevices = vi.fn().mockResolvedValue([
      { kind: 'videoinput', deviceId: 'a', label: 'User Facing Camera' },
      { kind: 'videoinput', deviceId: 'b', label: 'Back Triple Camera' },
    ])
    await expect(pickRearDeviceId()).resolves.toBe('b')
  })

  it('ignores audio inputs and non-camera labels', async () => {
    navigator.mediaDevices.enumerateDevices = vi.fn().mockResolvedValue([
      { kind: 'audioinput', deviceId: 'mic', label: 'Back Microphone' },
      { kind: 'videoinput', deviceId: 'c', label: 'Camera' },
    ])
    await expect(pickRearDeviceId()).resolves.toBeNull()
  })

  it('returns null when enumerateDevices is unavailable or throws', async () => {
    await expect(pickRearDeviceId()).resolves.toBeNull() // stubbed to []
    navigator.mediaDevices.enumerateDevices = vi.fn().mockRejectedValue(new Error('nope'))
    await expect(pickRearDeviceId()).resolves.toBeNull()
  })
})

/* ── probeTorch ─────────────────────────────────────────────────────────────── */

describe('probeTorch', () => {
  it('trusts an advertised torch capability', async () => {
    const track = makeTrack({ caps: { torch: true } })
    await expect(probeTorch(track)).resolves.toBe(true)
    expect(track.applyConstraints).not.toHaveBeenCalled()
  })

  it('probes by applying the constraint when Safari omits the capability', async () => {
    const track = makeTorchTrack()
    await expect(probeTorch(track)).resolves.toBe(true)
  })

  it('leaves the torch off after a successful probe', async () => {
    const track = makeTorchTrack()
    await probeTorch(track)
    expect(track.settings.torch).toBe(false)
  })

  it('returns false when applyConstraints rejects', async () => {
    const track = makeTrack({ caps: {}, applyConstraints: vi.fn().mockRejectedValue(new Error('unsupported')) })
    await expect(probeTorch(track)).resolves.toBe(false)
  })

  it('returns false for a missing track', async () => {
    await expect(probeTorch(null)).resolves.toBe(false)
  })
})

/* ── focus ──────────────────────────────────────────────────────────────────── */

describe('applyFocusConstraints', () => {
  it('requests continuous focus and reports it applied', async () => {
    const track = makeTrack({ caps: { focusMode: ['continuous', 'manual'] } })
    const res = await applyFocusConstraints(track)
    expect(res.focusApplied).toBe(true)
    expect(track.applied[0].advanced).toContainEqual({ focusMode: 'continuous' })
  })

  it('leaves focus alone when the device advertises nothing', async () => {
    const track = makeTrack({ caps: {} })
    const res = await applyFocusConstraints(track)
    expect(res.focusApplied).toBe(false)
    expect(track.applyConstraints).not.toHaveBeenCalled()
  })

  it('applies digital zoom on any device that exposes it (not just Android)', async () => {
    const track = makeTrack({ caps: { zoom: { min: 1, max: 4 } } })
    const res = await applyFocusConstraints(track, { applyZoom: true })
    expect(res.zoomApplied).toBe(true)
    // Zoom goes out in its OWN applyConstraints call so a firmware that
    // rejects it cannot void the autofocus request alongside it.
    const zoomCall = track.applied.find((c) => JSON.stringify(c.advanced).includes('"zoom"'))
    expect(zoomCall).toBeTruthy()
    expect(zoomCall.advanced).toContainEqual({ zoom: 1.25 })
  })

  it('a rejected zoom still leaves the focus request applied', async () => {
    const track = makeTrack({
      caps: { focusMode: ['continuous'], zoom: { min: 1, max: 4 } },
      applyConstraints: vi.fn()
        .mockResolvedValueOnce(undefined) // focus set: ok
        .mockRejectedValueOnce(new Error('zoom unsupported')), // zoom set: rejected
    })
    const res = await applyFocusConstraints(track, { applyZoom: true })
    expect(res.focusApplied).toBe(true)
    expect(res.zoomApplied).toBe(false)
  })

  it('honours applyZoom:false', async () => {
    const track = makeTrack({ caps: { zoom: { min: 1, max: 4 } } })
    const res = await applyFocusConstraints(track, { applyZoom: false })
    expect(res.zoomApplied).toBe(false)
  })

  it('uses setPointOfInterest when the device supports it', async () => {
    const track = makeTrack({ caps: { pointsOfInterest: [{ x: 0, y: 0, radius: 0 }] }, setPointOfInterest: vi.fn().mockResolvedValue(undefined) })
    const res = await applyFocusConstraints(track, { point: { x: 0.4, y: 0.6 } })
    expect(track.setPointOfInterest).toHaveBeenCalledWith(0.4, 0.6)
    expect(res.poiApplied).toBe(true)
  })

  it('never throws when applyConstraints is unsupported', async () => {
    const track = makeTrack({ caps: { focusMode: ['continuous'] }, applyConstraints: vi.fn().mockRejectedValue(new Error('nope')) })
    await expect(applyFocusConstraints(track)).resolves.toBeDefined()
  })
})

describe('applyTapFocus', () => {
  it('prefers points of interest and needs no revert timer', async () => {
    const track = makeTrack({ setPointOfInterest: vi.fn().mockResolvedValue(undefined) })
    const res = await applyTapFocus(track, 0.5, 0.5)
    expect(res.applied).toBe(true)
    expect(res.mode).toBe('poi')
    expect(track.setPointOfInterest).toHaveBeenCalledWith(0.5, 0.5)
  })

  it('falls back to focusDistance on legacy devices and reverts to continuous after 3s', async () => {
    vi.useFakeTimers()
    try {
      // A device that advertises BOTH manual and continuous: manual is used for
      // the tap, then the revert timer restores continuous AF.
      const track = makeTrack({ caps: { focusMode: ['manual', 'continuous'], focusDistance: { min: 0, max: 10 } } })
      const res = await applyTapFocus(track, 0.5, 0.5)
      expect(res.applied).toBe(true)
      expect(res.mode).toBe('distance')
      expect(track.applied[0].advanced[0]).toMatchObject({ focusMode: 'manual' })
      expect(track.applied.length).toBe(1)

      await vi.advanceTimersByTimeAsync(3100)
      expect(track.applied.length).toBe(2)
      expect(track.applied[1].advanced).toContainEqual({ focusMode: 'continuous' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the revert timer when cleanup is called', async () => {
    vi.useFakeTimers()
    try {
      const track = makeTrack({ caps: { focusMode: ['manual', 'continuous'], focusDistance: { min: 0, max: 10 } } })
      const res = await applyTapFocus(track, 0.5, 0.5)
      res.cleanup()
      await vi.advanceTimersByTimeAsync(3100)
      expect(track.applied.length).toBe(1) // no revert after cleanup
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports not-applied on a device with no focus control at all', async () => {
    const res = await applyTapFocus(makeTrack({ caps: {} }), 0.5, 0.5)
    expect(res.applied).toBe(false)
  })
})

/* ── torch toggle ───────────────────────────────────────────────────────────── */

describe('toggleTorch', () => {
  it('returns true when the constraint is accepted', async () => {
    const track = makeTrack()
    await expect(toggleTorch(track, true)).resolves.toBe(true)
    expect(track.applied[0]).toEqual({ advanced: [{ torch: true }] })
  })

  it('returns false when unsupported so the UI can revert the pill', async () => {
    const track = makeTrack({ applyConstraints: vi.fn().mockRejectedValue(new Error('unsupported')) })
    await expect(toggleTorch(track, true)).resolves.toBe(false)
  })
})

/* ── focusHunt ─────────────────────────────────────────────────────────────── */

describe('focusHunt', () => {
  it('re-requests continuous AF on attempt 1 when advertised', async () => {
    const track = makeTrack({ caps: { focusMode: ['continuous', 'manual'], focusDistance: { min: 0, max: 10 } } })
    const res = await focusHunt(track, 1)
    expect(res.mode).toBe('continuous')
    expect(res.ok).toBe(true)
    expect(track.applied).toHaveLength(1)
    expect(track.applied[0].advanced).toEqual([{ focusMode: 'continuous' }])
  })

  it('requests continuous on Android even when focusMode is empty', async () => {
    const original = platform.isAndroid
    platform.isAndroid = true
    try {
      const track = makeTrack({ caps: {} })
      const res = await focusHunt(track, 1)
      expect(res.mode).toBe('continuous')
      expect(res.ok).toBe(true)
      expect(track.applied[0].advanced).toContainEqual({ focusMode: 'continuous' })
    } finally {
      platform.isAndroid = original
    }
  })

  it('escalates to manual-near on attempt 2 and schedules a return to continuous', async () => {
    vi.useFakeTimers()
    try {
      const track = makeTrack({ caps: { focusMode: ['continuous', 'manual'], focusDistance: { min: 0, max: 10 } } })
      const res = await focusHunt(track, 2)
      expect(res.mode).toBe('manual')
      expect(res.ok).toBe(true)
      expect(track.applied).toHaveLength(1)
      // Biased NEAR: 25% of the way from min toward max — small badges are close.
      expect(track.applied[0].advanced).toEqual([{ focusMode: 'manual', focusDistance: 2.5 }])

      // The return to continuous AF is scheduled, not applied immediately.
      await vi.advanceTimersByTimeAsync(1300) // hold is 1200ms — +margin
      expect(track.applied).toHaveLength(2)
      expect(track.applied[1].advanced).toEqual([{ focusMode: 'continuous' }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('no-ops cleanly when neither focusMode nor focusDistance exists (iOS-like track)', async () => {
    const track = makeTrack({ caps: {} })
    const res = await focusHunt(track, 1)
    expect(res.mode).toBe('none')
    expect(res.ok).toBe(false)
    expect(res.nextMs).toBeGreaterThanOrEqual(800)
    expect(track.applyConstraints).not.toHaveBeenCalled()
    // A later attempt on the same track is equally helpless — still no throw.
    const res2 = await focusHunt(track, 2)
    expect(res2.mode).toBe('none')
    expect(res2.ok).toBe(false)
    expect(track.applyConstraints).not.toHaveBeenCalled()
  })

  it('no-ops when only continuous is advertised (no manual/distance to nudge with)', async () => {
    const track = makeTrack({ caps: { focusMode: ['continuous'] } })
    const res = await focusHunt(track, 2)
    expect(res.mode).toBe('none')
    expect(res.ok).toBe(false)
    expect(track.applyConstraints).not.toHaveBeenCalled()
  })

  it('never throws when getCapabilities throws', async () => {
    const track = makeTrack({ getCapabilities: vi.fn(() => { throw new Error('boom') }) })
    const res = await focusHunt(track, 1)
    expect(res.mode).toBe('none')
    expect(res.ok).toBe(false)
    expect(typeof res.nextMs).toBe('number')
  })

  it('never throws when applyConstraints rejects', async () => {
    const track = makeTrack({
      caps: { focusMode: ['continuous', 'manual'], focusDistance: { min: 0, max: 10 } },
      applyConstraints: vi.fn().mockRejectedValue(new Error('nope')),
    })
    const res = await focusHunt(track, 1)
    expect(res.mode).toBe('none')
    expect(res.ok).toBe(false)
  })

  it('grows nextMs with attempt and clamps at the cap', async () => {
    vi.useFakeTimers()
    try {
      const track = makeTrack({ caps: { focusMode: ['continuous', 'manual'], focusDistance: { min: 0, max: 10 } } })
      const delays = []
      for (const a of [1, 2, 3, 4, 5, 100]) {
        const res = await focusHunt(track, a)
        delays.push(res.nextMs)
      }
      expect(delays).toEqual([1000, 2000, 3000, 4000, 4000, 4000])
    } finally {
      vi.useRealTimers()
    }
  })
})

/* ── zoom ──────────────────────────────────────────────────────────────────── */

describe('setZoom', () => {
  /** A track that actually honours zoom, like a real device would. */
  function makeZoomTrack() {
    const track = makeTrack({ caps: { zoom: { min: 1, max: 4 } } })
    track.applyConstraints = vi.fn(async (c) => {
      track.applied.push(c)
      const adv = c?.advanced?.[0]
      if (adv && 'zoom' in adv) track.settings.zoom = adv.zoom
    })
    return track
  }

  it('clamps to the advertised max and reads the set value back', async () => {
    const track = makeZoomTrack()
    const res = await setZoom(track, 10)
    expect(res).toEqual({ ok: true, zoom: 4 })
    expect(track.applied[0].advanced).toEqual([{ zoom: 4 }])
  })

  it('clamps to the advertised min', async () => {
    const track = makeZoomTrack()
    const res = await setZoom(track, 0.5)
    expect(res).toEqual({ ok: true, zoom: 1 })
  })

  it('applies zoom in its own call carrying only zoom', async () => {
    const track = makeZoomTrack()
    await setZoom(track, 2)
    expect(track.applied).toHaveLength(1)
    expect(track.applied[0]).toEqual({ advanced: [{ zoom: 2 }] })
  })

  it('returns the clamped value when the device cannot read zoom back', async () => {
    const track = makeTrack({ caps: { zoom: { min: 1, max: 4 } } }) // default mock: settings stay empty
    const res = await setZoom(track, 3)
    expect(res).toEqual({ ok: true, zoom: 3 })
  })

  it('reports ok:false with the current zoom when applyConstraints rejects', async () => {
    const track = makeZoomTrack()
    await setZoom(track, 2) // current is now 2
    track.applyConstraints.mockRejectedValue(new Error('zoom unsupported'))
    const res = await setZoom(track, 3)
    expect(res).toEqual({ ok: false, zoom: 2 })
  })

  it('reports ok:false when the device advertises no zoom', async () => {
    const track = makeTrack({ caps: {} })
    const res = await setZoom(track, 2)
    expect(res).toEqual({ ok: false, zoom: null })
    expect(track.applyConstraints).not.toHaveBeenCalled()
  })

  it('reports ok:false for a non-finite level', async () => {
    const track = makeZoomTrack()
    const res = await setZoom(track, NaN)
    expect(res.ok).toBe(false)
    expect(track.applyConstraints).not.toHaveBeenCalled()
  })
})

describe('getZoom', () => {
  it('returns the current zoom setting', () => {
    expect(getZoom(makeTrack({ settings: { zoom: 2.5 } }))).toBe(2.5)
  })

  it('returns null when zoom is unsupported or absent', () => {
    expect(getZoom(makeTrack({ settings: {} }))).toBeNull()
    expect(getZoom(makeTrack())).toBeNull()
    expect(getZoom(null)).toBeNull()
  })

  it('never returns NaN', () => {
    expect(getZoom(makeTrack({ settings: { zoom: NaN } }))).toBeNull()
  })
})

/* ── zoomRampForMisses ─────────────────────────────────────────────────────── */

describe('zoomRampForMisses', () => {
  const caps = { zoom: { min: 1, max: 4 } }

  it('holds 1.0 through the first couple of misses', () => {
    expect(zoomRampForMisses(0, caps)).toBe(1.0)
    expect(zoomRampForMisses(1, caps)).toBe(1.0)
    expect(zoomRampForMisses(2, caps)).toBe(1.0)
  })

  it('ramps gently: +0.25 per couple of misses', () => {
    expect(zoomRampForMisses(3, caps)).toBe(1.25)
    expect(zoomRampForMisses(4, caps)).toBe(1.25)
    expect(zoomRampForMisses(5, caps)).toBe(1.5)
    expect(zoomRampForMisses(6, caps)).toBe(1.5)
    expect(zoomRampForMisses(7, caps)).toBe(1.75)
  })

  it('stops at the 1.75 cap no matter how long the miss streak', () => {
    expect(zoomRampForMisses(50, caps)).toBe(1.75)
  })

  it('never exceeds the advertised zoom max', () => {
    expect(zoomRampForMisses(50, { zoom: { min: 1, max: 1.4 } })).toBe(1.4)
    expect(zoomRampForMisses(0, { zoom: { min: 1, max: 1.4 } })).toBe(1.0)
  })

  it('is monotonic non-decreasing in the miss count', () => {
    let prev = 0
    for (let m = 0; m <= 30; m++) {
      const z = zoomRampForMisses(m, caps)
      expect(z).toBeGreaterThanOrEqual(prev)
      prev = z
    }
  })

  it('returns 1.0 for null/undefined caps or a missing zoom capability', () => {
    expect(zoomRampForMisses(10, null)).toBe(1.0)
    expect(zoomRampForMisses(10, undefined)).toBe(1.0)
    expect(zoomRampForMisses(10, {})).toBe(1.0)
  })

  it('treats a non-finite miss count as zero', () => {
    expect(zoomRampForMisses(NaN, caps)).toBe(1.0)
  })
})

/* ── shouldSuggestTorch ────────────────────────────────────────────────────── */

describe('shouldSuggestTorch', () => {
  it('is true only when the frame is dark AND the device has a torch', () => {
    expect(shouldSuggestTorch(20, { torch: true })).toBe(true)
    expect(shouldSuggestTorch(39.9, { torch: true })).toBe(true)
  })

  it('is false when the frame is not genuinely dark', () => {
    expect(shouldSuggestTorch(40, { torch: true })).toBe(false) // boundary: not < 40
    expect(shouldSuggestTorch(120, { torch: true })).toBe(false)
  })

  it('is false when the device has no torch, however dark', () => {
    expect(shouldSuggestTorch(10, {})).toBe(false)
    expect(shouldSuggestTorch(10, { torch: false })).toBe(false)
    expect(shouldSuggestTorch(10, null)).toBe(false)
  })

  it('is false for missing or NaN luma', () => {
    expect(shouldSuggestTorch(NaN, { torch: true })).toBe(false)
    expect(shouldSuggestTorch(null, { torch: true })).toBe(false)
    expect(shouldSuggestTorch(undefined, { torch: true })).toBe(false)
  })
})

/* ── beginFocusHunt ────────────────────────────────────────────────────────── */

describe('beginFocusHunt', () => {
  it('drives focusHunt on an interval, backing off via nextMs', async () => {
    vi.useFakeTimers()
    try {
      const track = makeTrack({ caps: { focusMode: ['continuous', 'manual'], focusDistance: { min: 0, max: 10 } } })
      const stop = beginFocusHunt(track)
      expect(vi.getTimerCount()).toBe(1)

      await vi.advanceTimersByTimeAsync(1000) // t=1000: attempt 1 → continuous
      expect(track.applied.map(c => c.advanced[0].focusMode)).toEqual(['continuous'])

      await vi.advanceTimersByTimeAsync(1000) // t=2000: nextMs(1)=1000 → attempt 2 → manual-near
      expect(track.applied.map(c => c.advanced[0].focusMode)).toEqual(['continuous', 'manual'])
      expect(track.applied[1].advanced[0]).toMatchObject({ focusMode: 'manual', focusDistance: 2.5 })

      await vi.advanceTimersByTimeAsync(1199) // t=3199: the 1200ms revert hold has not elapsed
      expect(track.applied).toHaveLength(2)

      await vi.advanceTimersByTimeAsync(1) // t=3200: revert fires → back to continuous
      expect(track.applied.map(c => c.advanced[0].focusMode)).toEqual(['continuous', 'manual', 'continuous'])

      await vi.advanceTimersByTimeAsync(800) // t=4000: nextMs(2)=2000 → attempt 3
      expect(track.applied.map(c => c.advanced[0].focusMode)).toEqual(['continuous', 'manual', 'continuous', 'manual'])

      await vi.advanceTimersByTimeAsync(1300) // let attempt 3's revert fire before stopping
      stop()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stop() is idempotent and leaves no timer alive', async () => {
    vi.useFakeTimers()
    try {
      // A no-capability track: focusHunt no-ops, so no revert timer is ever
      // scheduled and the only timer in the air is the helper's own interval.
      const track = makeTrack({ caps: {} })
      const stop = beginFocusHunt(track)
      expect(vi.getTimerCount()).toBe(1)

      await vi.advanceTimersByTimeAsync(1000) // one no-op hunt
      expect(track.applyConstraints).not.toHaveBeenCalled()

      stop()
      expect(vi.getTimerCount()).toBe(0)
      stop() // idempotent
      expect(vi.getTimerCount()).toBe(0)

      await vi.advanceTimersByTimeAsync(100000) // nothing further happens
      expect(track.applyConstraints).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
