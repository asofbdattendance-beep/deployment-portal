/**
 * guidance.test.js — the "it just refuses" message.
 *
 * WHY: when the locator can see a badge but measures it below ~2.2 px/module,
 * no engine can decode it. Telling the operator to "align the badge" is then a
 * lie that reads as a broken scanner; the only action that can work is moving
 * closer. These pin that branch and its precedence.
 */
import { describe, it, expect } from 'vitest'
import { guidanceFor } from './BarcodeScanner'

describe('guidanceFor', () => {
  it('asks the operator to move closer when the badge is too small to decode', () => {
    expect(guidanceFor(null, 9000, false, 30, true)).toBe('Move closer to the badge')
  })

  it('still reports lighting problems first — they are also actionable', () => {
    expect(guidanceFor('dark', 9000, false, 30, true)).toBe('Better lighting needed')
    expect(guidanceFor('blurry', 9000, false, 30, true)).toBe('Hold steady')
  })

  it('falls back to the old alignment hints when the badge is big enough', () => {
    expect(guidanceFor(null, 5000, false, 30, false)).toBe('Align badge within the frame')
    expect(guidanceFor(null, 9000, false, 30, false)).toBe('Tap the video to focus')
  })

  it('says nothing while a badge is reading normally', () => {
    expect(guidanceFor(null, 500, true, 0, false)).toBe(null)
  })
})
