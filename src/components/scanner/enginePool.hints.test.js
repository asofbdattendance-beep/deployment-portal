// @vitest-environment jsdom
/**
 * enginePool.hints.test.js — proof that the ZXing hint configuration is LIVE.
 *
 * WHY THIS IS A SEPARATE FILE: enginePool.test.jsx mocks `@zxing/library`, and
 * its fake `decode(bitmap)` cannot reproduce the real MultiFormatReader
 * contract — so a mock can only prove we CALL decode, never that our
 * POSSIBLE_FORMATS / TRY_HARDER hints survive the call. This file runs the
 * REAL @zxing/library against frames from src/lib/barcodeFixtures.js.
 *
 * THE BUG IT GUARDS (fixed in enginePool.js initZXing):
 *   MultiFormatReader.decode is `if (this.hints !== hints) this.setHints(hints)`.
 *   The pool used to call `reader.decode(bitmap)` — one argument — so `hints`
 *   was `undefined`, the comparison was always true, and setHints(undefined)
 *   threw away the configured format list and TRY_HARDER on the FIRST frame.
 *   Every frame then attempted every symbology the library ships (a frame-time
 *   tax the tier budgets exist to avoid), while the Native leg stayed properly
 *   tier-filtered. The old behaviour also meant the format list was decorative:
 *   a Code 128 frame decoded even when the pool was configured for code_39 only.
 *
 * Each test below is RED before the fix and GREEN after it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as zx from '@zxing/library'
import { createEnginePool } from './enginePool'
import { BADGE, encodeCode39, encodeCode128B, render1D, render2D } from '../../lib/barcodeFixtures'

/** Gray frame → the RGBA ImageData shape enginePool's `surface.read()` returns. */
const toRgba = ({ gray, width, height }) => {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < gray.length; i += 1) {
    data[i * 4] = gray[i]
    data[i * 4 + 1] = gray[i]
    data[i * 4 + 2] = gray[i]
    data[i * 4 + 3] = 255
  }
  return { data, width, height }
}

/** The cropped-frame contract detect()/hardPass() expect: truthy canvas + read(). */
const surface = (frame) => {
  const rgba = toRgba(frame)
  return { canvas: {}, read: () => rgba }
}

const frameCode39 = () => render1D(encodeCode39(BADGE))
const frameCode128 = () => render1D(encodeCode128B(BADGE))
const frameQr = () => render2D(new zx.QRCodeWriter().encode(BADGE, zx.BarcodeFormat.QR_CODE, 0, 0, new Map()))

/** ZXing warns on every miss; expected-miss assertions would drown the suite. */
let warn, log
beforeEach(() => {
  warn = console.warn
  log = console.log
  console.warn = () => {}
  console.log = () => {}
})
afterEach(() => {
  console.warn = warn
  console.log = log
  vi.restoreAllMocks()
})

describe('enginePool ZXing hints are honoured (regression: decode(bitmap) wiped them)', () => {
  it('calls setHints exactly ONCE — no rebuild and no wipe across frames', async () => {
    const setHints = vi.spyOn(zx.MultiFormatReader.prototype, 'setHints')
    const pool = createEnginePool(false, { formats: ['code_39'] })
    await pool.init()

    const s = surface(frameCode39())
    await pool.detect(s)
    await pool.detect(s)
    await pool.detect(s)

    // The fix hands decode() a STABLE Map, so `this.hints !== hints` is false
    // and setHints never re-fires. The old bare decode(bitmap) fired it with
    // `undefined` on the first frame (2 calls, last one undefined).
    expect(setHints).toHaveBeenCalledTimes(1)
    const applied = setHints.mock.calls[0][0]
    expect(applied).toBeInstanceOf(Map)
    expect(applied.get(zx.DecodeHintType.TRY_HARDER)).toBe(true)
    expect(applied.get(zx.DecodeHintType.POSSIBLE_FORMATS)).toEqual([zx.BarcodeFormat.CODE_39])
  })

  it('enforces the configured format list: a Code 128 frame does NOT decode', async () => {
    const pool = createEnginePool(false, { formats: ['code_39'] })
    await pool.init()

    // Positive control first: the same pipeline reads a Code 39 frame, so an
    // empty result below means FILTERING, not a broken renderer.
    const hit = await pool.detect(surface(frameCode39()))
    expect(hit.engine).toBe('ZXing')
    expect(hit.barcodes.map(b => b.rawValue)).toContain(BADGE)

    // With the hints wiped this decoded happily — the configured list was
    // decorative. Now POSSIBLE_FORMATS is real and ZXing never builds a
    // Code 128 reader.
    const miss = await pool.detect(surface(frameCode128()))
    expect(miss.barcodes).toEqual([])
  })

  it('the hard path widens to 2D that the normal path rejects', async () => {
    const pool = createEnginePool(false, { formats: ['code_39'] })
    await pool.init()

    // Base list is 1D-only, so QR must be invisible to a normal frame.
    const normal = await pool.detect(surface(frameQr()))
    expect(normal.barcodes).toEqual([])

    // hardPathFormats defaults to base + HARD_PATH_2D_FORMATS, so the second
    // look is where 2D is actually attempted — capability preserved without
    // taxing every frame for it.
    const hard = await pool.hardPass(surface(frameQr()))
    expect(hard.barcodes.map(b => b.rawValue)).toContain(BADGE)
    expect(hard.engine).toBe('ZXing')
  })

  it('hardHints and baseHints are the SAME Map when the tier does not widen', async () => {
    // A tier that keeps its hard set identical must pay ZERO reader rebuilds
    // when it alternates base ↔ hard, which only holds if both point at one Map.
    const pool = createEnginePool(false, { formats: ['code_39'], hardPathFormats: ['code_39'] })
    await pool.init()
    const setHints = vi.spyOn(zx.MultiFormatReader.prototype, 'setHints')
    const s = surface(frameCode39())
    await pool.detect(s)
    await pool.hardPass(s)
    await pool.detect(s)
    expect(setHints).not.toHaveBeenCalled()
  })
})
