/**
 * enginePool.js - detector-engine pool for the barcode scanner.
 *
 * Pure factory, no React. Engine order:
 *   1. Native BarcodeDetector (Chrome / Edge on Android, macOS, ChromeOS).
 *   2. ZXing-C++ via WebAssembly (zxingCppEngine.js) — every modern browser,
 *      offline, ~6x faster than the JS port and better on rotated badges.
 *   3. @zxing/library (pure JS) — last resort for a browser or WebView with
 *      no usable WebAssembly.
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
 *  - hardPass(surface): the "hard path" second look — every ready engine on
 *    the raw frame, an enhanced (sharpened + contrast-stretched) copy, the
 *    inverted luminance and rotations; stops at the first hit, never throws.
 */
import { rgbaToGray, rotateGray, SCAN_ROTATIONS, enhanceGray, grayToRgba } from '../../lib/scannerUtils'
import { BASE_1D_FORMATS, EXTENDED_1D_FORMATS, HARD_PATH_2D_FORMATS } from '../../lib/deviceCapabilities'
import { loadZxingCpp, toCppFormats } from './zxingCppEngine'

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

// ZXing's "nothing here" outcomes. They are normal empty frames, not failures.
const ZXING_MISS_KINDS = new Set(['NotFoundException', 'FormatException', 'ChecksumException'])

/**
 * Is this ZXing throw just an empty frame?
 *
 * `e.name` alone is NOT enough: ts-custom-error sets `name` from the class's
 * constructor name, and the production minifier renames that class (the
 * built bundle has `NotFoundException` as `e`). Matching on name worked in
 * tests and silently failed in production, so every empty frame counted as an
 * engine failure and the pool bounced engines every 3 frames. The library's
 * static `kind` string is a literal the minifier cannot touch, so check that
 * first (via getKind() or the constructor), and keep `name` for unminified
 * builds and hand-made test errors.
 *
 * @param {unknown} e
 * @returns {boolean}
 */
export function isZxingMiss(e) {
  if (!e || typeof e !== 'object') return false
  let kind
  try { kind = typeof e.getKind === 'function' ? e.getKind() : undefined } catch { kind = undefined }
  if (!kind) kind = e.constructor?.kind
  return ZXING_MISS_KINDS.has(kind) || ZXING_MISS_KINDS.has(e.name)
}

/** Thrown when a native call misses its deadline (see nativeTimeoutMs). */
class EngineTimeout extends Error {
  constructor(ms) { super(`native detector did not answer within ${ms} ms`); this.name = 'EngineTimeout' }
}

/** Resolve/reject with the promise, or reject with EngineTimeout after `ms`. */
function withDeadline(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new EngineTimeout(ms)), ms)
    Promise.resolve(promise).then(
      v => { clearTimeout(timer); resolve(v) },
      e => { clearTimeout(timer); reject(e) },
    )
  })
}

let _scratchInvCanvas = null
let _scratchEnhCanvas = null

/**
 * canvas.putImageData() only accepts a real ImageData in browsers; a plain
 * {data, width, height} throws ("parameter 1 is not of type 'ImageData'").
 * The old inverted-native path passed a plain object, the throw was
 * swallowed, and that variant silently never ran. Wrap when we can.
 */
const asImageData = (img) => {
  if (typeof ImageData !== 'function' || img instanceof ImageData) return img
  return new ImageData(img.data, img.width, img.height)
}

/** Draw `img` into a reusable scratch canvas; null when no 2D canvas exists. */
const paintScratch = (img, which) => {
  try {
    if (typeof document === 'undefined') return null
    let c = which === 'inv' ? _scratchInvCanvas : _scratchEnhCanvas
    if (!c) {
      c = document.createElement('canvas')
      if (which === 'inv') _scratchInvCanvas = c
      else _scratchEnhCanvas = c
    }
    if (c.width !== img.width) c.width = img.width
    if (c.height !== img.height) c.height = img.height
    const ctx = c.getContext && c.getContext('2d')
    if (!ctx || typeof ctx.putImageData !== 'function') return null
    ctx.putImageData(asImageData(img), 0, 0)
    return c
  } catch { return null }
}
let _scratchRotCanvas = null
let _scratchInvBuffer = null

