/**
 * enginePool.js - detector-engine pool for the barcode scanner.
 *
 * Pure factory, no React: Native BarcodeDetector (Chrome / Edge / Android)
 * first, @zxing/library (universal, fully offline) as the armed fallback.
 *
 * The undecaf WASM polyfill was removed on purpose: its module does an
 * absolute CDN import of zbar-wasm, so behind a bundler it can never
 * resolve, and even if it did it would need the network - fatal for a
 * scanner that must work in a hall with no signal. ZXing is pure JS,
 * offline, and covers the same formats.
 */
import { rgbaToGray } from '../../lib/scannerUtils'

const FORMATS = ['code_39', 'code_128', 'codabar', 'code_93', 'ean_13', 'ean_8']

export function createEnginePool(debug) {
  const engines = [
    { id: 'Native', ready: false, detector: null, failures: 0, maxFailures: 3 },
    { id: 'ZXing', ready: false, detector: null, failures: 0, maxFailures: 3 },
  ]
  let activeIndex = 0
  let zxingReader = null

  const getActive = () => engines[activeIndex]

  const initNative = async () => {
    if (!('BarcodeDetector' in window)) return false
    try {
      const fmts = await window.BarcodeDetector.getSupportedFormats()
      const usable = FORMATS.filter(f => fmts.includes(f))
      if (!usable.length) return false
      engines[0].detector = new window.BarcodeDetector({ formats: usable })
      engines[0].ready = true
      if (debug) console.log('[Engine] Native BarcodeDetector ready:', usable.join(','))
      return true
    } catch { return false }
  }

  const initZXing = async () => {
    try {
      // Drive the core reader directly on our cropped canvas. The higher-level
      // BrowserMultiFormatReader assumes a video/img element (it reads
      // naturalWidth/videoWidth and replays a capture pipeline), which is wrong
      // for a canvas ROI and is much heavier per frame. MultiFormatReader +
      // HybridBinarizer over the ROI's ImageData is the fast path we want.
      const zx = await import('@zxing/library')
      const hints = new Map()
      hints.set(zx.DecodeHintType.TRY_HARDER, true)
      hints.set(zx.DecodeHintType.POSSIBLE_FORMATS, [
        zx.BarcodeFormat.CODE_39,
        zx.BarcodeFormat.CODE_128,
        zx.BarcodeFormat.CODABAR,
        zx.BarcodeFormat.CODE_93,
        zx.BarcodeFormat.EAN_13,
        zx.BarcodeFormat.EAN_8,
      ])
      const reader = new zx.MultiFormatReader()
      reader.setHints(hints)
      zxingReader = {
        reader,
        ZX: zx,
        decode: (imageData) => {
          // MUST be 1 byte/px — see rgbaToGray for why raw RGBA silently
          // produces a frame the binarizer can never read.
          const gray = rgbaToGray(imageData)
          const lum = new zx.RGBLuminanceSource(gray, imageData.width, imageData.height)
          return reader.decode(new zx.BinaryBitmap(new zx.HybridBinarizer(lum)))
        },
      }
      engines[1].ready = true
      if (debug) console.log('[Engine] ZXing ready')
      return true
    } catch (e) {
      if (debug) console.warn('[Engine] ZXing load failed:', e?.message)
      return false
    }
  }

  const init = async () => {
    if (await initNative()) { activeIndex = 0; return }
    if (await initZXing()) { activeIndex = 1; return }
  }

  /**
   * Load the engine the pool did NOT pick, in the background.
   *
   * L-14: init() used to leave the fallback target unloaded (a native win
   * meant ZXing stayed `ready:false` forever), so the first real fallback
   * landed on an engine that could never answer and the NEXT frame bounced
   * straight back — flapping the engine label 0→1→0 while burning frames.
   * Returns the loader promise so tests can await a deterministic state;
   * production callers fire-and-forget (the loader never rejects).
   */
  const armFallback = () => {
    if (activeIndex === 0 && !engines[1].ready) return initZXing()
    if (activeIndex === 1 && !engines[0].ready) return initNative()
    return Promise.resolve(false)
  }

  /**
   * @param {{canvas: HTMLCanvasElement, read: () => ImageData|null}} surface
   *   the cropped detection surface.
   */
  const detect = async (surface) => {
    const engine = getActive()
    if (!engine.ready) { fallback(); return { barcodes: [], engine: engine.id } }
    const source = surface?.canvas || null
    if (!source) { engine.failures = 0; return { barcodes: [], engine: engine.id } }

    try {
      if (engine.id === 'ZXing') {
        if (!zxingReader) { fallback(); return { barcodes: [], engine: engine.id } }
        const imageData = surface.read()
        if (!imageData) { engine.failures = 0; return { barcodes: [], engine: engine.id } }
        try {
          const result = zxingReader.decode(imageData)
          engine.failures = 0
          // L-15: forward the result points so the frame-edge guard can judge
          // ZXing reads exactly like native ones. A 1D barcode yields 2
          // points; the guard centroids however many it gets (>= 2).
          const pts = result.getResultPoints?.() || []
          return {
            barcodes: [{
              rawValue: result.getText(),
              cornerPoints: pts.map(p => ({ x: p.getX?.() ?? p.x, y: p.getY?.() ?? p.y })),
            }],
            engine: engine.id,
          }
        } catch (e) {
          // An empty frame is the normal case, not an engine failure — counting
          // it would make the pool thrash and flap the engine label.
          if (e?.name === 'NotFoundException' || e?.name === 'FormatException' || e?.name === 'ChecksumException') {
            engine.failures = 0
            return { barcodes: [], engine: engine.id }
          }
          throw e
        }
      }
      const barcodes = await engine.detector.detect(source)
      engine.failures = 0
      return { barcodes: barcodes || [], engine: engine.id }
    } catch (e) {
      engine.failures++
      if (debug) console.warn(`[Engine] ${engine.id} detect error (${engine.failures}/${engine.maxFailures}):`, e?.message)
      if (engine.failures >= engine.maxFailures) fallback()
      return { barcodes: [], engine: engine.id }
    }
  }

  const fallback = () => {
    const prev = getActive().id
    // Land ONLY on a ready engine. The old code stepped blindly to the next
    // slot, so a fallback onto the never-loaded engine bounced straight back
    // on the next frame (L-14). Holding position keeps the label stable and
    // the loop waiting while the background arm finishes loading.
    for (let step = 1; step <= engines.length; step++) {
      const i = (activeIndex + step) % engines.length
      if (!engines[i].ready) continue
      if (i === activeIndex) {
        // Wrapped all the way around: every ready engine failed — reset the
        // counters and keep going on the current one.
        engines.forEach(e => { e.failures = 0 })
        if (debug) console.log('[Engine] All engines failed — counters reset')
      } else {
        activeIndex = i
        engines[i].failures = 0
        if (debug) console.log(`[Engine] Fallback: ${prev} → ${getActive().id}`)
      }
      return
    }
    // No ready engine at all: hold position, reset counters, keep waiting.
    engines.forEach(e => { e.failures = 0 })
  }

  const getActiveId = () => getActive().id
  const isReady = () => engines.some(e => e.ready)

  return { init, armFallback, detect, getActiveId, isReady, fallback }
}
