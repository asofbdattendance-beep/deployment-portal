/**
 * barcodeFixtures.js — synthetic barcode fixture generators (TEST-ONLY helpers).
 *
 * WHY: real badge photos carry real VSFB numbers and sewadar names, so no
 * image file may ever be committed. Every 1D/2D frame used by the scanner
 * suites is therefore rendered from these encoders in code, and the DECODER
 * under test is always the real production ZXing path (enginePool.js).
 *
 * Shared by scannerDecode.dataset.test.js (round-trip + orientation matrix)
 * and enginePool.hints.test.js (format-filtering proof), so there is exactly
 * one copy of the encoders in the repo.
 *
 * PII: nothing here reads, imports or embeds a real badge value.
 */
export const BADGE = 'FB5971GA0001'
export const MODULE_PX = 3 // px per narrow module (plan: 2–4 px)
export const QUIET_UNITS = 4 // quiet zone, in modules, on every side

// ─── Synthetic fixture generators ────────────────────────────────────────────
// @zxing/library 0.23.0 ships no 1D writers (only QRCodeWriter,
// DataMatrixWriter, AztecCodeWriter; MultiFormatWriter's 1D/PDF417 imports
// are commented out in the package), so Code 39 / Code 128 frames are
// produced by the minimal encoders below. These generators are test-only
// fixture code — the DECODER under test is the real production ZXing path.

/** Code 39 narrow/wide patterns (9 elements per char, 3 wide; even indices are bars). */
const CODE39_PATTERNS = {
  '0': 'nnnwwnwnn', '1': 'wnnwnnnnw', '2': 'nnwwnnnnw', '3': 'wnwwnnnnn', '4': 'nnnwwnnnw',
  '5': 'wnnwwnnnn', '6': 'nnwwwnnnn', '7': 'nnnwnnwnw', '8': 'wnnwnnwnn', '9': 'nnwwnnwnn',
  A: 'wnnnnwnnw', B: 'nnwnnwnnw', C: 'wnwnnwnnn', D: 'nnnnwwnnw', E: 'wnnnwwnnn',
  F: 'nnwnwwnnn', G: 'nnnnnwwnw', H: 'wnnnnwwnn', I: 'nnwnnwwnn', J: 'nnnnwwwnn',
  K: 'wnnnnnnww', L: 'nnwnnnnww', M: 'wnwnnnnwn', N: 'nnnnwnnww', O: 'wnnnwnnwn',
  P: 'nnwnwnnwn', Q: 'nnnnnnwww', R: 'wnnnnnwwn', S: 'nnwnnnwwn', T: 'nnnnwnwwn',
  U: 'wwnnnnnnw', V: 'nwwnnnnnw', W: 'wwwnnnnnn', X: 'nwnnwnnnw', Y: 'wwnnwnnnn',
  Z: 'nwwnwnnnn', '-': 'nwnnnnwnw', '.': 'wwnnnnwnn', ' ': 'nwwnnnwnn', $: 'nwnnwnwnn',
  '/': 'nwnnwnnnw', '+': 'nwnnnwnwn', '%': 'nnnwnwnwn', '*': 'nwnnwnwnn',
}

/**
 * Encode text to Code 39 elements: [{u, bar}] where u is the element width
 * in narrow-module units (wide = 2.5) and bar marks bar vs space elements.
 * Start/stop '*' guards are included, as the symbology requires.
 */
export function encodeCode39(text) {
  const out = []
  for (const c of `*${text.toUpperCase()}*`) {
    const pattern = CODE39_PATTERNS[c]
    if (!pattern) throw new Error(`no Code 39 pattern for character: ${c}`)
    for (let i = 0; i < 9; i += 1) {
      out.push({ u: pattern[i] === 'w' ? 2.5 : 1, bar: i % 2 === 0 })
    }
    out.push({ u: 1, bar: false }) // inter-character gap
  }
  return out
}

