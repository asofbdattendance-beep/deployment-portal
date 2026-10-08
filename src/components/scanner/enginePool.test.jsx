// @vitest-environment jsdom
/**
 * enginePool — fallback coherence + ZXing result shaping.
 *
 * L-14: the pool used to flap 0→1→0 across frames when the fallback target
 * was never loaded (native-only init leaves ZXing `ready:false`), flapping
 * the engine label and burning frames on an engine that can never answer.
 * L-15: the ZXing path hardcoded `cornerPoints: []`, so the frame-edge guard
 * (which needs >= 2 points) silently differed by engine/browser.
 *
 * Also covers the empty-result handoff (a clean-miss run hands the active
 * engine off to the other ready one exactly once), tier-driven format mapping,
 * and hardPass (every ready engine, normal + inverted + rotated, merged +
 * deduped).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  decodeImpl: null,
  failReaderBuild: false,
  nativeDetectImpl: () => Promise.resolve([]),
  lastHints: null,
  nativeFormats: undefined,
}))

vi.mock('@zxing/library', () => {
  class MultiFormatReader {
    constructor() {
      if (mocks.failReaderBuild) throw new Error('bundle unavailable offline')
    }
    setHints(h) { mocks.lastHints = h }
    decode(bitmap) { return mocks.decodeImpl(bitmap) }
  }
  class RGBLuminanceSource {
    constructor(bytes, w, h) { this.bytes = bytes; this.w = w; this.h = h }
  }
  class BinaryBitmap { constructor(b) { this.b = b } }
  class HybridBinarizer { constructor(s) { this.s = s } }
  return {
    MultiFormatReader,
    RGBLuminanceSource,
    BinaryBitmap,
    HybridBinarizer,
    DecodeHintType: { TRY_HARDER: 't', POSSIBLE_FORMATS: 'f' },
    BarcodeFormat: {
      CODE_39: 1, CODE_128: 2, CODABAR: 3, CODE_93: 4, EAN_13: 5, EAN_8: 6,
      ITF: 7, UPC_A: 8, UPC_E: 9, DATA_MATRIX: 10, PDF_417: 11, QR_CODE: 12,
    },
  }
})

const { createEnginePool } = await import('./enginePool')

const SURFACE = {
  canvas: {},
  read: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
}

function mockNativeDetector() {
  // One stable class: per-test behaviour switches via the hoisted impl, since
  // reassigning window.BarcodeDetector cannot touch an already-built detector.
  window.BarcodeDetector = class {
    static getSupportedFormats = () => Promise.resolve(['code_39', 'code_128'])
    constructor(opts) { mocks.nativeFormats = opts.formats }
    detect = (...args) => mocks.nativeDetectImpl(...args)
  }
}

const zxingResult = (text = 'FB5971GA0001', pts = [[300, 200], [420, 200]]) => ({
  getText: () => text,
  getResultPoints: () => pts.map(([x, y]) => ({ getX: () => x, getY: () => y })),
})

const notFound = () => { const e = new Error('no barcode here'); e.name = 'NotFoundException'; throw e }

beforeEach(() => {
  delete window.BarcodeDetector
  mocks.decodeImpl = () => zxingResult()
  mocks.failReaderBuild = false
  mocks.nativeDetectImpl = () => Promise.resolve([])
  mocks.lastHints = null
  mocks.nativeFormats = undefined
  // jsdom has no 2d context: stub getContext so hardPass's inverted-Native
  // probe returns null silently instead of logging "Not implemented".
  if (typeof window !== 'undefined' && window.HTMLCanvasElement) {
    window.HTMLCanvasElement.prototype.getContext = () => null
  }
})

describe('enginePool fallback coherence (L-14)', () => {
  it('holds position when no engine is ready — no 0→1→0 flap per frame', async () => {
    const pool = createEnginePool(false)
    const first = await pool.detect(null)
    const second = await pool.detect(null)
    expect(first.engine).toBe('Native')
    expect(second.engine).toBe('Native')
    expect(pool.getActiveId()).toBe('Native')
  })

  it('loads the ZXing fallback in the background when native wins init', async () => {
    mockNativeDetector()
    const pool = createEnginePool(false)
    await pool.init()
    expect(pool.getActiveId()).toBe('Native')
    // The documented contract: init picks, armFallback loads the other one.
    await pool.armFallback()
    // Three native strikes must land somewhere real and STAY there.
    mocks.nativeDetectImpl = () => Promise.reject(new Error('camera busy'))
    await pool.detect(SURFACE)
    await pool.detect(SURFACE)
    await pool.detect(SURFACE)
    expect(pool.getActiveId()).toBe('ZXing')
    const again = await pool.detect(SURFACE)
    expect(pool.getActiveId()).toBe('ZXing')
    expect(again.engine).toBe('ZXing')
    expect(again.barcodes).toHaveLength(1)
  })

  it('holds the last ready engine when every engine has failed', async () => {
    // ZXing-only pool (no BarcodeDetector): three hard decode errors must NOT
    // bounce back to the Native engine that was never loaded.
    const pool = createEnginePool(false)
    await pool.init()
    expect(pool.getActiveId()).toBe('ZXing')
    mocks.decodeImpl = () => { throw new Error('bitmap broken') }
    await pool.detect(SURFACE)
    await pool.detect(SURFACE)
    await pool.detect(SURFACE)
    expect(pool.getActiveId()).toBe('ZXing')
  })

  it('reports not-ready when neither engine loads', async () => {
    // No BarcodeDetector and a ZXing bundle that cannot load: the loop must
    // keep waiting (isReady false), not flap between dead engines.
    mocks.failReaderBuild = true
    const pool = createEnginePool(false)
    await pool.init()
    expect(pool.isReady()).toBe(false)
    await pool.detect(null)
    expect(pool.getActiveId()).toBe('Native')
  })
})

describe('enginePool result shaping (L-15)', () => {
  it('maps ZXing result points to cornerPoints so the edge guard can judge them', async () => {
    const pool = createEnginePool(false)
    await pool.init()
    expect(pool.getActiveId()).toBe('ZXing')
    const { barcodes } = await pool.detect(SURFACE)
    expect(barcodes).toHaveLength(1)
    expect(barcodes[0].rawValue).toBe('FB5971GA0001')
    expect(barcodes[0].cornerPoints).toEqual([{ x: 300, y: 200 }, { x: 420, y: 200 }])
  })

  it('passes native results through untouched', async () => {
    const quad = [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }, { x: 7, y: 8 }]
    mockNativeDetector()
    mocks.nativeDetectImpl = () => Promise.resolve([{ rawValue: 'BH1234AB5678', cornerPoints: quad }])
    const pool = createEnginePool(false)
    await pool.init()
    const { barcodes } = await pool.detect(SURFACE)
    expect(barcodes).toEqual([{ rawValue: 'BH1234AB5678', cornerPoints: quad }])
  })

  it('does not count empty-frame misses as engine failures', async () => {
    const pool = createEnginePool(false)
    await pool.init()
    mocks.decodeImpl = notFound
    for (let i = 0; i < 5; i++) {
      const { barcodes } = await pool.detect(SURFACE)
      expect(barcodes).toHaveLength(0)
    }
    expect(pool.getActiveId()).toBe('ZXing')
  })
})

describe('enginePool empty-result handoff', () => {
  it('hands off to the other ready engine after the threshold — and does not oscillate', async () => {
    mockNativeDetector()
    const pool = createEnginePool(false, { emptyHandoffAfter: 2 })
    await pool.init()
    await pool.armFallback()           // both engines ready
    expect(pool.getActiveId()).toBe('Native')
    // Both engines return clean empties.
    mocks.nativeDetectImpl = () => Promise.resolve([])
    mocks.decodeImpl = notFound

    await pool.detect(SURFACE)          // Native empty #1
    expect(pool.getActiveId()).toBe('Native')
    await pool.detect(SURFACE)          // Native empty #2 → handoff to ZXing
    expect(pool.getActiveId()).toBe('ZXing')
    // The next frame must NOT bounce straight back: the new engine's counter
    // starts at 0, so it needs a full threshold of empties before handing back.
    await pool.detect(SURFACE)          // ZXing empty #1
    expect(pool.getActiveId()).toBe('ZXing')
  })

  it('does not hand off when the other engine is not ready', async () => {
    mockNativeDetector()
    const pool = createEnginePool(false, { emptyHandoffAfter: 2 })
    await pool.init()
    // No armFallback — ZXing stays not-ready.
    mocks.nativeDetectImpl = () => Promise.resolve([])
    await pool.detect(SURFACE)          // empty #1
    await pool.detect(SURFACE)          // empty #2 → would hand off, but ZXing not ready
    expect(pool.getActiveId()).toBe('Native')
    await pool.detect(SURFACE)          // still Native; the failed handoff reset the counter
    expect(pool.getActiveId()).toBe('Native')
  })

  it('resets the empty counter on a successful decode', async () => {
    mockNativeDetector()
    const pool = createEnginePool(false, { emptyHandoffAfter: 2 })
    await pool.init()
    await pool.armFallback()
    mocks.nativeDetectImpl = () => Promise.resolve([])
    mocks.decodeImpl = notFound
    await pool.detect(SURFACE)          // Native empty #1
    // A success resets the counter, so the next empty starts from 0.
    mocks.nativeDetectImpl = () => Promise.resolve([{ rawValue: 'OK1', cornerPoints: [] }])
    await pool.detect(SURFACE)          // success → counter reset
    mocks.nativeDetectImpl = () => Promise.resolve([])
    await pool.detect(SURFACE)          // empty #1 again (not #2)
    expect(pool.getActiveId()).toBe('Native')
  })
})

describe('enginePool tier-driven formats', () => {
  it('defaults to BASE_1D + EXTENDED_1D when no formats are given', async () => {
    const pool = createEnginePool(false)
    await pool.init()                   // ZXing-only (no BarcodeDetector)
    const fmts = mocks.lastHints.get('f')
    // BASE_1D: code_39, code_128, code_93, codabar, ean_13, ean_8
    // EXTENDED_1D: itf, upc_a, upc_e
    expect(fmts).toEqual([1, 2, 4, 3, 5, 6, 7, 8, 9])
  })

  it('maps itf/upc_a to ZXing formats and skips unknown strings', async () => {
    const pool = createEnginePool(false, { formats: ['itf', 'upc_a', 'not_a_real_format'] })
    await pool.init()
    const fmts = mocks.lastHints.get('f')
    expect(fmts).toEqual([7, 8])       // ITF, UPC_A — unknown skipped, not thrown
  })

  it('filters Native formats to what getSupportedFormats reports', async () => {
    mockNativeDetector()               // supports only code_39, code_128
    const pool = createEnginePool(false, { formats: ['code_39', 'itf', 'upc_a'] })
    await pool.init()
    expect(pool.getActiveId()).toBe('Native')
    expect(mocks.nativeFormats).toEqual(['code_39'])
  })
})

describe('enginePool hardPass', () => {
  it('merges and dedupes results across engines, reporting the first hit', async () => {
    mockNativeDetector()
    const pool = createEnginePool(false)
    await pool.init()
    await pool.armFallback()
    // Both engines find the same badge → deduped to one.
    mocks.nativeDetectImpl = () => Promise.resolve([{ rawValue: 'DUP123', cornerPoints: [{ x: 1, y: 1 }] }])
    mocks.decodeImpl = () => zxingResult('DUP123')
    const { barcodes, engine } = await pool.hardPass(SURFACE)
    expect(barcodes).toHaveLength(1)
    expect(barcodes[0].rawValue).toBe('DUP123')
    expect(engine).toBe('Native')       // first engine to produce a hit
  })

  it('returns an empty array (not a throw) when no engine is ready', async () => {
    const pool = createEnginePool(false)   // no init — nothing ready
    const { barcodes, engine } = await pool.hardPass(SURFACE)
    expect(barcodes).toEqual([])
    expect(engine).toBe('Native')          // getActiveId() default
  })

  it('detects an inverted (white-on-black) barcode a normal pass misses', async () => {
    // Synthetic 1D barcode: 2px black / 2px white vertical stripes.
    const w = 24, h = 8
    const data = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        const v = (x % 4 < 2) ? 0 : 255
        data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255
      }
    }
    const surface = { canvas: {}, read: () => ({ data, width: w, height: h }) }

    // ZXing-only pool. The mock decode inspects the luminance bytes: a normal
    // black-on-white frame misses; the inverted white-on-black frame hits.
    const pool = createEnginePool(false)
    await pool.init()
    mocks.decodeImpl = (bitmap) => {
      const bytes = bitmap?.b?.s?.bytes
      if (bytes && bytes[0] > 128) return zxingResult('INV456')
      notFound()
    }
    const { barcodes, engine } = await pool.hardPass(surface)
    expect(barcodes).toHaveLength(1)
    expect(barcodes[0].rawValue).toBe('INV456')
    expect(engine).toBe('ZXing')
  })

  it('detects a sideways (rotated 90°) barcode a normal pass misses', async () => {
    // Synthetic 1D barcode held sideways: 2px black / 2px white HORIZONTAL
    // stripes — the bars run along y, so no horizontal scanline ever crosses
    // a bar transition and ZXing's 1D readers can never see it. Rotating the
    // frame 90° turns the stripes vertical and the same pixels decode.
    const w = 24, h = 8
    const data = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        const v = (y % 4 < 2) ? 0 : 255
        data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255
      }
    }
    const surface = { canvas: {}, read: () => ({ data, width: w, height: h }) }

    // ZXing-only pool. The mock decode inspects the frame dimensions: the
    // sideways frame is landscape (24x8); after the hard pass rotates it 90°
    // the same bytes arrive portrait (8x24) — that is the rotated variant.
    const pool = createEnginePool(false)
    await pool.init()
    mocks.decodeImpl = (bitmap) => {
      const src = bitmap?.b?.s
      if (src && src.w === 8 && src.h === 24) return zxingResult('ROT789')
      notFound()
    }
    const { barcodes, engine } = await pool.hardPass(surface)
    expect(barcodes).toHaveLength(1)
    expect(barcodes[0].rawValue).toBe('ROT789')
    expect(engine).toBe('ZXing')
  })

  it('swallows an engine failure and still returns the other engine hits', async () => {
    mockNativeDetector()
    const pool = createEnginePool(false)
    await pool.init()
    await pool.armFallback()
    // Native throws; ZXing still answers.
    mocks.nativeDetectImpl = () => Promise.reject(new Error('camera busy'))
    mocks.decodeImpl = () => zxingResult('ZX789')
    const { barcodes, engine } = await pool.hardPass(SURFACE)
    expect(barcodes).toHaveLength(1)
    expect(barcodes[0].rawValue).toBe('ZX789')
    expect(engine).toBe('ZXing')
  })
})
