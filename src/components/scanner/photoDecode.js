/**
 * photoDecode.js — read a badge from ONE still photo.
 *
 * WHY: some phones never read a badge from the live camera stream: iOS gives
 * a web page no focus control, some Android firmwares hand the browser a
 * 640x480 stream, and in-app browsers (WhatsApp, Instagram) often block
 * getUserMedia altogether. A file input with `capture` opens the phone's own
 * camera app instead, which focuses properly (macro lens included) and returns
 * a full-resolution photo. Dynamsoft, Scandit and Scanbot ship the same
 * fallback (docs/mobile/web-scanner-sdk-landscape.md, gap 1).
 *
 * Pipeline, stopping at the first step that decides:
 *   1. Native BarcodeDetector on the whole bitmap (ML Kit on Android Chrome).
 *   2. zxing-cpp on the whole photo, scaled so its long edge is at most
 *      PHOTO_MAX_EDGE (a 12 MP RGBA frame is ~48 MB — too much for a cheap
 *      phone's memory).
 *   3. zxing-cpp on the centre PHOTO_CROP_FRACTION of the photo at full
 *      detail, for a small badge that step 2's scaling blurred away.
 *
 * Accuracy: a still gets no second frame to confirm against, so zxing-cpp
 * runs with minLineCount 3 (three scan lines through the code must agree,
 * live uses 2), and a photo holding two DIFFERENT valid badges is refused
 * instead of guessing which one the operator meant.
 */
import { strictCameraBadge } from '../../lib/logic'

export const PHOTO_MAX_EDGE = 2560
export const PHOTO_CROP_FRACTION = 0.6
const NATIVE_TIMEOUT_MS = 4000

export const PHOTO_ZXING_OPTIONS = Object.freeze({
  formats: ['Code39'],
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  tryDownscale: true,
  minLineCount: 3,
  maxNumberOfSymbols: 4,
})

/**
 * @typedef {{name: 'full'|'centre', sx: number, sy: number, sw: number, sh: number, dw: number, dh: number}} PhotoPass
 * @typedef {{
 *   status: 'ok'|'multiple'|'none'|'no_engine'|'unreadable_image',
 *   badge: string|null,
 *   badges: string[],
 *   engine?: string,
 *   pass?: string,
 *   rawCount?: number,
 * }} PhotoResult
 */

function fitScale(w, h, maxEdge) {
  return Math.min(1, maxEdge / Math.max(w, h))
}

/**
 * The crops to decode, in order.
 *
 * @param {number} width
 * @param {number} height
 * @returns {PhotoPass[]}
 */
export function planPhotoPasses(width, height, maxEdge = PHOTO_MAX_EDGE, cropFraction = PHOTO_CROP_FRACTION) {
  const w = Math.floor(Number(width))
  const h = Math.floor(Number(height))
  if (!(w > 0 && h > 0)) return []
  const fullScale = fitScale(w, h, maxEdge)
  const passes = [{
    name: 'full', sx: 0, sy: 0, sw: w, sh: h,
    dw: Math.round(w * fullScale), dh: Math.round(h * fullScale),
  }]
  // Nothing was scaled away, so a crop would only re-read the same pixels.
  if (fullScale === 1) return passes
  const cw = Math.round(w * cropFraction)
  const ch = Math.round(h * cropFraction)
  const cropScale = fitScale(cw, ch, maxEdge)
  passes.push({
    name: 'centre',
    sx: Math.round((w - cw) / 2), sy: Math.round((h - ch) / 2), sw: cw, sh: ch,
    dw: Math.round(cw * cropScale), dh: Math.round(ch * cropScale),
  })
  return passes
}

/**
 * Turn decoder output into a verdict. Only strict badge matches count.
 *
 * @param {Array<string|null|undefined>} rawValues
 * @returns {{status: 'ok'|'multiple'|'none', badge: string|null, badges: string[]}}
 */
export function pickBadge(rawValues) {
  const badges = [...new Set((rawValues || []).map(v => strictCameraBadge(String(v ?? ''))).filter(Boolean))]
  if (badges.length === 1) return { status: 'ok', badge: badges[0], badges }
  if (badges.length > 1) return { status: 'multiple', badge: null, badges }
  return { status: 'none', badge: null, badges }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    Promise.resolve(promise).then(
      v => { clearTimeout(timer); resolve(v) },
      e => { clearTimeout(timer); reject(e) },
    )
  })
}