/** Code 128 bar/space width patterns, values 0–106 (stop = 106, 7 elements). */
const CODE128_PATTERNS = [
  [2, 1, 2, 2, 2, 2], [2, 2, 2, 1, 2, 2], [2, 2, 2, 2, 2, 1], [1, 2, 1, 2, 2, 3], [1, 2, 1, 3, 2, 2],
  [1, 3, 1, 2, 2, 2], [1, 2, 2, 2, 1, 3], [1, 2, 2, 3, 1, 2], [1, 3, 2, 2, 1, 2], [2, 2, 1, 2, 1, 3],
  [2, 2, 1, 3, 1, 2], [2, 3, 1, 2, 1, 2], [1, 1, 2, 2, 3, 2], [1, 2, 2, 1, 3, 2], [1, 2, 2, 2, 3, 1],
  [1, 1, 3, 2, 2, 2], [1, 2, 3, 1, 2, 2], [1, 2, 3, 2, 2, 1], [2, 2, 3, 2, 1, 1], [2, 2, 1, 1, 3, 2],
  [2, 2, 1, 2, 3, 1], [2, 1, 3, 2, 1, 2], [2, 2, 3, 1, 1, 2], [3, 1, 2, 1, 3, 1], [3, 1, 1, 2, 2, 2],
  [3, 2, 1, 1, 2, 2], [3, 2, 1, 2, 2, 1], [3, 1, 2, 2, 1, 2], [3, 2, 2, 1, 1, 2], [3, 2, 2, 2, 1, 1],
  [2, 1, 2, 1, 2, 3], [2, 1, 2, 3, 2, 1], [2, 3, 2, 1, 2, 1], [1, 1, 1, 3, 2, 3], [1, 3, 1, 1, 2, 3],
  [1, 3, 1, 3, 2, 1], [1, 1, 2, 3, 1, 3], [1, 3, 2, 1, 1, 3], [1, 3, 2, 3, 1, 1], [2, 1, 1, 3, 1, 3],
  [2, 3, 1, 1, 1, 3], [2, 3, 1, 3, 1, 1], [1, 1, 2, 1, 3, 3], [1, 1, 2, 3, 3, 1], [1, 3, 2, 1, 3, 1],
  [1, 1, 3, 1, 2, 3], [1, 1, 3, 3, 2, 1], [1, 3, 3, 1, 2, 1], [3, 1, 3, 1, 2, 1], [2, 1, 1, 3, 3, 1],
  [2, 3, 1, 1, 3, 1], [2, 1, 3, 1, 1, 3], [2, 1, 3, 3, 1, 1], [2, 1, 3, 1, 3, 1], [3, 1, 1, 1, 2, 3],
  [3, 1, 1, 3, 2, 1], [3, 3, 1, 1, 2, 1], [3, 1, 2, 1, 1, 3], [3, 1, 2, 3, 1, 1], [3, 3, 2, 1, 1, 1],
  [3, 1, 4, 1, 1, 1], [2, 2, 1, 4, 1, 1], [4, 3, 1, 1, 1, 1], [1, 1, 1, 2, 2, 4], [1, 1, 1, 4, 2, 2],
  [1, 2, 1, 1, 2, 4], [1, 2, 1, 4, 2, 1], [1, 4, 1, 1, 2, 2], [1, 4, 1, 2, 2, 1], [1, 1, 2, 2, 1, 4],
  [1, 1, 2, 4, 1, 2], [1, 2, 2, 1, 1, 4], [1, 2, 2, 4, 1, 1], [1, 4, 2, 1, 1, 2], [1, 4, 2, 2, 1, 1],
  [2, 4, 1, 2, 1, 1], [2, 2, 1, 1, 1, 4], [4, 1, 3, 1, 1, 1], [2, 4, 1, 1, 1, 2], [1, 3, 4, 1, 1, 1],
  [1, 1, 1, 2, 4, 2], [1, 2, 1, 1, 4, 2], [1, 2, 1, 2, 4, 1], [1, 1, 4, 2, 1, 2], [1, 2, 4, 1, 1, 2],
  [1, 2, 4, 2, 1, 1], [4, 1, 1, 2, 1, 2], [4, 2, 1, 1, 1, 2], [4, 2, 1, 2, 1, 1], [2, 1, 2, 1, 4, 1],
  [2, 1, 4, 1, 2, 1], [4, 1, 2, 1, 2, 1], [1, 1, 1, 1, 4, 3], [1, 1, 1, 3, 4, 1], [1, 3, 1, 1, 4, 1],
  [1, 1, 4, 1, 1, 3], [1, 1, 4, 3, 1, 1], [4, 1, 1, 1, 1, 3], [4, 1, 1, 3, 1, 1], [1, 1, 3, 1, 4, 1],
  [1, 1, 4, 1, 3, 1], [3, 1, 1, 1, 4, 1], [4, 1, 1, 1, 3, 1], [2, 1, 1, 4, 1, 2], [2, 1, 1, 2, 1, 4],
  [2, 1, 1, 2, 3, 2], [2, 3, 3, 1, 1, 1, 2],
]

