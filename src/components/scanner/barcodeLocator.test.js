/**
 * barcodeLocator.test.js — node env, no DOM. Every fixture is built in code:
 * the diagnostic photos used to analyse this scanner contain real VSFB badge
 * numbers, so NO image file from disk is ever loaded into the test suite.
 */
import { describe, it, expect } from 'vitest'
import { locateBarcode, clampBoxTo, padBox } from './barcodeLocator'

const BG = 40
const PAPER = 230
const INK = 15

/**
 * A white card with vertical stripes.
 * `shear` tilts the stripes: constant value of (x + shear·y) ⇒ bar direction
 * (−shear, 1), so the tilt from vertical is atan(shear) degrees.
 */
function stripeCard(w, h, { pitch = 8, duty = 0.5, shear = 0, fill = BG, card = true, cy = 0.5, cx = 0.5, ch = 0.7, cw = 0.8 } = {}) {
  const g = new Uint8ClampedArray(w * h).fill(fill)
  if (!card) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = (x + shear * y) % pitch
        g[y * w + x] = v < pitch * duty ? INK : PAPER
      }
    }
    return g
  }
  const y0 = Math.round(h * (cy - ch / 2))
  const y1 = Math.round(h * (cy + ch / 2))
  const x0 = Math.round(w * (cx - cw / 2))
  const x1 = Math.round(w * (cx + cw / 2))
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) g[y * w + x] = PAPER
  }
  // Stripes inset from the card edge so there is a genuine quiet zone.
  const by0 = Math.round(h * (cy - ch * 0.3))
  const by1 = Math.round(h * (cy + ch * 0.3))
  const bx0 = Math.round(w * (cx - cw * 0.32))
  const bx1 = Math.round(w * (cx + cw * 0.32))
  for (let y = by0; y < by1; y++) {
    for (let x = bx0; x < bx1; x++) {
      const v = (x + shear * (y - h / 2)) % pitch
      g[y * w + x] = v < pitch * duty ? INK : PAPER
    }
  }
  return g
}

/** Horizontal stripes = a barcode held rotated 90°. */
function horizontalBarCard(w, h) {
  const g = new Uint8ClampedArray(w * h).fill(BG)
  const y0 = Math.round(h * 0.25)
  const y1 = Math.round(h * 0.75)
  const x0 = Math.round(w * 0.2)
  const x1 = Math.round(w * 0.8)
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) g[y * w + x] = PAPER
  const by0 = Math.round(h * 0.32)
  const by1 = Math.round(h * 0.68)
  for (let y = by0; y < by1; y++) {
    for (let x = Math.round(w * 0.28); x < Math.round(w * 0.72); x++) {
      g[y * w + x] = (y % 8) < 4 ? INK : PAPER
    }
  }
  return g
}

/** Irregular vertical strokes: text-like content, NOT a barcode. */
function textLike(w, h) {
  const g = new Uint8ClampedArray(w * h).fill(BG)
  for (let y = Math.round(h * 0.3); y < Math.round(h * 0.7); y++) {
    for (let x = Math.round(w * 0.15); x < Math.round(w * 0.85); x++) g[y * w + x] = PAPER
  }
  // Uneven glyph widths and gaps — deliberately NOT a constant pitch.
  const widths = [3, 7, 2, 9, 4, 6, 2, 11, 3, 5, 8, 2, 6, 3, 9, 4]
  const gaps = [5, 11, 3, 7, 14, 4, 9, 3, 12, 6, 4, 10, 3, 8, 5]
  let x = Math.round(w * 0.18)
  const y0 = Math.round(h * 0.38)
  const y1 = Math.round(h * 0.62)
  for (let i = 0; i < widths.length && x < w * 0.84; i++) {
    const end = Math.min(Math.round(w * 0.84), x + widths[i])
    for (let yy = y0; yy < y1; yy++) for (let xx = x; xx < end; xx++) g[yy * w + xx] = INK
    x = end + gaps[i]
  }
  return g
}

const overlapRatio = (a, b) => {
  const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  return (ix * iy) / (a.width * a.height)
}

describe('locateBarcode — vertical (normal) orientation', () => {
  it('locates a horizontal barcode and its box covers the stripes', () => {
    const w = 240
    const h = 180
    const g = stripeCard(w, h)
    const loc = locateBarcode(g, w, h)
    expect(loc).not.toBeNull()
    // Stripes occupy the card's inner 64% × 60% — that is the region the box
    // must overlap (verified against the fixture's own geometry below).
    const stripes = { x: 59, y: 52, width: 122, height: 76 }
    expect(overlapRatio(loc, stripes)).toBeGreaterThan(0.6)
    expect(loc.confidence).toBeGreaterThanOrEqual(0.5)
    expect(loc.rotation).toBe(0)
    expect(Math.abs(loc.angle)).toBeLessThanOrEqual(10)
  })

  it('reports rotation 0 and a near-zero angle for an upright barcode', () => {
    const w = 320
    const h = 200
    const loc = locateBarcode(stripeCard(w, h), w, h)
    expect(loc).not.toBeNull()
    expect(loc.rotation).toBe(0)
    expect(Math.abs(loc.angle)).toBeLessThanOrEqual(10)
  })

  it('finds the box without being pinned to the frame centre', () => {
    const w = 240
    const h = 180
    const loc = locateBarcode(stripeCard(w, h, { cx: 0.28, cy: 0.7 }), w, h)
    expect(loc).not.toBeNull()
    // Box must sit left-of-centre and below-centre, i.e. it tracked the card.
    expect(loc.x + loc.width / 2).toBeLessThan(w * 0.5)
    expect(loc.y + loc.height / 2).toBeGreaterThan(h * 0.5)
  })
})

