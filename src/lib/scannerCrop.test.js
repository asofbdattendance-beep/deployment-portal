/**
 * scannerCrop.test.js — the source-resolution crop path, end to end, on one frame.
 *
 * WHY THIS TEST EXISTS: `computeRoi` downsamples the band before the decoder
 * sees it (1080 px wide -> 640 on a low tier). That throws away exactly the
 * px/module that decides a read near the ZXing cliff. The fix is: locate the
 * badge on the band, map its box back to video pixels, and decode a 1:1 crop.
 *
 * The only honest proof of that fix is a frame where the two paths disagree:
 *   - band path  (downscaled)  -> does not decode
 *   - crop path  (source 1:1)  -> decodes
 * Everything below runs the REAL production pieces: computeRoi, locateBarcode,
 * bandBoxToVideoPx, cropGrayByBox, and the enginePool ZXing chain. No canvas is
 * involved, so this is the geometry + pixels claim, not the drawImage glue.
 *
 * Measured 2026-10-31 for this exact frame (10 seeds): band 0/10, crop 10/10.
 */
import { describe, it, expect } from 'vitest'
import * as zx from '@zxing/library'
import { computeRoi, bandBoxToVideoPx, cropGrayByBox } from './scannerUtils'
import { locateBarcode } from '../components/scanner/barcodeLocator'
import { planSourceCrop } from '../components/scanner/cropPlan'
import { BASE_1D_FORMATS, EXTENDED_1D_FORMATS } from './deviceCapabilities'
import { sanitizeScannedBadge } from './logic'
import { BADGE, QUIET_UNITS, encodeCode39, renderAt, boxBlurGray, addSensorNoise } from './barcodeFixtures'

// ─── Production decode chain (mirrors enginePool.js initZXing) ───────────────
const CONFIGURED_FORMATS = [...new Set([...BASE_1D_FORMATS, ...EXTENDED_1D_FORMATS])]
const ZX_FORMATS = CONFIGURED_FORMATS.map((f) => zx.BarcodeFormat[f.toUpperCase()])
const HINTS = new Map([
  [zx.DecodeHintType.TRY_HARDER, true],
  [zx.DecodeHintType.POSSIBLE_FORMATS, ZX_FORMATS],
])
const reader = new zx.MultiFormatReader()
reader.setHints(HINTS)

function decodeMatchesBadge(gray, width, height) {
  const warn = console.warn
  console.warn = () => {}
  try {
    const lum = new zx.RGBLuminanceSource(gray, width, height)
    const res = reader.decode(new zx.BinaryBitmap(new zx.HybridBinarizer(lum)), HINTS)
    const cleaned = res ? sanitizeScannedBadge(res.getText()) : null
    return Boolean(cleaned && cleaned.includes(BADGE.replace(/[^A-Z0-9]/g, '')))
  } catch {
    return false
  } finally {
    console.warn = warn
  }
}

// ─── The frame under test ────────────────────────────────────────────────────
// 1080p portrait-ish stream, low-tier budget: the band is 994 px wide and the
// decoder only ever sees 640 of them (scale 0.644). Badge at 2.0 px/module is
// 1.29 px/module after that downscale — under the measured cliff.
const VW = 1080
const VH = 607
const SOURCE_PPM = 2.0
const ROI = computeRoi(VW, VH, { mode: 'band', maxWidth: 640 })
const BADGE_X = 300
const BADGE_Y = 200
const PAD = 8 // surface px, same value BarcodeScanner passes

/** Area-average resample of `roi` out of the frame — what drawImage does to the band. */
function resampleRoi(frame, roi) {
  const out = new Uint8ClampedArray(roi.dw * roi.dh)
  const fx = roi.sw / roi.dw
  const fy = roi.sh / roi.dh
  for (let y = 0; y < roi.dh; y += 1) {
    const y0 = Math.floor(roi.sy + y * fy)
    const y1 = Math.max(y0 + 1, Math.floor(roi.sy + (y + 1) * fy))
    for (let x = 0; x < roi.dw; x += 1) {
      const x0 = Math.floor(roi.sx + x * fx)
      const x1 = Math.max(x0 + 1, Math.floor(roi.sx + (x + 1) * fx))
      let sum = 0
      let n = 0
      for (let yy = y0; yy < y1; yy += 1) {
        for (let xx = x0; xx < x1; xx += 1) { sum += frame[yy * VW + xx]; n += 1 }
      }
      out[y * roi.dw + x] = n ? Math.round(sum / n) : 240
    }
  }
  return out
}

