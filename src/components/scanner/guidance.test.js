/**
 * guidance.test.js — the on-screen hint under the camera.
 *
 * "Move closer to the badge" was REMOVED (2026-11-09). It came from the stripe
 * locator measuring the barcode, and on real badge frames (two photos and a
 * Galaxy A35 preview) the locator boxed a small text patch (~63x13 px) instead
 * of the ~460 px barcode — so it told operators to move closer while the badge
 * already filled the frame, pushing the phone past its focus distance.
 */
import { describe, it, expect } from 'vitest'
import { guidanceFor } from './BarcodeScanner'

describe('guidanceFor', () => {
  it('never tells the operator to move closer (the locator measurement is unreliable)', () => {
    for (const fails of [0, 10, 30, 200]) {
      expect(guidanceFor(null, 9000, false, fails)).not.toBe('Move closer to the badge')
    }
  })

  it('reports lighting problems first', () => {
    expect(guidanceFor('dark', 9000, false, 30)).toBe('Better lighting needed')
    expect(guidanceFor('blurry', 9000, false, 30)).toBe('Hold steady')
  })

  it('falls back to the alignment and focus hints', () => {
    expect(guidanceFor(null, 5000, false, 30)).toBe('Align badge within the frame')
    expect(guidanceFor(null, 9000, false, 30)).toBe('Tap the video to focus')
  })

  it('says nothing while a badge is reading normally', () => {
    expect(guidanceFor(null, 500, true, 0)).toBe(null)
  })
})
