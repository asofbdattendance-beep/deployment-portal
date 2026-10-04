/**
 * scannerDecode.dataset.test.js — synthetic barcode decode regression dataset.
 *
 * WHY THIS EXISTS: real badge photos contain real VSFB numbers and sewadar
 * names, so they can never be committed to this repo — yet the production
 * decode path had no CI-runnable regression coverage. The frames come from
 * src/lib/barcodeFixtures.js (shared with enginePool.hints.test.js): minimal
 * Code 39 / Code 128 encoders plus the library's own QR / DataMatrix writers
 * render synthetic grayscale frames (3 px modules + 4-module quiet zone), and
 * every decode runs through the exact ZXing chain production uses
 * (enginePool.js: RGBLuminanceSource → HybridBinarizer → MultiFormatReader).
 *
 * PII: no image file and no real badge value is read or imported anywhere in
 * this file — every fixture is generated from synthetic constants.
 */
import { describe, it, expect } from 'vitest'
import * as zx from '@zxing/library'
import { rotateGray } from './scannerUtils'
import { BASE_1D_FORMATS, EXTENDED_1D_FORMATS, HARD_PATH_2D_FORMATS } from './deviceCapabilities'
import { sanitizeScannedBadge } from './logic'
import { BADGE, encodeCode39, encodeCode128B, render1D, render2D, invertGray } from './barcodeFixtures'


// ─── Production decode chain (mirrors enginePool.js initZXing) ───────────────
const CONFIGURED_FORMATS = [...new Set([
  ...BASE_1D_FORMATS,
  ...EXTENDED_1D_FORMATS,
  ...HARD_PATH_2D_FORMATS,
])]
const ZX_FORMATS = CONFIGURED_FORMATS.map((f) => zx.BarcodeFormat[f.toUpperCase()])

// One STABLE Map, built once and handed to every decode — the same shape
// enginePool.js initZXing uses after the hint-discard fix.
const HINTS = new Map([
  [zx.DecodeHintType.TRY_HARDER, true],
  [zx.DecodeHintType.POSSIBLE_FORMATS, ZX_FORMATS],
])
const reader = new zx.MultiFormatReader()
reader.setHints(HINTS)

/**
 * Decode a grayscale frame via the exact production chain:
 * RGBLuminanceSource → HybridBinarizer → MultiFormatReader.decode(bitmap, hints).
 *
 * NOTE: enginePool.js used to call decode(bitmap) with no hint argument, which
 * in @zxing/library 0.23.0 re-runs setHints(undefined) and silently discards
 * the configured POSSIBLE_FORMATS and TRY_HARDER — so the effective config was
 * the library default (every symbology, no TRY_HARDER). That is fixed in
 * production (enginePool.js passes a stable Map; see enginePool.hints.test.js
 * for the red-green proof), and this file mirrors the FIXED chain by passing
 * HINTS explicitly. Coverage here includes every configured format, so the
 * result is identical either way — but mirroring the fixed call keeps the
 * "exact production chain" claim in this header true.
 */
function decodeFrame(gray, width, height) {
  // ZXing logs every failed decode via console.warn; expected-failure
  // assertions would otherwise drown the suite in stack traces.
  const warn = console.warn
  const log = console.log
  console.warn = () => {}
  console.log = () => {}
  try {
    const lum = new zx.RGBLuminanceSource(gray, width, height)
    return reader.decode(new zx.BinaryBitmap(new zx.HybridBinarizer(lum)), HINTS)
  } finally {
    console.warn = warn
    console.log = log
  }
}

// ─── Format round-trip dataset ───────────────────────────────────────────────
// One entry per format that has a writer in this @zxing/library build. The
// skip list below is derived from the same imported constants, so it follows
// deviceCapabilities.js automatically.
const FRAME_BY_FORMAT = {
  code_39: () => render1D(encodeCode39(BADGE)),
  code_128: () => render1D(encodeCode128B(BADGE)),
  qr_code: () => render2D(new zx.QRCodeWriter().encode(BADGE, zx.BarcodeFormat.QR_CODE, 0, 0, new Map())),
  data_matrix: () => render2D(new zx.DataMatrixWriter().encode(BADGE, zx.BarcodeFormat.DATA_MATRIX, 0, 0, new Map())),
}
const ENCODABLE_FORMATS = CONFIGURED_FORMATS.filter((f) => FRAME_BY_FORMAT[f])
const SKIPPED_FORMATS = CONFIGURED_FORMATS.filter((f) => !FRAME_BY_FORMAT[f])

