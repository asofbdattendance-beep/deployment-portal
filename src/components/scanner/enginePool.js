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
 *
 * Three robustness behaviours on top of the raw engines:
 *  - Tier-driven formats: the caller passes the format list for its device
 *    tier (see deviceCapabilities.js); Native is still filtered by
 *    getSupportedFormats() so we never ask it for a symbology it lacks.
 *    On the ZXing leg the SAME list is enforced through DecodeHintType —
 *    MultiFormatReader.decode(bitmap, hints) only rebuilds its readers when
 *    the hint Map reference differs, so we hand it a STABLE Map per pass
 *    (base for normal frames, widened for the hard path) instead of the old
 *    bare decode(bitmap), which passed `undefined` and wiped POSSIBLE_FORMATS
 *    and TRY_HARDER on the very first frame (decoding every symbology the
 *    library ships while Native stayed tier-filtered).
 *  - Empty-result handoff: an engine that reliably finds NOTHING (tilted /
 *    low-res badges make Native return [] without throwing) no longer pins
 *    the pool forever — after a run of clean misses it hands off to the
 *    other ready engine exactly once, mirroring fallback()'s anti-flapping.
 *  - hardPass(surface): the "hard path" second look — every ready engine,
 *    normal then inverted luminance, merged + deduped, never throws.
 */
import { rgbaToGray } from '../../lib/scannerUtils'
import { BASE_1D_FORMATS, EXTENDED_1D_FORMATS, HARD_PATH_2D_FORMATS } from '../../lib/deviceCapabilities'

/**
 * Map our format strings to zx.BarcodeFormat enum members.
 *
 * The naming is 1:1 ('code_39' → CODE_39, 'itf' → ITF, 'upc_a' → UPC_A),
 * so an uppercase lookup is the whole mapping. An unknown string maps to
 * undefined and is SKIPPED, never thrown — a typo in a tier config must not
 * take down the whole pool, it just narrows the symbology set.
 *
 * @param {object} zx — the imported @zxing/library module
 * @param {string[]} formats
 * @returns {Array<number>} zx.BarcodeFormat members
 */
const toZxingFormats = (zx, formats) => {
  const out = []
  for (const f of formats) {
    const fmt = zx?.BarcodeFormat?.[String(f || '').toUpperCase()]
    if (fmt !== undefined && fmt !== null) out.push(fmt)
  }
  return out
}

/**
 * Do two ZXing format arrays cover the same symbologies (order-insensitive)?
 *
 * Used to decide whether the hard path needs its OWN hint Map. When the two
 * lists agree we reuse the base Map object on purpose: MultiFormatReader only
 * calls setHints when the reference changes, so reusing it means switching
 * between the normal and hard pass rebuilds the reader set ZERO times.
 *
 * @param {Array<number>} a
 * @param {Array<number>} b
 * @returns {boolean}
 */
const sameFormats = (a, b) => {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every(f => set.has(f))
}

/**
 * Invert luminance (255 − v per pixel) for the hard path.
 *
 * A white-on-black badge is invisible to a binarizer tuned for black-on-white;
 * inversion is the cheap second look that needs no rotation or deskew (the
 * caller owns rotation). Alpha is preserved — inverting it would make the
 * frame fully transparent and the binarizer would see nothing at all.
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} imageData
 * @returns {{data: Uint8ClampedArray, width: number, height: number}}
 */
const invertImageData = (imageData) => {
  const { data, width, height } = imageData || {}
  if (!data || !width || !height) return imageData
  const out = new Uint8ClampedArray(data.length)
  for (let i = 0; i < data.length; i += 4) {
    out[i] = 255 - data[i]
    out[i + 1] = 255 - data[i + 1]
    out[i + 2] = 255 - data[i + 2]
    out[i + 3] = data[i + 3]
  }
  return { data: out, width, height }
}

/**
 * Best-effort canvas for the inverted Native variant.
 *
 * jsdom has no 2d context, so a test surface yields null and the caller skips
 * the inverted native pass rather than throwing. Production always has one.
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} imageData
 * @returns {HTMLCanvasElement|null}
 */
