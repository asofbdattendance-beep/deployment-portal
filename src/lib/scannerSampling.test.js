/**
 * scannerSampling.test.js — the px/module boundary the normal fixtures miss.
 *
 * WHY: every other decode test renders at 3 px/module (MODULE_PX), a regime
 * no real camera at 20-40 cm ever hits. This suite pins the MEASURED cliff of
 * the production ZXing chain (MultiFormatReader + HybridBinarizer + TRY_HARDER)
 * under a 1 px box blur, because that cliff is the reason the scanner crops
 * the badge at source resolution instead of decoding a downscaled band.
 *
 * Measured 2026-10-31, 10 trials per cell, 4-unit quiet zones, Code 39:
 *   blur r=0 : 10/10 at 3.0, 2.5, 2.0, 1.75, 1.5, 1.25 px/module
 *   blur r=1 : 10/10 at 3.0, 2.5, 2.0  —  0/10 at 1.75, 1.5, 1.25
 *
 * If the lower row ever starts decoding, the platform improved — re-measure
 * and update these numbers rather than deleting the suite.
 */
import { describe, it, expect } from 'vitest'
import * as zx from '@zxing/library'
import { BASE_1D_FORMATS, EXTENDED_1D_FORMATS } from './deviceCapabilities'
import { sanitizeScannedBadge } from './logic'
import { BADGE, encodeCode39, renderAt, boxBlurGray, addSensorNoise } from './barcodeFixtures'

const CONFIGURED_FORMATS = [...new Set([...BASE_1D_FORMATS, ...EXTENDED_1D_FORMATS])]
const ZX_FORMATS = CONFIGURED_FORMATS.map((f) => zx.BarcodeFormat[f.toUpperCase()])
const HINTS = new Map([
  [zx.DecodeHintType.TRY_HARDER, true],
  [zx.DecodeHintType.POSSIBLE_FORMATS, ZX_FORMATS],
])
const reader = new zx.MultiFormatReader()
reader.setHints(HINTS)

function decodeFrame(gray, width, height) {
  const warn = console.warn
  console.warn = () => {}
  try {
    const lum = new zx.RGBLuminanceSource(gray, width, height)
    const res = reader.decode(new zx.BinaryBitmap(new zx.HybridBinarizer(lum)), HINTS)
    return res ? res.getText() : null
  } catch {
    return null
  } finally {
    console.warn = warn
  }
}

/** Fraction of 10 noisy, blurred trials that decode the badge cleanly. */
function decodeRate(elements, ppm, blurRadius, baseSeed) {
  let ok = 0
  for (let i = 0; i < 10; i += 1) {
    const img = renderAt(elements, ppm, { heightPx: 200 })
    const gray = blurRadius > 0 ? boxBlurGray(img.gray, img.width, img.height, blurRadius) : img.gray
    const noisy = addSensorNoise(gray, 4, baseSeed + i)
    const text = decodeFrame(noisy, img.width, img.height)
    const cleaned = text ? sanitizeScannedBadge(text) : null
    if (cleaned && cleaned.includes(BADGE.replace(/[^A-Z0-9]/g, ''))) ok += 1
  }
  return ok
}

describe('scanner sampling boundary (measured, not assumed)', () => {
  it('Code 39 at 2.0 px/module + 1px blur decodes reliably — the 1x-crop regime', () => {
    expect(decodeRate(encodeCode39(BADGE), 2.0, 1, 9101)).toBe(10)
  })

  it('Code 39 at 1.75 px/module + 1px blur does not — the cliff a downscale crosses', () => {
    // Documents the failure regime; a passing value here means the platform
    // improved, so re-measure and relax this bound deliberately.
    expect(decodeRate(encodeCode39(BADGE), 1.75, 1, 9301)).toBeLessThanOrEqual(2)
  })
})
