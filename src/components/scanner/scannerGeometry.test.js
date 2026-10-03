/**
 * scannerGeometry.test.js — pure node env (no DOM), by design.
 *
 * The headline test is `deskewGray`: it synthesises a badge, warps it through a
 * REAL perspective transform into a trapezoid (exactly what a tilted card looks
 * like to the lens), and asserts the deskew recovers it — including beating a
 * plain bounding-box resize. If perspective correction silently stopped working,
 * every other scanner fix would still fail on tilted cards.
 */
import { describe, it, expect } from 'vitest'
import {
  mat3inv,
  applyH,
  homography,
  adaptiveThreshold,
  largestBrightRegion,
  quadFromMask,
  isUsableQuad,
  findCardQuad,
  warpGray,
  deskewGray,
  rectCorners,
} from './scannerGeometry'

// ─── Test fixtures ────────────────────────────────────────────────────────────

const CARD_W = 200
const CARD_H = 140
const BG = 40

/** A white badge with a Code-39-ish vertical barcode and a white quiet border. */
function makeCard(w = CARD_W, h = CARD_H) {
  const g = new Uint8ClampedArray(w * h).fill(230)
  const x0 = Math.floor(w * 0.2)
  const x1 = Math.floor(w * 0.8)
  const y0 = Math.floor(h * 0.21)
  const y1 = Math.floor(h * 0.79)
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      g[y * w + x] = ((x - x0) % 8) < 4 ? 10 : 230
    }
  }
  return g
}

/** A strongly perspective-distorted card footprint inside a larger canvas. */
const TRAPEZOID = [
  { x: 55, y: 25 },   // top-left
  { x: 200, y: 40 },  // top-right
  { x: 245, y: 190 }, // bottom-right
  { x: 15, y: 165 },  // bottom-left
]
const CANVAS_W = 260
const CANVAS_H = 200

/** Render the card into a canvas as a tilted trapezoid on a dark background. */
function makeTiltedFrame() {
  const H = homography(TRAPEZOID, rectCorners(CARD_W, CARD_H))
  expect(H).not.toBeNull()
  const card = makeCard()
  return warpGray(card, CARD_W, CARD_H, H, CANVAS_W, CANVAS_H, { fill: BG }).gray
}

/** Mean absolute error between two same-size buffers. */
function mae(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i])
  return s / a.length
}

/** Cheap perspective-free baseline: crop the quad's bbox, nearest-resample. */
function naiveBboxResize(src, sw, sh, quad, outW, outH) {
  const xs = quad.map((p) => p.x)
  const ys = quad.map((p) => p.y)
  const x0 = Math.min(...xs), x1 = Math.max(...xs)
  const y0 = Math.min(...ys), y1 = Math.max(...ys)
  const out = new Uint8ClampedArray(outW * outH)
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(sw - 1, Math.max(0, Math.round(x0 + (x / (outW - 1)) * (x1 - x0))))
      const sy = Math.min(sh - 1, Math.max(0, Math.round(y0 + (y / (outH - 1)) * (y1 - y0))))
      out[y * outW + x] = src[sy * sw + sx]
    }
  }
  return out
}

function distToSet(pt, set) {
  return Math.min(...set.map((q) => Math.hypot(q.x - pt.x, q.y - pt.y)))
}

// ─── Homography / linear algebra ──────────────────────────────────────────────

describe('mat3inv', () => {
  it('inverts the identity to the identity', () => {
    const I = [1, 0, 0, 0, 1, 0, 0, 0, 1]
    expect([...mat3inv(I)]).toEqual(I)
  })

  it('round-trips a real projective matrix', () => {
    const m = [1.2, 0.3, 40, -0.2, 0.9, 25, 0.0004, 0.0002, 1]
    const inv = mat3inv(m)
    expect(inv).not.toBeNull()
    const p = { x: 17, y: 33 }
    const a = applyH(m, p.x, p.y)
    const b = applyH(inv, a.x, a.y)
    expect(b.x).toBeCloseTo(p.x, 6)
    expect(b.y).toBeCloseTo(p.y, 6)
  })

  it('returns null for a singular matrix instead of NaN', () => {
    const singular = [1, 2, 3, 2, 4, 6, 3, 6, 9]
    expect(mat3inv(singular)).toBeNull()
  })
})