const invertCanvas = (imageData) => {
  try {
    const inv = invertImageData(imageData)
    const c = document.createElement('canvas')
    c.width = inv.width
    c.height = inv.height
    const ctx = c.getContext && c.getContext('2d')
    if (!ctx || typeof ctx.putImageData !== 'function') return null
    ctx.putImageData(inv, 0, 0)
    return c
  } catch { return null }
}

/**
 * Create the detector-engine pool.
 *
 * @param {boolean} debug — log engine transitions to the console.
 * @param {object} [opts]
   * @param {string[]} [opts.formats] — format strings to enable. Defaults to
   *   BASE_1D_FORMATS + EXTENDED_1D_FORMATS (every 1D symbology we support).
   *   Unknown strings are skipped, not thrown.
   * @param {string[]} [opts.hardPathFormats] — symbologies the hard path may
   *   attempt IN ADDITION to the base list (2D lives here: see
   *   HARD_PATH_2D_FORMATS). Defaults to base + HARD_PATH_2D_FORMATS so the
   *   second look never loses a capability the old all-symbologies reader had,
   *   while every normal frame stays 1D-only. Pass a tier's own list to narrow
   *   it.
 * @param {number} [opts.emptyHandoffAfter=8] — consecutive clean misses from
 *   the active engine before it hands off to the other ready engine.
 * @returns {{init: Function, armFallback: Function, detect: Function,
 *   getActiveId: Function, isReady: Function, fallback: Function,
 *   hardPass: Function}}
 */
