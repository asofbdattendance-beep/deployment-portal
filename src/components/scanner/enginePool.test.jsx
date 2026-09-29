// @vitest-environment jsdom
/**
 * enginePool — fallback coherence + ZXing result shaping.
 *
 * L-14: the pool used to flap 0→1→0 across frames when the fallback target
 * was never loaded (native-only init leaves ZXing `ready:false`), flapping
 * the engine label and burning frames on an engine that can never answer.
 * L-15: the ZXing path hardcoded `cornerPoints: []`, so the frame-edge guard
 * (which needs >= 2 points) silently differed by engine/browser.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ decodeImpl: null, failReaderBuild: false, nativeDetectImpl: () => Promise.resolve([]) }))

vi.mock('@zxing/library', () => {
  class MultiFormatReader {
    constructor() {
      if (mocks.failReaderBuild) throw new Error('bundle unavailable offline')
    }
    setHints() {}
    decode() { return mocks.decodeImpl() }
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
    BarcodeFormat: { CODE_39: 1, CODE_128: 2, CODABAR: 3, CODE_93: 4, EAN_13: 5, EAN_8: 6 },
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
    detect = (...args) => mocks.nativeDetectImpl(...args)
  }
}

const zxingResult = (text = 'FB5971GA0001', pts = [[300, 200], [420, 200]]) => ({
  getText: () => text,
  getResultPoints: () => pts.map(([x, y]) => ({ getX: () => x, getY: () => y })),
})

beforeEach(() => {
  delete window.BarcodeDetector
  mocks.decodeImpl = () => zxingResult()
  mocks.failReaderBuild = false
  mocks.nativeDetectImpl = () => Promise.resolve([])
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
    mocks.decodeImpl = () => { const e = new Error('no barcode here'); e.name = 'NotFoundException'; throw e }
    for (let i = 0; i < 5; i++) {
      const { barcodes } = await pool.detect(SURFACE)
      expect(barcodes).toHaveLength(0)
    }
    expect(pool.getActiveId()).toBe('ZXing')
  })
})
