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
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as zx from '@zxing/library'
import { writeBarcode, prepareZXingModule } from 'zxing-wasm/writer'
import { loadZxingCpp, toCppFormats } from '../components/scanner/zxingCppEngine'
import { rotateGray } from './scannerUtils'
import { BASE_1D_FORMATS, EXTENDED_1D_FORMATS, HARD_PATH_2D_FORMATS } from './deviceCapabilities'
import { sanitizeScannedBadge } from './logic'
import { BADGE, MODULE_PX, encodeCode39, encodeCode128B, render1D, render2D, invertGray } from './barcodeFixtures'


// ─── Production decode chain (mirrors enginePool.js initZXing) ───────────────
const CONFIGURED_FORMATS = [...new Set([
  ...BASE_1D_FORMATS,
  ...EXTENDED_1D_FORMATS,
  ...HARD_PATH_2D_FORMATS,
])]
/** Our format string → zx.BarcodeFormat member (pdf417's member is PDF_417),
 *  mirroring enginePool.js toZxingFormats. */
const zxFormat = (format) => zx.BarcodeFormat[format === 'pdf417' ? 'PDF_417' : format.toUpperCase()]
const ZX_FORMATS = CONFIGURED_FORMATS.map(zxFormat)

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
// Every configured format is encoded, rendered and decoded back through the
// production chain — nothing is skipped. @zxing/library 0.23.0 only ships QR /
// DataMatrix / Aztec writers, so the other symbologies are encoded with the
// zxing-cpp writer from zxing-wasm (already a dependency). Its .wasm is read
// from node_modules — never the CDN — so the suite stays offline.
//
// Numeric-only symbologies (EAN / UPC / ITF) and Codabar cannot carry a badge
// like FB5971GA0001, so they round-trip a valid synthetic value instead.
const FRAME_BY_FORMAT = {
  code_39: () => render1D(encodeCode39(BADGE)),
  code_128: () => render1D(encodeCode128B(BADGE)),
  qr_code: () => render2D(new zx.QRCodeWriter().encode(BADGE, zx.BarcodeFormat.QR_CODE, 0, 0, new Map())),
  data_matrix: () => render2D(new zx.DataMatrixWriter().encode(BADGE, zx.BarcodeFormat.DATA_MATRIX, 0, 0, new Map())),
}
const LIBRARY_EXPECTED = Object.fromEntries(Object.keys(FRAME_BY_FORMAT).map((f) => [f, BADGE]))

// format → [zxing-cpp writer format, payload, text the decoders return].
// Codabar keeps its start/stop letters (A…B) in the decoded text.
const WASM_CASES = {
  code_93: ['Code93', BADGE, BADGE],
  codabar: ['Codabar', 'A40156B', 'A40156B'],
  ean_13: ['EAN13', '5901234123457', '5901234123457'],
  ean_8: ['EAN8', '96385074', '96385074'],
  itf: ['ITF', '0123456789', '0123456789'],
  upc_a: ['UPCA', '036000291452', '036000291452'],
  upc_e: ['UPCE', '01234565', '01234565'],
  pdf417: ['PDF417', BADGE, BADGE],
}

// @zxing/library 0.23.0 cannot read UPC-E at all: UPCEANReader.decodeRow
// calls the STATIC UPCEANReader.decodeEnd instead of this.decodeEnd, so
// UPCEReader's 6-module end guard override is never used and every UPC-E row
// fails the 3-module guard check. Production prefers zxing-cpp (Native →
// zxing-cpp → ZXing-JS), which reads UPC-E; only the ZXing-JS fallback can't.
const ZXING_JS_CANNOT_READ = new Set(['upc_e'])

// zxing-cpp reports UPC-A and UPC-E in their 13-digit EAN-13 form (leading
// 0; UPC-E also expanded to UPC-A first).
const CPP_TEXT = { upc_a: '0036000291452', upc_e: '0012345000065' }

// 1D symbologies need a wider quiet zone than the shared 4-module default
// (EAN/UPC specify 7–9 modules); 10 satisfies all of them.
const WASM_QUIET_MODULES = 10