/**
 * Decode a badge from a photo source.
 *
 * @param {{width: number, height: number}} source an ImageBitmap in the app
 * @param {{
 *   readFrame: (source: object, pass: PhotoPass) => Promise<{data: Uint8ClampedArray, width: number, height: number}>,
 *   nativeDetect?: ((source: object) => Promise<string[]>) | null,
 *   zxingDecode?: ((frame: object, options: object) => Promise<Array<{rawValue: string}>>) | null,
 *   loadZxing?: (() => Promise<((frame: object, options: object) => Promise<Array<{rawValue: string}>>) | null>) | null,
 * }} deps — pass `loadZxing` instead of `zxingDecode` to load the software
 *   decoder only if the native detector does not settle the photo.
 * @returns {Promise<PhotoResult>}
 */
export async function decodeBadgePhoto(source, { readFrame, nativeDetect = null, zxingDecode = null, loadZxing = null }) {
  if (!nativeDetect && !zxingDecode && !loadZxing) return { status: 'no_engine', badge: null, badges: [] }
  let rawCount = 0

  if (nativeDetect) {
    try {
      const raws = await withTimeout(nativeDetect(source), NATIVE_TIMEOUT_MS)
      rawCount += raws?.length || 0
      const verdict = pickBadge(raws)
      if (verdict.status !== 'none') return { ...verdict, engine: 'Native', pass: 'full' }
    } catch { /* hung or failed: the software decoder still runs */ }
  }

  let decode = zxingDecode
  if (!decode && loadZxing) {
    try { decode = await loadZxing() } catch { decode = null }
  }
  if (!decode) {
    return nativeDetect
      ? { status: 'none', badge: null, badges: [], rawCount }
      : { status: 'no_engine', badge: null, badges: [] }
  }

  let framesRead = 0
  for (const pass of planPhotoPasses(source?.width, source?.height)) {
    let frame
    try {
      frame = await readFrame(source, pass)
      framesRead++
    } catch {
      continue
    }
    try {
      const hits = await decode(frame, PHOTO_ZXING_OPTIONS)
      rawCount += hits?.length || 0
      const verdict = pickBadge((hits || []).map(h => h?.rawValue))
      if (verdict.status !== 'none') return { ...verdict, engine: 'ZXingCpp', pass: pass.name }
    } catch { /* try the next pass */ }
  }

  if (framesRead === 0 && !nativeDetect) return { status: 'unreadable_image', badge: null, badges: [] }
  return { status: 'none', badge: null, badges: [], rawCount }
}

/* ─── Browser adapters (not unit-tested: they need a real canvas) ─────── */

/**
 * Decode an image file to an ImageBitmap with its EXIF rotation applied
 * (phone photos are often stored sideways). Throws when the file is not an
 * image the browser can decode.
 *
 * @param {Blob} file
 * @returns {Promise<ImageBitmap>}
 */
export async function loadPhotoBitmap(file) {
  if (typeof createImageBitmap !== 'function') throw new Error('createImageBitmap unsupported')
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    // Older Safari rejects the options bag; modern browsers apply EXIF anyway.
    return createImageBitmap(file)
  }
}

/**
 * Draw one pass of a bitmap into a canvas and read its pixels.
 *
 * @param {ImageBitmap} bitmap
 * @param {PhotoPass} pass
 */
export async function readBitmapFrame(bitmap, { sx, sy, sw, sh, dw, dh }) {
  const canvas = typeof OffscreenCanvas === 'function'
    ? new OffscreenCanvas(dw, dh)
    : Object.assign(document.createElement('canvas'), { width: dw, height: dh })
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('2d context unavailable')
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, dw, dh)
  return ctx.getImageData(0, 0, dw, dh)
}

/**
 * A native Code 39 detector for stills, or null when the browser has none
 * (iOS, Firefox, Android without Google Play Services).
 *
 * @returns {Promise<((source: ImageBitmap) => Promise<string[]>) | null>}
 */
export async function createNativePhotoDetector() {
  try {
    if (typeof window === 'undefined' || typeof window.BarcodeDetector !== 'function') return null
    const formats = await withTimeout(window.BarcodeDetector.getSupportedFormats(), 2000)
    if (!Array.isArray(formats) || !formats.includes('code_39')) return null
    const detector = new window.BarcodeDetector({ formats: ['code_39'] })
    return async (source) => (await detector.detect(source)).map(b => b.rawValue)
  } catch {
    return null
  }
}