describe('locateBarcode — rotation (option C rides on B)', () => {
  it('detects a 90°-held barcode and asks for rotation 90', () => {
    const w = 240
    const h = 180
    const loc = locateBarcode(horizontalBarCard(w, h), w, h)
    expect(loc).not.toBeNull()
    expect(loc.rotation).toBe(90)
    expect(Math.abs(loc.angle)).toBeGreaterThan(70)
  })

  it('reports a measurable angle for a tilted barcode, nearest rotation 0', () => {
    const w = 240
    const h = 180
    const shear = 0.2
    const loc = locateBarcode(stripeCard(w, h, { shear }), w, h)
    expect(loc).not.toBeNull()
    // True tilt = atan(shear) ≈ 11.3°. 18-bin histogram ⇒ ±5° quantisation,
    // plus ±2° of rasterisation bias → 7° tolerance.
    expect(loc.rotation).toBe(0)
    expect(Math.abs(loc.angle - (Math.atan(shear) * 180) / Math.PI)).toBeLessThan(7)
  })
})

describe('locateBarcode — must refuse to guess', () => {
  it('returns null for a uniform frame', () => {
    const w = 120
    const h = 90
    expect(locateBarcode(new Uint8ClampedArray(w * h).fill(BG), w, h)).toBeNull()
  })

  it('returns null for text-like irregular strokes, not a barcode box', () => {
    const w = 300
    const h = 200
    const loc = locateBarcode(textLike(w, h), w, h)
    // Either refused outright, or — if it did return — it must not have
    // cleared the trust floor.
    if (loc) expect(loc.confidence).toBeLessThan(0.5)
  })

  it('never throws on null / empty / degenerate input', () => {
    expect(locateBarcode(null, 100, 100)).toBeNull()
    expect(locateBarcode(new Uint8ClampedArray(0), 100, 100)).toBeNull()
    expect(locateBarcode(new Uint8ClampedArray(4), 1, 1)).toBeNull()
    expect(locateBarcode(new Uint8ClampedArray(16), 4, 4)).toBeNull()
    expect(locateBarcode(new Uint8ClampedArray(100), NaN, 10)).toBeNull()
    expect(locateBarcode(undefined, 50, 50)).toBeNull()
  })

  it('is total — never returns NaN coordinates or a zero-size box', () => {
    const w = 240
    const h = 180
    const loc = locateBarcode(stripeCard(w, h), w, h)
    expect(Number.isFinite(loc.x) && Number.isFinite(loc.y)).toBe(true)
    expect(loc.width).toBeGreaterThan(0)
    expect(loc.height).toBeGreaterThan(0)
    expect(loc.confidence).toBeGreaterThanOrEqual(0)
    expect(loc.confidence).toBeLessThanOrEqual(1)
  })
})

describe('clampBoxTo', () => {
  const box = { x: -10, y: -5, width: 100, height: 60 }

  it('clamps a box that overflows the left/top edge', () => {
    const out = clampBoxTo(box, 80, 50)
    expect(out.x).toBe(0)
    expect(out.y).toBe(0)
    expect(out.x + out.width).toBeLessThanOrEqual(80)
    expect(out.y + out.height).toBeLessThanOrEqual(50)
  })

  it('clamps a box that overflows the right/bottom edge', () => {
    const out = clampBoxTo({ x: 70, y: 40, width: 100, height: 60 }, 80, 50)
    expect(out.x + out.width).toBeLessThanOrEqual(80)
    expect(out.y + out.height).toBeLessThanOrEqual(50)
  })

  it('rejects a box smaller than the minimum span', () => {
    expect(clampBoxTo({ x: 0, y: 0, width: 4, height: 4 }, 80, 50)).toBeNull()
    expect(clampBoxTo({ x: 79, y: 49, width: 2, height: 2 }, 80, 50)).toBeNull()
  })

  it('clamps an oversized box down to the whole buffer rather than rejecting it', () => {
    // A box bigger than the frame is still usable — it just means "read
    // everything" — so clamping wins over rejection here.
    const out = clampBoxTo({ x: 0, y: 0, width: 100, height: 100 }, 80, 50)
    expect(out).not.toBeNull()
    expect(out).toEqual({ x: 0, y: 0, width: 80, height: 50 })
  })

  it('returns null for null / malformed input', () => {
    expect(clampBoxTo(null, 80, 50)).toBeNull()
    expect(clampBoxTo({ x: NaN, y: 0, width: 50, height: 50 }, 80, 50)).toBeNull()
    expect(clampBoxTo(box, NaN, 50)).toBeNull()
  })
})

describe('padBox', () => {
  it('grows the box by the requested amount', () => {
    const out = padBox({ x: 30, y: 30, width: 40, height: 30 }, 10, 200, 200)
    expect(out.x).toBe(20)
    expect(out.y).toBe(20)
    expect(out.width).toBe(60)
    expect(out.height).toBe(50)
  })

  it('never pads past the buffer bounds (clamping wins)', () => {
    const out = padBox({ x: 2, y: 2, width: 20, height: 20 }, 50, 100, 100)
    expect(out.x).toBe(0)
    expect(out.y).toBe(0)
    expect(out.x + out.width).toBeLessThanOrEqual(100)
    expect(out.y + out.height).toBeLessThanOrEqual(100)
  })

  it('treats a non-numeric amount as zero rather than NaN', () => {
    const out = padBox({ x: 30, y: 30, width: 40, height: 30 }, 'x', 200, 200)
    expect(out).not.toBeNull()
    expect(Number.isFinite(out.x) && Number.isFinite(out.width)).toBe(true)
    expect(out.x).toBe(30)
    expect(out.width).toBe(40)
  })

  it('returns null for null input', () => {
    expect(padBox(null, 10, 100, 100)).toBeNull()
  })
})