export function createEnginePool(debug, opts = {}) {
  // Tier-driven formats: the caller passes its device tier's list; the
  // default is every 1D symbology we support (BASE + EXTENDED). Deduped so
  // a repeated entry can't reach the decoder twice.
  const formats = [...new Set(
    Array.isArray(opts.formats) && opts.formats.length
      ? opts.formats
      : [...BASE_1D_FORMATS, ...EXTENDED_1D_FORMATS]
  )]
  // Consecutive clean misses before the active engine hands off to the other
  // ready one. 8 is long enough that a genuinely hard badge (a few blank
  // frames) doesn't trigger it, short enough that a dead-native situation
  // recovers within a second or two of scanning.
  const emptyHandoffAfter = Number.isFinite(opts.emptyHandoffAfter) && opts.emptyHandoffAfter > 0
    ? Math.floor(opts.emptyHandoffAfter)
    : 8

  const engines = [
    { id: 'Native', ready: false, detector: null, failures: 0, maxFailures: 3, emptyCount: 0 },
    { id: 'ZXing', ready: false, detector: null, failures: 0, maxFailures: 3, emptyCount: 0 },
  ]
  let activeIndex = 0
  let zxingReader = null

  const getActive = () => engines[activeIndex]

  /**
   * Run one engine on one input and normalize the result.
   *
   * ZXing returns 2 corner points, Native returns 4 — both are forwarded as-is
   * (the frame-edge guard centroids however many it gets). ZXing's
   * NotFound/Format/Checksum exceptions propagate so the caller can classify
   * them as a normal empty frame rather than an engine failure.
   *
   * @param {{id: string, ready: boolean, detector: any}} engine
   * @param {{imageData?: any, canvas?: any, zxHints?: Map}} input — ZXing takes
   *   imageData (+ an optional hint Map for the hard path), Native takes a canvas.
   * @returns {Array<{rawValue: string, cornerPoints: Array}>}
   */
  const runEngine = (engine, { imageData, canvas, zxHints }) => {
    if (engine.id === 'ZXing') {
      if (!zxingReader) throw new Error('ZXing reader not loaded')
      const result = zxingReader.decode(imageData, zxHints)
      const pts = result.getResultPoints?.() || []
      return [{
        rawValue: result.getText(),
        cornerPoints: pts.map(p => ({ x: p.getX?.() ?? p.x, y: p.getY?.() ?? p.y })),
      }]
    }
    return engine.detector.detect(canvas)
  }

  const initNative = async () => {
    if (!('BarcodeDetector' in window)) return false
    try {
      const fmts = await window.BarcodeDetector.getSupportedFormats()
      // Never ask native for a format it doesn't support — filter the tier
      // list down to what this build can actually decode.
      const usable = formats.filter(f => fmts.includes(f))
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
      const zxFormats = toZxingFormats(zx, formats)
      if (!zxFormats.length) return false

      // Two STABLE hint Maps, built once and reused forever.
      //
      // MultiFormatReader.decode is `if (this.hints !== hints) setHints(hints)`
      // — so passing a Map reference we keep, rather than calling setHints()
      // ourselves and then decode(bitmap) (which passes `undefined` and would
      // rebuild the readers against a DEFAULT configuration every frame), means
      // setHints fires only when we deliberately switch between base and hard.
      const makeHints = (fmts) => {
        const h = new Map()
        h.set(zx.DecodeHintType.TRY_HARDER, true)
        h.set(zx.DecodeHintType.POSSIBLE_FORMATS, fmts)
        return h
      }
      const baseHints = makeHints(zxFormats)

      const hardList = Array.isArray(opts.hardPathFormats) && opts.hardPathFormats.length
        ? [...new Set(opts.hardPathFormats)]
        : [...new Set([...formats, ...HARD_PATH_2D_FORMATS])]
      const hardZx = toZxingFormats(zx, hardList)
      // Empty or identical hard set → reuse baseHints. Reusing the SAME object
      // is what keeps a base↔hard switch from paying a reader rebuild.
      const hardHints = !hardZx.length || sameFormats(zxFormats, hardZx)
        ? baseHints
        : makeHints(hardZx)

      const reader = new zx.MultiFormatReader()
      reader.setHints(baseHints)
      zxingReader = {
        reader,
        ZX: zx,
        baseHints,
        hardHints,
        /**
         * @param {{data: Uint8ClampedArray, width: number, height: number}} imageData
         * @param {Map} [hints] — defaults to the base (tier) set; the hard path
         *   passes hardHints. Never undefined: a bare decode(bitmap) is exactly
         *   the bug this replaced.
         */
        decode: (imageData, hints = baseHints) => {
          // MUST be 1 byte/px — see rgbaToGray for why raw RGBA silently
          // produces a frame the binarizer can never read.
          const gray = rgbaToGray(imageData)
          const lum = new zx.RGBLuminanceSource(gray, imageData.width, imageData.height)
          return reader.decode(new zx.BinaryBitmap(new zx.HybridBinarizer(lum)), hints)
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
   * Hand off to the other ready engine after a run of clean misses.
   *
   * Mirrors fallback()'s anti-flapping: never step onto an unready engine,
   * and if the current engine is the only ready one, reset and hold. EVERY
   * engine's empty counter is reset on a switch — leaving the old engine's
   * count at the threshold would hand straight back on its next empty frame,
   * ping-ponging the label every `threshold` frames.
   */
  const handoffEmpty = () => {
    const prev = getActive().id
    for (let step = 1; step <= engines.length; step++) {
      const i = (activeIndex + step) % engines.length
      if (!engines[i].ready) continue
      if (i === activeIndex) {
        // Wrapped all the way around: the current engine is the only ready
        // one — reset and hold. Stepping onto itself would flap the label.
        engines.forEach(e => { e.emptyCount = 0 })
        if (debug) console.log('[Engine] Empty-handoff: no other ready engine — holding')
      } else {
        activeIndex = i
        engines.forEach(e => { e.emptyCount = 0 })
        if (debug) console.log(`[Engine] Empty-handoff: ${prev} → ${getActive().id}`)
      }
      return
    }
    // No ready engine at all: hold position, reset counters, keep waiting.
    engines.forEach(e => { e.emptyCount = 0 })
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
      let barcodes
      if (engine.id === 'ZXing') {
        if (!zxingReader) { fallback(); return { barcodes: [], engine: engine.id } }
        const imageData = surface.read()
        if (!imageData) { engine.failures = 0; return { barcodes: [], engine: engine.id } }
        try {
          barcodes = runEngine(engine, { imageData })
          engine.failures = 0
        } catch (e) {
          // An empty frame is the normal case, not an engine failure — counting
          // it would make the pool thrash and flap the engine label.
          if (e?.name === 'NotFoundException' || e?.name === 'FormatException' || e?.name === 'ChecksumException') {
            engine.failures = 0
            barcodes = []
          } else {
            throw e
          }
        }
      } else {
        barcodes = await runEngine(engine, { canvas: source })
        engine.failures = 0
      }
      barcodes = barcodes || []
      // Empty-result handoff: a clean miss is not a failure, but a run of them
      // means the active engine can't read THIS badge. Hand off once — the
      // new engine's counter starts at 0, so it can't bounce straight back.
      if (barcodes.length === 0) {
        engine.emptyCount = (engine.emptyCount || 0) + 1
        if (engine.emptyCount >= emptyHandoffAfter) handoffEmpty()
      } else {
        engine.emptyCount = 0
      }
      return { barcodes, engine: engine.id }
    } catch (e) {
      engine.failures++
      if (debug) console.warn(`[Engine] ${engine.id} detect error (${engine.failures}/${engine.maxFailures}):`, e?.message)
      if (engine.failures >= engine.maxFailures) fallback()
      return { barcodes: [], engine: engine.id }
    }
  }

  /**
   * The "hard path" second look, used only when a normal pass missed.
   *
   * Runs EVERY ready engine (not just the active one), each on the normal
   * orientation and then the inverted luminance, and merges the hits deduped
   * by rawValue. Never throws: one engine's failure must not cost the other
   * its chance, and an empty frame is just a miss. Returns the id of the
   * first engine that produced a hit (getActiveId() when nothing did).
   *
   * @param {{canvas: HTMLCanvasElement, read: () => ImageData|null}} surface
   * @returns {Promise<{barcodes: Array, engine: string}>}
   */
  const hardPass = async (surface) => {
    const source = surface?.canvas || null
    if (!source) return { barcodes: [], engine: getActiveId() }
    const imageData = surface.read?.()
    if (!imageData) return { barcodes: [], engine: getActiveId() }

    const inverted = invertImageData(imageData)
    const seen = new Set()
    const merged = []
    let hitEngine = null

    for (const engine of engines) {
      if (!engine.ready) continue
      const variants = []
      if (engine.id === 'ZXing') {
        // Widened symbologies (2D etc.) — this is the ONLY pass that gets
        // them, so the normal frame budget is never taxed for formats this
        // product doesn't scan. hardHints === baseHints when the tier didn't
        // widen, in which case no reader rebuild happens at all.
        variants.push(
          { imageData, zxHints: zxingReader?.hardHints },
          { imageData: inverted, zxHints: zxingReader?.hardHints },
        )
      } else {
        variants.push({ canvas: source })
        const invCanvas = invertCanvas(imageData)
        if (invCanvas) variants.push({ canvas: invCanvas })
      }
      for (const v of variants) {
        try {
          const barcodes = await runEngine(engine, v)
          for (const b of barcodes || []) {
            if (!b || seen.has(b.rawValue)) continue
            seen.add(b.rawValue)
            merged.push(b)
            if (!hitEngine) hitEngine = engine.id
          }
        } catch (e) {
          // hardPass never throws: one engine's failure must not cost the
          // other its chance, and an empty frame is just a miss.
          if (debug) console.warn(`[Engine] hardPass ${engine.id} failed:`, e?.message)
        }
      }
    }

    return { barcodes: merged, engine: hitEngine || getActiveId() }
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
        engines.forEach(e => { e.failures = 0; e.emptyCount = 0 })
        if (debug) console.log('[Engine] All engines failed — counters reset')
      } else {
        activeIndex = i
        engines[i].failures = 0
        engines[i].emptyCount = 0
        if (debug) console.log(`[Engine] Fallback: ${prev} → ${getActive().id}`)
      }
      return
    }
    // No ready engine at all: hold position, reset counters, keep waiting.
    engines.forEach(e => { e.failures = 0; e.emptyCount = 0 })
  }

  const getActiveId = () => getActive().id
  const isReady = () => engines.some(e => e.ready)

  return { init, armFallback, detect, getActiveId, isReady, fallback, hardPass }
}