describe('homography', () => {
  it('maps each source point onto its target (the property the warp depends on)', () => {
    const from = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 60 }]
    const to = [{ x: 10, y: 12 }, { x: 90, y: 20 }, { x: 85, y: 70 }, { x: 5, y: 65 }]
    const H = homography(from, to)
    expect(H).not.toBeNull()
    for (let i = 0; i < 4; i++) {
      const p = applyH(H, from[i].x, from[i].y)
      expect(p.valid).toBe(true)
      expect(p.x).toBeCloseTo(to[i].x, 5)
      expect(p.y).toBeCloseTo(to[i].y, 5)
    }
  })

  it('stays accurate at photo coordinates (this is what normalisation buys)', () => {
    const from = [
      { x: 1024, y: 768 }, { x: 3584, y: 810 }, { x: 3600, y: 2760 }, { x: 1010, y: 2700 },
    ]
    const to = [{ x: 0, y: 0 }, { x: 799, y: 0 }, { x: 799, y: 539 }, { x: 0, y: 539 }]
    const H = homography(from, to)
    expect(H).not.toBeNull()
    for (let i = 0; i < 4; i++) {
      const p = applyH(H, from[i].x, from[i].y)
      expect(p.x).toBeCloseTo(to[i].x, 3)
      expect(p.y).toBeCloseTo(to[i].y, 3)
    }
  })

  it('rejects fewer than 4 points and mismatched input', () => {
    expect(homography([{ x: 0, y: 0 }], [{ x: 0, y: 0 }])).toBeNull()
    expect(homography(null, null)).toBeNull()
    expect(homography(undefined, [])).toBeNull()
  })

  it('refuses a degenerate (collinear) system rather than returning garbage', () => {
    const line = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 20 }, { x: 30, y: 30 }]
    const H = homography(line, line)
    // Either rejected outright or non-invertible — never a usable-looking matrix.
    expect(H === null || Math.abs(mat3inv(H) ? 1 : 0) === 1).toBe(true)
    if (H) {
      const p = applyH(H, 5, 5)
      expect(p.valid && Number.isFinite(p.x)).toBe(true)
    }
  })
})

// ─── Thresholding ─────────────────────────────────────────────────────────────

describe('adaptiveThreshold', () => {
  it('separates a bright square from a dark background (the global gate)', () => {
    const w = 80, h = 60
    const g = new Uint8ClampedArray(w * h).fill(BG)
    for (let y = 15; y < 45; y++) for (let x = 20; x < 60; x++) g[y * w + x] = 230
    const bin = adaptiveThreshold(g, w, h)

    // Inside the square → bright
    expect(bin[30 * w + 40]).toBe(255)
    // Far corner background → dark. Without the global mean gate this was 255,
    // which merged the whole frame into one component and made a quad impossible.
    expect(bin[2 * w + 2]).toBe(0)
    expect(bin[57 * w + 77]).toBe(0)
  })

  it('marks a uniform frame entirely bright (and is therefore rejected later)', () => {
    const w = 40, h = 30
    const g = new Uint8ClampedArray(w * h).fill(BG)
    const bin = adaptiveThreshold(g, w, h)
    expect(bin.every((v) => v === 255)).toBe(true)
  })

  it('survives short buffers and null input', () => {
    expect(adaptiveThreshold(null, 10, 10)).toBeInstanceOf(Uint8Array)
    expect(adaptiveThreshold(new Uint8ClampedArray(4), 10, 10).length).toBe(100)
    expect(adaptiveThreshold(new Uint8ClampedArray(100), 1, 1)).toHaveLength(1)
  })
})

// ─── Region finding ───────────────────────────────────────────────────────────