/** Render a zxing-cpp symbol (1 px per module, 0 = bar) at MODULE_PX. */
function renderSymbol({ data, width: sw, height: sh }) {
  const pad = WASM_QUIET_MODULES * MODULE_PX
  const width = sw * MODULE_PX + 2 * pad
  const height = sh * MODULE_PX + 2 * pad
  const gray = new Uint8ClampedArray(width * height).fill(255)
  for (let y = 0; y < sh * MODULE_PX; y += 1) {
    for (let x = 0; x < sw * MODULE_PX; x += 1) {
      gray[(pad + y) * width + pad + x] = data[Math.floor(y / MODULE_PX) * sw + Math.floor(x / MODULE_PX)]
    }
  }
  return { gray, width, height }
}

/** Gray frame → RGBA ImageData shape the zxing-cpp engine takes. */
function toRgba({ gray, width, height }) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < gray.length; i += 1) {
    data[i * 4] = gray[i]; data[i * 4 + 1] = gray[i]; data[i * 4 + 2] = gray[i]; data[i * 4 + 3] = 255
  }
  return { data, width, height }
}

const require = createRequire(import.meta.url)
const wasmBytes = (path) => {
  const b = readFileSync(require.resolve(path))
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
}

const wasmFrames = {}
let cppDecode = null
beforeAll(async () => {
  await prepareZXingModule({ overrides: { wasmBinary: wasmBytes('zxing-wasm/writer/zxing_writer.wasm') }, fireImmediately: true })
  for (const [format, [writerFormat, payload]] of Object.entries(WASM_CASES)) {
    const out = await writeBarcode(payload, { format: writerFormat })
    if (out.error) throw new Error(`${format}: zxing-cpp writer failed: ${out.error}`)
    wasmFrames[format] = renderSymbol(out.symbol)
  }
  // the production zxing-cpp engine, loaded exactly as enginePool loads it
  cppDecode = await loadZxingCpp({ wasmBinary: wasmBytes('zxing-wasm/reader/zxing_reader.wasm'), attempts: 1 })
  if (!cppDecode) throw new Error('zxing-cpp engine failed to load')
})

const frameFor = (format) => (FRAME_BY_FORMAT[format] ? FRAME_BY_FORMAT[format]() : wasmFrames[format])
const expectedText = (format) => LIBRARY_EXPECTED[format] ?? WASM_CASES[format][2]

describe('format round-trip (encode → render → production decode)', () => {
  it('writer availability: @zxing/library ships QR + DataMatrix writers only (so zxing-cpp covers the rest)', () => {
    expect(typeof zx.QRCodeWriter).toBe('function')
    expect(typeof zx.DataMatrixWriter).toBe('function')
    expect(zx.Code39Writer).toBeUndefined()
    expect(zx.Code128Writer).toBeUndefined()
  })

  it('covers every configured format — none may be left untested', () => {
    const covered = new Set([...Object.keys(FRAME_BY_FORMAT), ...Object.keys(WASM_CASES)])
    expect(CONFIGURED_FORMATS.filter((f) => !covered.has(f))).toEqual([])
    expect(CONFIGURED_FORMATS.filter((f) => zxFormat(f) === undefined)).toEqual([])
  })

  describe('ZXing-JS engine (MultiFormatReader, production hints)', () => {
    for (const format of CONFIGURED_FORMATS.filter((f) => !ZXING_JS_CANNOT_READ.has(f))) {
      it(`${format}: decodes back to the original value`, () => {
        const { gray, width, height } = frameFor(format)
        const result = decodeFrame(gray, width, height)
        expect(result.getText()).toBe(expectedText(format))
        expect(result.getBarcodeFormat()).toBe(zxFormat(format))
      })
    }

    it('upc_e: @zxing/library 0.23.0 cannot read a valid UPC-E (library bug — zxing-cpp covers it)', () => {
      const { gray, width, height } = frameFor('upc_e')
      // If this starts passing after a library upgrade, move upc_e back into
      // the loop above and delete ZXING_JS_CANNOT_READ.
      expect(() => decodeFrame(gray, width, height)).toThrow()
    })
  })

  describe('zxing-cpp engine (production loadZxingCpp + toCppFormats)', () => {
    const cppOptions = { formats: toCppFormats(CONFIGURED_FORMATS), tryHarder: true }

    it('maps every configured format to a zxing-cpp name', () => {
      expect(cppOptions.formats).toHaveLength(CONFIGURED_FORMATS.length)
    })

    for (const format of CONFIGURED_FORMATS) {
      it(`${format}: decodes back to the original value`, async () => {
        const hits = await cppDecode(toRgba(frameFor(format)), cppOptions)
        expect(hits.map((h) => h.rawValue)).toEqual([CPP_TEXT[format] ?? expectedText(format)])
      })
    }
  })
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
