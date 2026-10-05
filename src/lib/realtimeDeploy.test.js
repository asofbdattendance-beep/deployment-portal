// Pins the shared Consent/VSS realtime cadence: both deployment channels
// must coalesce bursts with the same trailing debounce and the same
// own-save echo-skip window. If either page drifts, this goes red.
import { describe, it, expect } from 'vitest'
import {
  REALTIME_RELOAD_DEBOUNCE_MS,
  REALTIME_SELF_SKIP_MS,
  shouldSkipSelfWrite,
} from './realtimeDeploy'

describe('deployment realtime cadence', () => {
  it('keeps the trailing debounce at 600ms on both channels', () => {
    expect(REALTIME_RELOAD_DEBOUNCE_MS).toBe(600)
  })

  it('keeps the own-save echo-skip window at 1500ms on both channels', () => {
    expect(REALTIME_SELF_SKIP_MS).toBe(1500)
  })

  it('skips events inside the echo window, fires at/after the boundary', () => {
    expect(shouldSkipSelfWrite(1000, 1000 + 1499)).toBe(true)
    expect(shouldSkipSelfWrite(1000, 1000 + 1500)).toBe(false)
    expect(shouldSkipSelfWrite(1000, 1000 + 5000)).toBe(false)
  })
})