describe('format round-trip (encode → render → production decode)', () => {
  it('writer availability: this @zxing/library build ships QR + DataMatrix writers only', () => {
    expect(typeof zx.QRCodeWriter).toBe('function')
    expect(typeof zx.DataMatrixWriter).toBe('function')
    expect(zx.Code39Writer).toBeUndefined()
    expect(zx.Code128Writer).toBeUndefined()
  })

  for (const format of ENCODABLE_FORMATS) {
    it(`${format}: encodes, renders, and decodes back to the original value`, () => {
      const { gray, width, height } = FRAME_BY_FORMAT[format]()
      const result = decodeFrame(gray, width, height)
      expect(result.getText()).toBe(BADGE)
    })
  }

  for (const format of SKIPPED_FORMATS) {
    it.skip(`${format}: no writer in @zxing/library 0.23.0 — the package ships only QRCodeWriter, DataMatrixWriter and AztecCodeWriter; MultiFormatWriter's 1D/PDF417 imports are commented out`, () => {})
  }
})

// ─── Orientation matrix ──────────────────────────────────────────────────────
// A badge held sideways or a white-on-black print must still read after the
// hard path's rotateGray / inversion fix-ups. The 90° case simulates a frame
// captured with the barcode a quarter-turn off-axis (upright rotated 270°),
// which the operator's hard path uprights with rotateGray(..., 90).
describe('orientation matrix (Code 39 + Code 128)', () => {
  const FORMATS = [
    ['code_39', encodeCode39],
    ['code_128', encodeCode128B],
  ]
  for (const [format, encode] of FORMATS) {
    describe(format, () => {
      it('0° decodes directly', () => {
        const { gray, width, height } = render1D(encode(BADGE))
        expect(decodeFrame(gray, width, height).getText()).toBe(BADGE)
      })

      it('90° fails directly but succeeds after rotateGray(..., 90)', () => {
        const upright = render1D(encode(BADGE))
        const sideways = rotateGray(upright.gray, upright.width, upright.height, 270)
        expect(() => decodeFrame(sideways.gray, sideways.width, sideways.height)).toThrow()
        const fixed = rotateGray(sideways.gray, sideways.width, sideways.height, 90)
        expect(decodeFrame(fixed.gray, fixed.width, fixed.height).getText()).toBe(BADGE)
      })

      it('inverted fails directly but succeeds after re-inversion', () => {
        const { gray, width, height } = render1D(encode(BADGE))
        const inverted = invertGray(gray)
        expect(() => decodeFrame(inverted, width, height)).toThrow()
        expect(decodeFrame(invertGray(inverted), width, height).getText()).toBe(BADGE)
      })

      it('rotated + inverted fails directly but succeeds after rotateGray(..., 90) + re-inversion', () => {
        const upright = render1D(encode(BADGE))
        const sideways = rotateGray(upright.gray, upright.width, upright.height, 270)
        const sidewaysInverted = invertGray(sideways.gray)
        expect(() => decodeFrame(sidewaysInverted, sideways.width, sideways.height)).toThrow()
        const unrotated = rotateGray(sidewaysInverted, sideways.width, sideways.height, 90)
        const fixed = invertGray(unrotated.gray)
        expect(decodeFrame(fixed, unrotated.width, unrotated.height).getText()).toBe(BADGE)
      })
    })
  }
})

// ─── Sanitiser ───────────────────────────────────────────────────────────────
// Decoders hand back exactly the bytes they saw: Code 39 start/stop guards,
// stray case, and character confusions (O↔0) that turn a real badge into a
// string the validator rejects.
describe('sanitiser recovers decoder-corrupted values', () => {
  it('strips Code 39 start/stop guards from a decoded value', () => {
    expect(sanitizeScannedBadge(`*${BADGE}*`)).toBe(BADGE)
  })

  it('repairs O→0 confusion in digit positions', () => {
    expect(sanitizeScannedBadge('FB5971GAOO01')).toBe(BADGE)
  })

  it('normalises a lowercase decode', () => {
    expect(sanitizeScannedBadge(BADGE.toLowerCase())).toBe(BADGE)
  })

  it('is idempotent on a clean value', () => {
    expect(sanitizeScannedBadge(BADGE)).toBe(BADGE)
  })
})

// ─── Timing smoke ────────────────────────────────────────────────────────────
it('SMOKE TEST (timing): one production decode completes in < 500 ms', () => {
  const { gray, width, height } = render1D(encodeCode39(BADGE))
  const t0 = Date.now()
  decodeFrame(gray, width, height)
  expect(Date.now() - t0).toBeLessThan(500)
})