/**
 * Invert luminance (255 − v per pixel) for the hard path.
 *
 * A white-on-black badge is invisible to a binarizer tuned for black-on-white;
 * inversion is the cheap second look that needs no rotation or deskew (the
 * caller owns rotation). Alpha is preserved — inverting it would make the
 * frame fully transparent and the binarizer would see nothing at all.
 * Reuses a single typed array buffer to eliminate GC pauses on mobile devices.
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} imageData
 * @returns {{data: Uint8ClampedArray, width: number, height: number}}
 */
const invertImageData = (imageData) => {
  const { data, width, height } = imageData || {}
  if (!data || !width || !height) return imageData
  if (!_scratchInvBuffer || _scratchInvBuffer.length !== data.length) {
    _scratchInvBuffer = new Uint8ClampedArray(data.length)
  }
  const out = _scratchInvBuffer
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
 * Reuses a scratch canvas to avoid 2D context churning and memory pressure.
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} imageData
 * @returns {HTMLCanvasElement|null}
 */
const invertCanvas = (imageData) => {
  const inv = invertImageData(imageData)
  return inv?.data ? paintScratch(inv, 'inv') : null
}

/**
 * Best-effort canvas rotation for Native BarcodeDetector in hardPass.
 * Reuses a scratch canvas to prevent memory and context churn.
 *
 * @param {HTMLCanvasElement} source
 * @param {number} deg
 * @returns {HTMLCanvasElement|null}
 */
const rotateCanvas = (source, deg) => {
  if (!source || !source.width || !source.height || typeof document === 'undefined') return null
  try {
    const swap = deg === 90 || deg === 270
    const targetW = swap ? source.height : source.width
    const targetH = swap ? source.width : source.height
    if (!_scratchRotCanvas) _scratchRotCanvas = document.createElement('canvas')
    if (_scratchRotCanvas.width !== targetW) _scratchRotCanvas.width = targetW
    if (_scratchRotCanvas.height !== targetH) _scratchRotCanvas.height = targetH
    const ctx = _scratchRotCanvas.getContext && _scratchRotCanvas.getContext('2d')
    if (!ctx || typeof ctx.drawImage !== 'function' || typeof ctx.rotate !== 'function') return null
    ctx.save()
    ctx.clearRect(0, 0, targetW, targetH)
    ctx.translate(targetW / 2, targetH / 2)
    ctx.rotate((deg * Math.PI) / 180)
    ctx.drawImage(source, -source.width / 2, -source.height / 2)
    ctx.restore()
    return _scratchRotCanvas
  } catch {
    return null
  }
}

/**
 * Transform a corner point from a rotated image back to original unrotated canvas coordinates.
 *
 * @param {{x:number, y:number}} p
 * @param {number} deg
 * @param {number} origW
 * @param {number} origH
 * @returns {{x:number, y:number}}
 */
export function unrotatePoint(p, deg, origW, origH) {
  if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || !deg || !origW || !origH) return p
  const px = p.x
  const py = p.y
  let x = px
  let y = py
  if (deg === 90) {
    x = py
    y = Math.max(0, origH - 1 - px)
  } else if (deg === 180) {
    x = Math.max(0, origW - 1 - px)
    y = Math.max(0, origH - 1 - py)
  } else if (deg === 270) {
    x = Math.max(0, origW - 1 - py)
    y = px
  }
  return { x, y }
}

