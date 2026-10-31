/**
 * cameraResolution.test.js — the "firmware ignores `ideal`" path.
 *
 * WHY: OnePlus/OxygenOS-class firmwares resolve `{width:{ideal:1920}}` to
 * 640x480 without throwing, so the resolution ladder in openCameraInner never
 * retries. These tests pin the post-open escalation that fixes it, including
 * every way it must fail safe (must never cost us the working stream).
 */
import { describe, it, expect } from 'vitest'
import { ensureUsableResolution, applyFocusConstraints, focusHunt } from './cameraManager'

function fakeTrack({ width, height, capMax = 1920, capMaxH = 1440, mode = 'ok' } = {}) {
  let settings = { width, height }
  return {
    getSettings: () => settings,
    getCapabilities: () => ({ width: { max: capMax }, height: { max: capMaxH } }),
    async applyConstraints(c) {
      if (mode === 'throw') throw new Error('OverconstrainedError')
      if (mode === 'ignore') return undefined
      settings = { width: c.width.ideal, height: c.height.ideal }
      return undefined
    },
    read: () => settings,
  }
}

describe('ensureUsableResolution', () => {
  it('re-asks at the capability max when the firmware delivered 640x480', async () => {
    const track = fakeTrack({ width: 640, height: 480 })
    const r = await ensureUsableResolution(track)
    expect(r.applied).toBe(true)
    expect(r.from).toBe(640)
    expect(r.to).toBe(1920)
    // Aspect preserved (4:3), not blindly 1080.
    expect(track.read()).toEqual({ width: 1920, height: 1440 })
  })

  it('does nothing when the stream is already usable', async () => {
    const track = fakeTrack({ width: 1280, height: 720 })
    const r = await ensureUsableResolution(track)
    expect(r).toEqual({ applied: false, from: 1280, to: 1280 })
  })

  it('does nothing when the sensor cannot do better than it already did', async () => {
    const track = fakeTrack({ width: 640, height: 480, capMax: 640, capMaxH: 480 })
    const r = await ensureUsableResolution(track)
    expect(r.applied).toBe(false)
    expect(r.capped).toBe(640)
  })

  it('never loses the stream when applyConstraints throws', async () => {
    const track = fakeTrack({ width: 640, height: 480, mode: 'throw' })
    const r = await ensureUsableResolution(track)
    expect(r).toEqual({ applied: false, from: 640, to: 640 })
  })

  it('reports failure when the firmware silently ignores the re-ask', async () => {
    const track = fakeTrack({ width: 640, height: 480, mode: 'ignore' })
    const r = await ensureUsableResolution(track)
    expect(r).toEqual({ applied: false, from: 640, to: 640 })
  })

  it('is a no-op for a missing track', async () => {
    const r = await ensureUsableResolution(null)
    expect(r).toEqual({ applied: false, from: null, to: null })
  })
})

describe('zoom guard on a narrow stream', () => {  function zoomTrack(width) {
    const applied = []
    return {
      applied,
      getSettings: () => ({ width, height: Math.round(width * 0.75) }),
      getCapabilities: () => ({ zoom: { min: 1, max: 4 }, focusMode: ['continuous'] }),
      applyConstraints: async (c) => { applied.push(c) },
      setPointOfInterest: undefined,
    }
  }

  it('skips digital zoom when the firmware delivered a narrow stream', async () => {
    const track = zoomTrack(640)
    await applyFocusConstraints(track)
    expect(track.applied.some((c) => c.advanced?.some((a) => 'zoom' in a))).toBe(false)
  })

  it('still applies zoom on a wide stream', async () => {
    const track = zoomTrack(1920)
    const r = await applyFocusConstraints(track)
    expect(track.applied.some((c) => c.advanced?.some((a) => 'zoom' in a))).toBe(true)
    expect(r.zoomApplied).toBe(true)
  })
})

describe('autofocus fallback (H2)', () => {
  function focusTrack(modes) {
    const applied = []
    return {
      applied,
      getSettings: () => ({ width: 1920, height: 1080 }),
      getCapabilities: () => ({ focusMode: modes }),
      applyConstraints: async (c) => { applied.push(c) },
      modesApplied: () => applied.map((c) => c.advanced?.[0]?.focusMode).filter(Boolean),
    }
  }

  it('focusHunt falls back to single-shot when the firmware never offers continuous AF', async () => {
    const track = focusTrack(['single-shot', 'manual'])
    const r = await focusHunt(track, 1)
    expect(track.modesApplied()).toEqual(['single-shot'])
    expect(r.mode).toBe('single-shot')
    expect(r.ok).toBe(true)
  })

  it('focusHunt still prefers continuous when the device offers it', async () => {
    const track = focusTrack(['continuous', 'single-shot'])
    const r = await focusHunt(track, 1)
    expect(track.modesApplied()).toEqual(['continuous'])
    expect(r.mode).toBe('continuous')
  })

  it('focusHunt stays a no-op when the track exposes no focus modes at all', async () => {
    const track = focusTrack([])
    const r = await focusHunt(track, 1)
    expect(track.modesApplied()).toEqual([])
    expect(r).toEqual({ mode: 'none', ok: false, nextMs: r.nextMs })
  })
})