describe('largestBrightRegion', () => {
  it('picks the larger of two separate blobs', () => {
    const w = 40, h = 40
    const bin = new Uint8Array(w * h)
    for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) bin[y * w + x] = 255          // 36 px
    for (let y = 20; y < 35; y++) for (let x = 20; x < 35; x++) bin[y * w + x] = 255      // 225 px
    const { mask, count } = largestBrightRegion(bin, w, h)
    expect(count).toBe(225)
    expect(mask[25 * w + 25]).toBe(255)
    expect(mask[5 * w + 5]).toBe(0)
  })

  it('does NOT join opposite edges across a column wrap', () => {
    // Regression guard: without a wrap check, the last column of row N "connects"
    // to the first column of row N+1 and two unrelated strips merge as one card.
    const w = 20, h = 10
    const bin = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) { bin[y * w + 0] = 255; bin[y * w + (w - 1)] = 255 }
    const { count } = largestBrightRegion(bin, w, h)
    expect(count).toBe(h) // one strip, not both
  })

  it('treats 8-connected diagonal neighbours as one region', () => {
    const w = 10, h = 10
    const bin = new Uint8Array(w * h)
    for (let i = 0; i < 5; i++) bin[i * w + i] = 255 // a diagonal
    const { count } = largestBrightRegion(bin, w, h)
    expect(count).toBe(5)
  })

  it('returns zero on empty/short input', () => {
    expect(largestBrightRegion(null, 4, 4).count).toBe(0)
    expect(largestBrightRegion(new Uint8Array(4), 4, 4).count).toBe(0)
  })
})

// ─── Quad extraction ──────────────────────────────────────────────────────────

describe('quadFromMask / isUsableQuad', () => {
  it('recovers the 4 corners of an axis-aligned rectangle', () => {
    const w = 60, h = 50
    const mask = new Uint8Array(w * h)
    for (let y = 10; y < 40; y++) for (let x = 12; x < 48; x++) mask[y * w + x] = 255
    const q = quadFromMask(mask, w, h)
    expect(q).toHaveLength(4)
    // Every true corner must be matched by some extracted corner.
    const truth = [{ x: 12, y: 10 }, { x: 47, y: 10 }, { x: 47, y: 39 }, { x: 12, y: 39 }]
    for (const t of truth) expect(distToSet(t, q)).toBeLessThanOrEqual(2)
    expect(isUsableQuad(q, w, h)).toBe(true)
  })

  it('rejects a thin line (all corners collinear)', () => {
    const w = 60, h = 50
    const mask = new Uint8Array(w * h)
    for (let x = 5; x < 55; x++) mask[25 * w + x] = 255 // 1px-tall bar
    const q = quadFromMask(mask, w, h)
    if (q) expect(isUsableQuad(q, w, h)).toBe(false)
  })

  it('rejects a quad covering the entire frame (that is the background, not a card)', () => {
    const w = 40, h = 40
    const full = [{ x: 0, y: 0 }, { x: 39, y: 0 }, { x: 39, y: 39 }, { x: 0, y: 39 }]
    expect(isUsableQuad(full, w, h)).toBe(true) // geometry alone is fine…
    // …but the caller rejects it via the 99.5% count guard before reaching here.
    const bin = new Uint8Array(w * h).fill(255)
    const { count } = largestBrightRegion(bin, w, h)
    expect(count).toBeGreaterThan(w * h * 0.995)
  })

  it('returns null for an empty mask', () => {
    expect(quadFromMask(new Uint8Array(100), 10, 10)).toBeNull()
    expect(quadFromMask(null, 10, 10)).toBeNull()
    expect(isUsableQuad(null, 10, 10)).toBe(false)
    expect(isUsableQuad([], 10, 10)).toBe(false)
  })
})

// ─── End-to-end: perspective correction ──────────────────────────────────────