/**
 * Encode text to Code 128 (Code B) elements, same contract as encodeCode39.
 * Checksum = (start + Σ value_i × i) mod 103, per the symbology spec.
 */
export function encodeCode128B(text) {
  const values = [104] // start code B
  for (const c of text) {
    const v = c.charCodeAt(0) - 32
    if (v < 0 || v > 94) throw new Error(`character not encodable in Code 128 B: ${c}`)
    values.push(v)
  }
  let sum = values[0]
  for (let i = 1; i < values.length; i += 1) sum += values[i] * i
  values.push(sum % 103, 106) // checksum, stop
  const out = []
  for (const v of values) {
    const pattern = CODE128_PATTERNS[v]
    for (let i = 0; i < pattern.length; i += 1) {
      out.push({ u: pattern[i], bar: i % 2 === 0 })
    }
  }
  return out
}

/**
 * Render 1D elements to a grayscale frame: white background (black when
 * inverted), dark bars (light when inverted), quiet zone at both ends.
 * @returns {{gray: Uint8ClampedArray, width: number, height: number}}
 */
export function render1D(elements, invert = false) {
  const totalUnits = QUIET_UNITS * 2 + elements.reduce((a, e) => a + e.u, 0)
  const width = Math.round(totalUnits * MODULE_PX)
  const height = Math.round(40 * MODULE_PX)
  const gray = new Uint8ClampedArray(width * height).fill(invert ? 0 : 255)
  let xUnits = QUIET_UNITS
  for (const e of elements) {
    if (e.bar) {
      const startPx = Math.round(xUnits * MODULE_PX)
      const px = Math.max(1, Math.round(e.u * MODULE_PX))
      const value = invert ? 255 : 0
      for (let cx = 0; cx < px; cx += 1) {
        const col = startPx + cx
        if (col >= width) break
        for (let y = 0; y < height; y += 1) gray[y * width + col] = value
      }
    }
    xUnits += e.u
  }
  return { gray, width, height }
}

/**
 * Render a 2D BitMatrix to grayscale with a quiet zone on all sides.
 * @returns {{gray: Uint8ClampedArray, width: number, height: number}}
 */
export function render2D(bitMatrix, invert = false) {
  const width = (bitMatrix.getWidth() + 2 * QUIET_UNITS) * MODULE_PX
  const height = (bitMatrix.getHeight() + 2 * QUIET_UNITS) * MODULE_PX
  const gray = new Uint8ClampedArray(width * height).fill(invert ? 0 : 255)
  for (let my = 0; my < bitMatrix.getHeight(); my += 1) {
    for (let mx = 0; mx < bitMatrix.getWidth(); mx += 1) {
      if (bitMatrix.get(mx, my)) {
        const value = invert ? 255 : 0
        for (let dy = 0; dy < MODULE_PX; dy += 1) {
          for (let dx = 0; dx < MODULE_PX; dx += 1) {
            gray[((QUIET_UNITS + my) * MODULE_PX + dy) * width + (QUIET_UNITS * MODULE_PX + mx * MODULE_PX + dx)] = value
          }
        }
      }
    }
  }
  return { gray, width, height }
}

/** 255 − v per pixel — mirrors enginePool.invertImageData on a gray frame. */
export function invertGray(gray) {
  const out = new Uint8ClampedArray(gray.length)
  for (let i = 0; i < gray.length; i += 1) out[i] = 255 - gray[i]
  return out
}