export function unrotateCornerPoints(points, deg, origW, origH) {
  if (!Array.isArray(points) || !points.length || !deg) return points
  return points.map(pt => unrotatePoint(pt, deg, origW, origH))
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
 * @param {number} [opts.slowEngineMs=4000] — how long init() waits for the
 *   zxing-cpp WebAssembly download before scanning with ZXing-JS meanwhile.
 * @param {number} [opts.emptyHandoffAfter=6] — consecutive clean misses from
 *   the active engine before it hands off to the other ready engine.
 * @returns {{init: Function, armFallback: Function, retryUpgrade: Function, detect: Function,
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
  // ready one. 6 is long enough that a genuinely hard badge (a few blank
  // frames) doesn't trigger it, short enough that a dead-native situation
  // recovers rapidly within ~300ms of scanning.
  const emptyHandoffAfter = Number.isFinite(opts.emptyHandoffAfter) && opts.emptyHandoffAfter > 0
    ? Math.floor(opts.emptyHandoffAfter)
    : 6

  // Deadline for every native BarcodeDetector call. Android backs it with a
  // Google Play Services module; when that module is missing or updating,
  // getSupportedFormats()/detect() can hang forever with no error, freezing
  // the scan loop ("the scanner never works on this phone"). A healthy native
  // detect answers in tens of ms, so 1.5 s only ever trips on a real hang.
  const nativeTimeoutMs = Number.isFinite(opts.nativeTimeoutMs) && opts.nativeTimeoutMs > 0
    ? opts.nativeTimeoutMs
    : 1500

  const engines = [
    { id: 'Native', ready: false, detector: null, failures: 0, maxFailures: 3, emptyCount: 0 },
    { id: 'ZXingCpp', ready: false, detector: null, failures: 0, maxFailures: 3, emptyCount: 0 },
    { id: 'ZXing', ready: false, detector: null, failures: 0, maxFailures: 3, emptyCount: 0 },
  ]
  const indexOf = (id) => engines.findIndex(e => e.id === id)
  const byId = (id) => engines[indexOf(id)]
  let activeIndex = 0
  let zxingReader = null
  let cppDecode = null

  // zxing-cpp reader options. Normal frames get the tier's 1D list with the
  // library's own rotate/invert search (cheap in C++); the hard path widens
  // to 2D, mirroring the ZXing-JS hint split below.
  const cppHardList = Array.isArray(opts.hardPathFormats) && opts.hardPathFormats.length
    ? opts.hardPathFormats
    : [...formats, ...HARD_PATH_2D_FORMATS]
  const cppBase = { formats: toCppFormats(formats), tryHarder: true, tryRotate: true, tryInvert: true, maxNumberOfSymbols: 1 }
  const cppHard = { ...cppBase, formats: toCppFormats(cppHardList), maxNumberOfSymbols: 4 }

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
  const runEngine = (engine, { imageData, canvas, zxHints, cppOpts }) => {
    if (engine.id === 'ZXingCpp') {
      if (!cppDecode) throw new Error('zxing-cpp not loaded')
      return cppDecode(imageData, cppOpts || cppBase)
    }
    if (engine.id === 'ZXing') {
      if (!zxingReader) throw new Error('ZXing reader not loaded')
      const result = zxingReader.decode(imageData, zxHints)
      const pts = result.getResultPoints?.() || []
      return [{
        rawValue: result.getText(),
        cornerPoints: pts.map(p => ({ x: p.getX?.() ?? p.x, y: p.getY?.() ?? p.y })),
      }]
    }
    return withDeadline(engine.detector.detect(canvas), nativeTimeoutMs)
  }

  /**
   * A hung native detector is broken, not having a slow frame: take it out of
   * the pool for good (no 3-strike wait, no more hard-pass turns) and move on.
   */
  const disableHungEngine = (engine) => {
    engine.ready = false
    engine.detector = null
    if (debug) console.warn(`[Engine] ${engine.id} hung — disabled for this session`)
    if (getActive() === engine) fallback()
  }

  const initNative = async () => {
    if (typeof window === 'undefined' || !('BarcodeDetector' in window)) return false
    try {
      const fmts = await withDeadline(window.BarcodeDetector.getSupportedFormats(), nativeTimeoutMs)
      // Never ask native for a format it doesn't support — filter the tier
      // list down to what this build can actually decode.
      const usable = formats.filter(f => fmts.includes(f))
      if (!usable.length) return false
      const native = byId('Native')
      native.detector = new window.BarcodeDetector({ formats: usable })
      native.ready = true
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
         * @param {{data: Uint8ClampedArray, width: number, height: number} | {gray: Uint8ClampedArray, width: number, height: number}} imageData
         *   — a pre-rotated {gray, ...} descriptor (rotateGray output) is
         *   already 1 byte/px and skips rgbaToGray entirely.
         * @param {Map} [hints] — defaults to the base (tier) set; the hard path
         *   passes hardHints. Never undefined: a bare decode(bitmap) is exactly
         *   the bug this replaced.
         */
        decode: (imageData, hints = baseHints) => {
          // MUST be 1 byte/px — see rgbaToGray for why raw RGBA silently
          // produces a frame the binarizer can never read.
          const gray = imageData?.gray || rgbaToGray(imageData)
          const lum = new zx.RGBLuminanceSource(gray, imageData.width, imageData.height)
          // MultiFormatReader console.warns 'non-ReaderException' on EVERY
          // missed frame (its instanceof check fails on the library's own
          // NotFoundException), i.e. several times a second for a whole
          // event day — CPU and console-buffer memory a low-end phone can't
          // spare. Drop just that message for the synchronous decode.
          const warn = console.warn
          console.warn = (...args) => {
            if (typeof args[0] === 'string' && args[0].startsWith('MultiFormatReader: non-ReaderException')) return
            warn.apply(console, args)
          }
          try {
            return reader.decode(new zx.BinaryBitmap(new zx.HybridBinarizer(lum)), hints)
          } finally {
            console.warn = warn
          }
        },
      }
      byId('ZXing').ready = true
      if (debug) console.log('[Engine] ZXing ready')
      return true
    } catch (e) {
      if (debug) console.warn('[Engine] ZXing load failed:', e?.message)
      return false
    }
  }

  const initCpp = async () => {
    if (!cppBase.formats.length) return false
    const decode = await loadZxingCpp({ debug })
    if (!decode) return false
    cppDecode = decode
    const cpp = byId('ZXingCpp')
    cpp.ready = true
    cpp.failures = 0
    cpp.emptyCount = 0
    // Engine preference is Native → zxing-cpp → ZXing-JS. If the download
    // landed late (init gave up waiting and the pool is scanning on ZXing-JS,
    // or nothing is ready yet), take over now instead of waiting for a run of
    // misses. Never displace a working native detector.
    const active = getActive()
    if (!active.ready || active.id === 'ZXing') {
      activeIndex = indexOf('ZXingCpp')
      if (debug) console.log('[Engine] zxing-cpp ready — promoted over', active.id)
    } else if (debug) {
      console.log('[Engine] zxing-cpp ready')
    }
    return true
  }

  const loaders = { Native: initNative, ZXingCpp: initCpp, ZXing: initZXing }

  // Engines whose load is in flight, so init() and armFallback() never load
  // the same engine twice in parallel.
  const loading = new Map()
  const load = (id) => {
    if (byId(id).ready) return Promise.resolve(true)
    if (!loading.has(id)) {
      loading.set(id, loaders[id]().catch(() => false).finally(() => loading.delete(id)))
    }
    return loading.get(id)
  }

  // The zxing-cpp .wasm (~0.9 MB) is the one engine that can need the
  // network: the first visit before the service worker has cached it, on a
  // captive portal or 2G line where the fetch can stall with no error at all.
  // init() must not wait on that forever — ZXing-JS is already in the bundle
  // and can scan today. The download keeps running in the background and the
  // engine joins the pool (via the empty-result handoff) when it lands.
  const slowEngineMs = Number.isFinite(opts.slowEngineMs) && opts.slowEngineMs > 0
    ? opts.slowEngineMs
    : 4000
  const waitAtMost = (promise, ms) => new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), ms)
    promise.then(ok => { clearTimeout(timer); resolve(ok) }, () => { clearTimeout(timer); resolve(false) })
  })

  const init = async () => {
    for (const e of engines) {
      const pending = load(e.id)
      const ok = e.id === 'ZXingCpp' ? await waitAtMost(pending, slowEngineMs) : await pending
      if (ok) { activeIndex = indexOf(e.id); return }
    }
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
  /**
   * Try the zxing-cpp download again (e.g. when the phone comes back online
   * after every attempt failed). Resolves true when it loaded and took over,
   * false when it was already loaded or still cannot load.
   */
  const retryUpgrade = () => {
    if (byId('ZXingCpp').ready) return Promise.resolve(false)
    return load('ZXingCpp')
  }

  const armFallback = () => {
    const pending = engines.filter(e => !e.ready).map(e => load(e.id))
    if (!pending.length) return Promise.resolve(false)
    return Promise.all(pending).then(results => results.some(Boolean))
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
    // (No ready engine at all is unreachable here: handoffEmpty only runs from
    // detect() after a *ready* engine's clean miss. `ready` is cleared only by
    // disableHungEngine, which never runs on a clean miss. Hold position.)
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
      if (engine.id === 'ZXingCpp') {
        const imageData = surface.read()
        if (!imageData) { engine.failures = 0; return { barcodes: [], engine: engine.id } }
        barcodes = await runEngine(engine, { imageData })
        engine.failures = 0
      } else if (engine.id === 'ZXing') {
        if (!zxingReader) { fallback(); return { barcodes: [], engine: engine.id } }
        const imageData = surface.read()
        if (!imageData) { engine.failures = 0; return { barcodes: [], engine: engine.id } }
        try {
          barcodes = runEngine(engine, { imageData })
          engine.failures = 0
        } catch (e) {
          // An empty frame is the normal case, not an engine failure — counting
          // it would make the pool thrash and flap the engine label.
          if (isZxingMiss(e)) {
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
      if (e instanceof EngineTimeout) {
        disableHungEngine(engine)
        return { barcodes: [], engine: engine.id }
      }
      engine.failures++
      if (debug) console.warn(`[Engine] ${engine.id} detect error (${engine.failures}/${engine.maxFailures}):`, e?.message)
      if (engine.failures >= engine.maxFailures) fallback()
      return { barcodes: [], engine: engine.id }
    }
  }

  /**
   * The "hard path" second look, used only when a normal pass missed.
   *
   * Runs EVERY ready engine (not just the active one), each on the raw
   * frame, then an enhanced copy (enhanceGray: a soft, sleeve-glared badge
   * that no engine reads raw — field case FB5978GA0008 — reads after it),
   * then the inverted luminance (and rotations for ZXing-JS when zxing-cpp is
   * not loaded). Returns at the FIRST hit. Never throws: one engine's failure
   * must not cost the other its chance, and an empty frame is just a miss.
   * Returns the id of the engine that hit (getActiveId() when nothing did).
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
    // Enhanced copy (sharpen + contrast stretch) for a soft or sleeve-glared
    // badge — see enhanceGray. Built once and shared by every engine; always
    // tried AFTER the raw frame, because on an already-clean frame the
    // enhancement can cost a read (measured on synthetic badges).
    const { width: fw, height: fh } = imageData
    const enhancedGray = imageData.data && fw && fh ? enhanceGray(rgbaToGray(imageData), fw, fh) : null
    const enhancedRgba = enhancedGray?.length ? grayToRgba(enhancedGray, fw, fh) : null
    const seen = new Set()
    const merged = []
    let hitEngine = null

    for (const engine of engines) {
      if (!engine.ready) continue
      const variants = []
      if (engine.id === 'ZXingCpp') {
        // The C++ reader runs its own rotate + invert search; the explicit
        // inverted copy is the same belt-and-braces the JS path gets (on
        // synthetic white-on-black badges the built-in invert alone missed).
        variants.push({ imageData, cppOpts: cppHard })
        if (enhancedRgba) variants.push({ imageData: enhancedRgba, cppOpts: cppHard })
        variants.push({ imageData: inverted, cppOpts: cppHard })
      } else if (engine.id === 'ZXing') {
        // Widened symbologies (2D etc.) — this is the ONLY pass that gets
        // them, so the normal frame budget is never taxed for formats this
        // product doesn't scan. hardHints === baseHints when the tier didn't
        // widen, in which case no reader rebuild happens at all.
        variants.push({ imageData, zxHints: zxingReader?.hardHints })
        if (enhancedGray?.length) {
          variants.push({ imageData: { gray: enhancedGray, width: fw, height: fh }, zxHints: zxingReader?.hardHints })
        }
        variants.push({ imageData: inverted, zxHints: zxingReader?.hardHints })
        // Rotated normal-gray variants (normal gray ONLY — the inverted
        // frame is never rotated). 90° first: a sideways badge is the common
        // case and the dedupe loop keeps the first hit, so the cheapest
        // useful angle is tried before the expensive ones. Computed
        // synchronously up front because rgbaToGray shares one scratch
        // buffer across calls — every rotateGray must finish before the
        // first decode below overwrites it.
        //
        // Skipped when zxing-cpp is loaded: it already searches rotations
        // natively (and read 90° badges 2x as often in the benchmark), while
        // these three JS decodes are the most expensive part of a hard pass —
        // a visible stall on a low-end phone exactly when a badge is hard.
        const { data, width, height } = imageData || {}
        if (data && width && height && !byId('ZXingCpp').ready) {
          const gray = rgbaToGray(imageData)
          for (const deg of SCAN_ROTATIONS) {
            const r = rotateGray(gray, width, height, deg)
            variants.push({
              imageData: { gray: r.gray, width: r.width, height: r.height },
              zxHints: zxingReader?.hardHints,
              rot: deg,
            })
          }
        }
      } else {
        variants.push({ canvas: source })
        const enhCanvas = enhancedRgba ? paintScratch(enhancedRgba, 'enh') : null
        if (enhCanvas) variants.push({ canvas: enhCanvas })
        const invCanvas = invertCanvas(imageData)
        if (invCanvas) variants.push({ canvas: invCanvas })
        const rotCanvas = rotateCanvas(source, 90)
        if (rotCanvas) variants.push({ canvas: rotCanvas, rot: 90 })
      }
      const origW = imageData?.width || source?.width || 0
      const origH = imageData?.height || source?.height || 0
      for (const v of variants) {
        try {
          const barcodes = await runEngine(engine, v)
          for (const b of barcodes || []) {
            if (!b || seen.has(b.rawValue)) continue
            seen.add(b.rawValue)
            const pts = v.rot ? unrotateCornerPoints(b.cornerPoints, v.rot, origW, origH) : b.cornerPoints
            merged.push({ ...b, cornerPoints: pts })
            if (!hitEngine) hitEngine = engine.id
          }
          // First hit wins: a badge is one barcode, so once a variant reads
          // it the remaining engines/variants are pure cost (up to ~10
          // decodes on a phone that is already struggling).
          if (merged.length) return { barcodes: merged, engine: hitEngine }
        } catch (e) {
          // hardPass never throws: one engine's failure must not cost the
          // other its chance, and an empty frame is just a miss.
          if (debug) console.warn(`[Engine] hardPass ${engine.id} failed:`, e?.message)
          if (e instanceof EngineTimeout) { disableHungEngine(engine); break }
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

  return { init, armFallback, retryUpgrade, detect, getActiveId, isReady, fallback, hardPass }
}
