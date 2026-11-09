/**
 * zxingCppEngine.js — ZXing-C++ (WebAssembly) decoder for the engine pool.
 *
 * WHY: @zxing/library is a JS port of the original Java ZXing, which is in
 * maintenance mode. zxing-cpp is the actively developed C++ rewrite. Measured
 * on this repo's synthetic Code 39 badge frames (180 frames: 1.25–3 px/module,
 * blur, sensor noise, 0–90° tilt, inverted print), with the same
 * normal + inverted pipeline the app runs for each engine:
 *   ZXing-JS  63/180 read, ~28 ms/frame
 *   zxing-cpp 69/180 read, ~4.4 ms/frame — 2x better on 90° turned badges,
 *   better on mild blur, zero misreads for either engine.
 * The speed gap matters most on the low-end phones this portal runs on: more
 * decode attempts per second while the operator is still aiming.
 *
 * OFFLINE: zxing-wasm fetches its .wasm from jsDelivr by default. A scanner in
 * a hall with no signal cannot depend on a CDN (the reason the old undecaf
 * polyfill was removed), so the binary is imported as a hashed build asset
 * (`?url`), served from /assets/ and precached by the service worker.
 *
 * Never throws: a browser without WebAssembly, a blocked fetch or a failed
 * compile all resolve to `null`, and the pool keeps the ZXing-JS fallback.
 */
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'

/** Our format strings → zxing-cpp format names. Unknown strings are skipped. */
const CPP_FORMAT = {
  code_39: 'Code39',
  code_128: 'Code128',
  code_93: 'Code93',
  codabar: 'Codabar',
  ean_13: 'EAN13',
  ean_8: 'EAN8',
  itf: 'ITF',
  upc_a: 'UPCA',
  upc_e: 'UPCE',
  data_matrix: 'DataMatrix',
  pdf417: 'PDF417',
  qr_code: 'QRCode',
}

/**
 * @param {string[]} formats our lower_snake format strings
 * @returns {string[]} zxing-cpp names, deduped
 */
export function toCppFormats(formats) {
  const out = new Set()
  for (const f of formats || []) {
    const name = CPP_FORMAT[String(f || '').toLowerCase()]
    if (name) out.add(name)
  }
  return [...out]
}

/**
 * Normalise one zxing-cpp result to the pool's `{rawValue, cornerPoints}`.
 * Position is in the input frame's pixel space, like the other engines.
 */
export function toDetection(result) {
  const p = result?.position || {}
  const corners = [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft]
    .filter(c => c && Number.isFinite(c.x) && Number.isFinite(c.y))
    .map(c => ({ x: c.x, y: c.y }))
  return { rawValue: String(result?.text || ''), cornerPoints: corners }
}

// Download policy for the .wasm. 3 attempts, 1.5 s apart, each capped at
// 10 s: a captive portal or 2G line can stall a fetch with no error at all,
// and a stalled attempt would otherwise never reach its retry. Worst case is
// ~33 s of retrying in the background — the pool scans with ZXing-JS
// meanwhile (see enginePool.init), so the operator is never kept waiting.
const DEFAULT_ATTEMPTS = 3
const DEFAULT_RETRY_DELAY_MS = 1500
const DEFAULT_ATTEMPT_TIMEOUT_MS = 10000

// Stable reference: zxing-wasm compares overrides by value, so a fresh
// function per call would defeat its module cache on the success path.
const LOCAL_WASM = {
  locateFile: (path, prefix) => (path.endsWith('.wasm') ? wasmUrl : prefix + path),
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/** Resolve the promise, or reject once `ms` passes with no answer. */
function withDeadline(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`wasm load timed out after ${ms} ms`)), ms)
    promise.then(
      v => { clearTimeout(timer); resolve(v) },
      e => { clearTimeout(timer); reject(e) },
    )
  })
}

/**
 * Load the WebAssembly reader, retrying the download. Resolves to a decode
 * function, or null once every attempt has failed (the pool then uses
 * ZXing-JS).
 *
 * zxing-wasm CACHES its module promise — a failed download is handed straight
 * back to every later call — so each retry purges that cache first.
 *
 * @param {{debug?: boolean, wasmBinary?: ArrayBuffer|null, attempts?: number, retryDelayMs?: number, attemptTimeoutMs?: number}} [opts]
 * @returns {Promise<null | ((imageData: {data: Uint8ClampedArray, width: number, height: number}, options: object) => Promise<Array<{rawValue: string, cornerPoints: Array}>>)>}
 */
export async function loadZxingCpp({
  debug = false,
  wasmBinary = null,
  attempts = DEFAULT_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
} = {}) {
  if (typeof WebAssembly !== 'object' || typeof WebAssembly.instantiate !== 'function') return null
  let mod
  try {
    mod = await import('zxing-wasm/reader')
  } catch (e) {
    if (debug) console.warn('[Engine] zxing-cpp module import failed:', e?.message)
    return null
  }

  const total = Math.max(1, Math.floor(Number(attempts) || 1))
  for (let attempt = 1; attempt <= total; attempt++) {
    try {
      await withDeadline(mod.prepareZXingModule({
        // Production: our own hashed asset, never the CDN default.
        // `wasmBinary` exists only so node tests can hand in the bytes.
        overrides: wasmBinary ? { wasmBinary } : LOCAL_WASM,
        fireImmediately: true,
      }), attemptTimeoutMs)
      if (debug && attempt > 1) console.log(`[Engine] zxing-cpp loaded on attempt ${attempt}`)
      return async (imageData, options) => {
        const results = await mod.readBarcodes(imageData, options)
        return (results || []).filter(r => r && r.isValid !== false && r.text).map(toDetection)
      }
    } catch (e) {
      if (debug) console.warn(`[Engine] zxing-cpp load attempt ${attempt}/${total} failed:`, e?.message)
      // Drop the cached (rejected or stalled) promise so the next attempt
      // really downloads again.
      try { mod.purgeZXingModule?.() } catch { /* nothing cached */ }
      if (attempt < total) await sleep(retryDelayMs * attempt)
    }
  }
  return null
}