function buildFrame(seed) {
  // 1 px optical blur + sensor noise: a sharp badge is not the case that fails.
  const fixture = renderAt(encodeCode39(BADGE), SOURCE_PPM, { heightPx: 200 })
  const blurred = boxBlurGray(fixture.gray, fixture.width, fixture.height, 1)
  const noisy = addSensorNoise(blurred, 4, seed)
  const frame = new Uint8ClampedArray(VW * VH).fill(240)
  for (let y = 0; y < fixture.height; y += 1) {
    for (let x = 0; x < fixture.width; x += 1) {
      frame[(BADGE_Y + y) * VW + (BADGE_X + x)] = noisy[y * fixture.width + x]
    }
  }
  return { frame, fixture, band: resampleRoi(frame, ROI) }
}

const SEEDS = [7001, 7002, 7003, 7004, 7005, 7006, 7007, 7008, 7009, 7010]

describe('source-resolution crop', () => {
  it('the downscaled band cannot read the badge at 2.0 px/module + 1 px blur', () => {
    let ok = 0
    for (const seed of SEEDS) {
      const { band } = buildFrame(seed)
      if (decodeMatchesBadge(band, ROI.dw, ROI.dh)) ok += 1
    }
    // Documents the failing regime; a higher value means the platform improved,
    // so re-measure before relaxing this.
    expect(ok).toBeLessThanOrEqual(1)
  })

  it('locator → video px → 1:1 crop reads the same frame', () => {
    let ok = 0
    for (const seed of SEEDS) {
      const { frame, band } = buildFrame(seed)
      // The shipped decision function, not a re-implementation of it.
      const rect = planSourceCrop(band, ROI.dw, ROI.dh, ROI, VW, VH, PAD)
      expect(rect).toBeTruthy()
      const crop = cropGrayByBox(frame, VW, VH, rect, 0)
      expect(crop).toBeTruthy()
      if (decodeMatchesBadge(crop.gray, crop.width, crop.height)) ok += 1
    }
    expect(ok).toBeGreaterThanOrEqual(9)
  })

  it('planSourceCrop declines a frame with no badge instead of cropping junk', () => {
    const blank = new Uint8ClampedArray(ROI.dw * ROI.dh).fill(240)
    expect(planSourceCrop(blank, ROI.dw, ROI.dh, ROI, VW, VH, PAD)).toBeNull()
    expect(planSourceCrop(null, ROI.dw, ROI.dh, ROI, VW, VH, PAD)).toBeNull()
  })

  it('declines when the band was never downscaled (roi.scale === 1)', () => {
    // Same band, same badge — the locator WILL find it here, so only the gate
    // can produce null. With no downscale the band already holds every source
    // pixel; the crop can add no px/module and the locator costs ~5 ms
    // (measured 4.6 ms @994x615) on the decode thread for nothing.
    const { band } = buildFrame(SEEDS[0])
    expect(planSourceCrop(band, ROI.dw, ROI.dh, { ...ROI, scale: 1 }, VW, VH, PAD)).toBeNull()
  })

  it('bandBoxToVideoPx lands on the badge, not the wrong region', () => {
    const { band, fixture } = buildFrame(SEEDS[0])
    const box = locateBarcode(band, ROI.dw, ROI.dh, { minConfidence: 0.55 })
    const rect = bandBoxToVideoPx(box, ROI, VW, VH, PAD)
    // The locator box is tight around the BARS (the fixture's quiet zones sit
    // outside it), so containment is judged on the bar extent.
    const q = QUIET_UNITS * SOURCE_PPM
    const barX0 = BADGE_X + q
    const barX1 = BADGE_X + fixture.width - q
    expect(rect.x).toBeLessThanOrEqual(barX0)
    expect(rect.x + rect.w).toBeGreaterThanOrEqual(barX1)
    expect(rect.y).toBeLessThanOrEqual(BADGE_Y)
    expect(rect.y + rect.h).toBeGreaterThanOrEqual(BADGE_Y + fixture.height)
    // ...without wandering off: the pad scales back up (8 / 0.644 ≈ 13 px).
    const maxMargin = Math.ceil(PAD / (ROI.dw / ROI.sw)) + 4
    expect(barX0 - rect.x).toBeLessThanOrEqual(maxMargin)
    expect(rect.x + rect.w - barX1).toBeLessThanOrEqual(maxMargin)
    expect(BADGE_Y - rect.y).toBeLessThanOrEqual(maxMargin)
    expect(rect.y + rect.h - (BADGE_Y + fixture.height)).toBeLessThanOrEqual(maxMargin)
  })
})