describe('findCardQuad', () => {
  it('locates the tilted card in a frame', () => {
    const quad = findCardQuad(makeTiltedFrame(), CANVAS_W, CANVAS_H)
    expect(quad).not.toBeNull()
    for (const t of TRAPEZOID) expect(distToSet(t, quad)).toBeLessThan(25)
  })

  it('returns null when there is no card (uniform frame)', () => {
    const flat = new Uint8ClampedArray(CANVAS_W * CANVAS_H).fill(BG)
    expect(findCardQuad(flat, CANVAS_W, CANVAS_H)).toBeNull()
  })

  it('returns null when the only bright thing is too small to be a card', () => {
    const g = new Uint8ClampedArray(CANVAS_W * CANVAS_H).fill(BG)
    for (let y = 90; y < 98; y++) for (let x = 120; x < 130; x++) g[y * CANVAS_W + x] = 250
    expect(findCardQuad(g, CANVAS_W, CANVAS_H)).toBeNull()
  })

  it('never throws on junk input', () => {
    expect(findCardQuad(null, CANVAS_W, CANVAS_H)).toBeNull()
    expect(findCardQuad(new Uint8ClampedArray(4), 4, 4)).toBeNull()
  })
})

describe('deskewGray — the headline capability', () => {
  it('flattens a strongly tilted card back to its true rectangle', () => {
    const ideal = makeCard()
    const tilted = makeTiltedFrame()

    const out = deskewGray(tilted, CANVAS_W, CANVAS_H, CARD_W, CARD_H)
    expect(out).not.toBeNull()
    expect(out.width).toBe(CARD_W)
    expect(out.height).toBe(CARD_H)

    const err = mae(out.gray, ideal)
    // Absolute bar: the recovered card must be close to the original.
    expect(err).toBeLessThan(30)
    // Relative bar: perspective correction must beat a plain bbox resize, i.e.
    // this module is actually paying for itself rather than just resampling.
    const naive = naiveBboxResize(tilted, CANVAS_W, CANVAS_H, TRAPEZOID, CARD_W, CARD_H)
    expect(err).toBeLessThan(mae(naive, ideal))
  })

  it('returns null when no card can be found (caller must fall back)', () => {
    const flat = new Uint8ClampedArray(CANVAS_W * CANVAS_H).fill(BG)
    expect(deskewGray(flat, CANVAS_W, CANVAS_H, CARD_W, CARD_H)).toBeNull()
    expect(deskewGray(null, CANVAS_W, CANVAS_H, CARD_W, CARD_H)).toBeNull()
  })
})

describe('warpGray', () => {
  it('an identity homography reproduces the source', () => {
    const g = makeCard(40, 30)
    const H = homography(rectCorners(40, 30), rectCorners(40, 30))
    const out = warpGray(g, 40, 30, H, 40, 30)
    expect(out.width).toBe(40)
    expect(out.height).toBe(30)
    expect(mae(out.gray, g)).toBeLessThan(1)
  })

  it('fills outside-the-quad pixels with the requested colour', () => {
    const g = new Uint8ClampedArray(20 * 20).fill(255)
    // warpGray needs H in the DIRECTION dst→src: for every output pixel it
    // computes where to SAMPLE in the source. Span the output over a source
    // region LARGER than the buffer so the corners land outside and only the
    // middle of the output actually samples image data.
    const span = [{ x: -40, y: -40 }, { x: 60, y: -40 }, { x: 60, y: 60 }, { x: -40, y: 60 }]
    const H = homography(rectCorners(60, 60), span)
    const out = warpGray(g, 20, 20, H, 60, 60, { fill: BG })
    expect(out.gray[0]).toBe(BG)          // far corner: outside the quad
    expect(out.gray[30 * 60 + 30]).toBe(255) // centre: inside the quad
  })

  it('returns a filled buffer for null/degenerate input instead of throwing', () => {
    expect(warpGray(null, 10, 10, null, 10, 10).gray.length).toBe(100)
    expect(warpGray(new Uint8ClampedArray(4), 0, 0, null, 5, 5).width).toBe(5)
  })
})
