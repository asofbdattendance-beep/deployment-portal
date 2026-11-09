/**
 * scanTuning — speed-profile choice and read confirmation.
 *
 * Field case (Samsung Galaxy A35, Chrome, 2026-11-09): a read of
 * FB5978GA0013 showed in the raw pill but was never accepted, at "3 fps".
 * The startup profiler timed the FIRST (cold) decodes, which pay one-off
 * warm-up cost, so a mid-range phone could be tagged "slow" for the whole
 * session: ~3 fps and a 720 px decode surface. And a read needed a second
 * identical read within 3 s, which sporadic reads at 3 fps rarely give.
 */
import { describe, it, expect } from 'vitest'
import { profileForDetectMs, profileFromSamples, pushConfirmRead, CONFIRM_WINDOW_MS } from './scanTuning'

describe('profileForDetectMs', () => {
  it('maps decode time to a profile', () => {
    expect(profileForDetectMs(10)).toBe('fast')
    expect(profileForDetectMs(60)).toBe('medium')
    expect(profileForDetectMs(200)).toBe('slow')
  })

  it('treats a missing or broken measurement as medium, never slow', () => {
    expect(profileForDetectMs(NaN)).toBe('medium')
    expect(profileForDetectMs(undefined)).toBe('medium')
    expect(profileForDetectMs(-5)).toBe('medium')
  })
})

describe('profileFromSamples', () => {
  it('ignores the first (cold) decode when choosing the profile', () => {
    // Warm-up decode 900 ms, then the phone's real speed (~40 ms).
    expect(profileFromSamples([900, 42, 38, 41])).toBe('medium')
  })

  it('still detects a genuinely slow phone', () => {
    expect(profileFromSamples([900, 250, 230, 260])).toBe('slow')
  })

  it('returns null when there are too few warm samples to judge', () => {
    expect(profileFromSamples([900])).toBeNull()
    expect(profileFromSamples([])).toBeNull()
    expect(profileFromSamples(null)).toBeNull()
  })
})

describe('pushConfirmRead', () => {
  const cfg = { confirmWindow: 3, confirmThreshold: 2 }

  it('needs two identical reads before confirming', () => {
    const first = pushConfirmRead([], 'FB5978GA0013', 1000, cfg)
    expect(first.confirmed).toBe(false)
    const second = pushConfirmRead(first.entries, 'FB5978GA0013', 1300, cfg)
    expect(second.confirmed).toBe(true)
  })

  it('confirms two reads up to CONFIRM_WINDOW_MS apart (sporadic reads on a slow frame rate)', () => {
    expect(CONFIRM_WINDOW_MS).toBe(5000)
    const first = pushConfirmRead([], 'FB5978GA0013', 1000, cfg)
    const second = pushConfirmRead(first.entries, 'FB5978GA0013', 1000 + 4500, cfg)
    expect(second.confirmed).toBe(true)
  })

  it('does not confirm reads further apart than the window', () => {
    const first = pushConfirmRead([], 'FB5978GA0013', 1000, cfg)
    const second = pushConfirmRead(first.entries, 'FB5978GA0013', 1000 + 5100, cfg)
    expect(second.confirmed).toBe(false)
  })

  it('never confirms two different badges together', () => {
    const first = pushConfirmRead([], 'FB5978GA0013', 1000, cfg)
    const second = pushConfirmRead(first.entries, 'FB5978GA0008', 1200, cfg)
    expect(second.confirmed).toBe(false)
  })

  it('returns a new array and does not mutate the input', () => {
    const entries = Object.freeze([{ badge: 'FB5978GA0013', time: 900 }])
    const res = pushConfirmRead(entries, 'FB5978GA0013', 1000, cfg)
    expect(res.entries).not.toBe(entries)
    expect(entries).toHaveLength(1)
  })
})
