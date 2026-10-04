/**
 * scannerGeometry.js — perspective correction for tilted cards.
 *
 * WHY THIS EXISTS (the core of the real-world problem).
 *
 * A badge in the hand is almost never fronto-parallel to the lens: it is tilted
 * in yaw and roll, so its rectangle prints as a TRAPEZOID. ZXing's 1D readers
 * work by walking straight horizontal scanlines and looking for a run of bars
 * that decode. On a trapezoid the bars converge — a "horizontal" scanline
 * crosses them at a changing phase, so the modulating run the reader needs
 * never lines up. That is why a card you can clearly see still produces zero
 * reads: the geometry, not the optics or the focus, defeats the decoder.
 *
 * This module flattens the card back to a rectangle before the decoder sees it.
 * It is deliberately a PURE module — every function operates on plain typed
 * arrays with no canvas, no DOM and no camera — so the maths is unit-testable
 * in node and re-usable against a test fixture. `BarcodeScanner` owns the
 * decision of WHEN to pay for this (hard path only, mid/high tier only).
 *
 * ALGORITHM (chosen for cost, not elegance — it runs on a phone).
 *  1. Integral-image adaptive threshold → binary bright/dark.
 *  2. Largest 4/8-connected bright component → the card's mask.
 *  3. Four extreme points (min/max of x+y and x−y) → the quad's corners, then
 *     sorted by angle about the centroid so they are in polygon order.
 *  4. Homography from the destination rectangle to that quad (Hartley-
 *     normalised DLT over 4 correspondences, solved by Gaussian elimination),
 *     then bilinear resampling.
 *
 * Every stage can legitimately return null — no card found, quad too small,
 * singular homography. The caller treats null as "skip the correction and
 * decode the raw frame", so a failure here can never make scanning worse than
 * today.
 */

// ─── Small 3×3 linear algebra ─────────────────────────────────────────────────

/** 3×3 row-major multiply: c = a · b */
function mat3mul(a, b) {
  const c = new Float64Array(9)
  for (let r = 0; r < 3; r++) {
    for (let k = 0; k < 3; k++) {
      const av = a[r * 3 + k]
      if (av === 0) continue
      for (let col = 0; col < 3; col++) c[r * 3 + col] += av * b[k * 3 + col]
    }
  }
  return c
}

/** 3×3 inverse, or null when (near-)singular. */
export function mat3inv(m) {
  const [a, b, c, d, e, f, g, h, i] = m
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null
  const id = 1 / det
  return [
    (e * i - f * h) * id, (c * h - b * i) * id, (b * f - c * e) * id,
    (f * g - d * i) * id, (a * i - c * g) * id, (c * d - a * f) * id,
    (d * h - e * g) * id, (b * g - a * h) * id, (a * e - b * d) * id,
  ]
}

/** Apply a row-major 3×3 homography to a point. */
export function applyH(h, x, y) {
  const w = h[6] * x + h[7] * y + h[8]
  if (!Number.isFinite(w) || Math.abs(w) < 1e-12) return { x: 0, y: 0, valid: false }
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w, valid: true }
}

/** Solve an 8×8 system by Gaussian elimination with partial pivoting. */
function solve8(rows) {
  const n = 8
  const a = rows.map((r) => Float64Array.from(r))
  for (let col = 0; col < n; col++) {
    let piv = col
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r
    if (Math.abs(a[piv][col]) < 1e-12) return null
    if (piv !== col) { const t = a[piv]; a[piv] = a[col]; a[col] = t }
    const pv = a[col][col]
    for (let k = col; k <= n; k++) a[col][k] /= pv
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const factor = a[r][col]
      if (factor === 0) continue
      for (let k = col; k <= n; k++) a[r][k] -= factor * a[col][k]
    }
  }
  const out = new Float64Array(n)
  for (let r = 0; r < n; r++) out[r] = a[r][n]
  return out
}

/**
 * Direct Linear Transform homography mapping `fromPts` → `toPts` (4+ pairs).
 *
 * Hartley normalisation (centroid + mean distance to √2) keeps the 8×8 system
 * well-conditioned for image coordinates in the thousands — without it a
 * 12MP photo's coordinates routinely produce a matrix so ill-conditioned the
 * warp rings or collapses.
 *
 * @param {Array<{x:number,y:number}>} fromPts ≥4 points
 * @param {Array<{x:number,y:number}>} toPts   ≥4 points (same length/order)
 * @returns {Float64Array|null} row-major 3×3, h[8] normalised to 1
 */
export function homography(fromPts, toPts) {
  if (!fromPts || !toPts) return null
  const n = Math.min(fromPts.length, toPts.length)
  if (n < 4) return null

  const norm = (pts) => {
    let cx = 0, cy = 0
    for (const p of pts) { cx += p.x; cy += p.y }
    cx /= n; cy /= n
    let mean = 0
    for (const p of pts) mean += Math.hypot(p.x - cx, p.y - cy)
    mean /= n
    const s = mean > 1e-9 ? Math.SQRT2 / mean : 1
    return {
      pts: pts.map((p) => ({ x: (p.x - cx) * s, y: (p.y - cy) * s })),
      cx, cy, s,
    }
  }

  const F = norm(fromPts)
  const T = norm(toPts)

  const rows = []
  for (let i = 0; i < n; i++) {
    const { x, y } = F.pts[i]
    const { x: u, y: v } = T.pts[i]
    rows.push([x, y, 1, 0, 0, 0, -x * u, -y * u, u])
    rows.push([0, 0, 0, x, y, 1, -x * v, -y * v, v])
    if (rows.length === 8) break
  }

  const hs = solve8(rows)
  if (!hs) return null

  // Hn works in normalised coordinates:  t_n = Hn · f_n
  //   f_n = Nf · f    (centroid out, scale to mean √2)
  //   t   = Nt⁻¹ · t_n
  // so  t = Nt⁻¹ · Hn · Nf · f.
  // Nf/Nt are the FORWARD normalisers (scale s, translation −s·c). Using their
  // inverses here instead produces a matrix that is only correct when Hn = I,
  // which is why an identity case passes while a real trapezoid warp collapses.
  const Nf = [F.s, 0, -F.s * F.cx, 0, F.s, -F.s * F.cy, 0, 0, 1]
  const Nt = [T.s, 0, -T.s * T.cx, 0, T.s, -T.s * T.cy, 0, 0, 1]
  const NtInv = mat3inv(Nt)
  if (!NtInv) return null

  const Hn = Float64Array.from([hs[0], hs[1], hs[2], hs[3], hs[4], hs[5], hs[6], hs[7], 1])
  const H = mat3mul(mat3mul(NtInv, Hn), Nf)
  if (!H || !Number.isFinite(H[8]) || Math.abs(H[8]) < 1e-12) return null
  // Canonicalise so h[8] === 1 (keeps applyH simple and outputs comparable).
  const inv8 = 1 / H[8]
  return Float64Array.from(H.map((v) => v * inv8))
}

// ─── Thresholding + region finding ────────────────────────────────────────────

/**
 * Bright/dark classification via an integral-image adaptive threshold (O(1)
 * per pixel — one pass, no per-pixel window loop).
 *
 * TWO gates, on purpose:
 *  - LOCAL mean − c   → survives uneven lighting: glare on one side of a card
 *    and shadow on the other would defeat any single global cut-off.
 *  - GLOBAL mean − gc → without it a *uniform* dark background classifies as
 *    bright (pixel == local mean > local mean − c), so the card and everything
 *    around it flood-fill as one blob and no quad can be found at all. This is
 *    the gate that actually separates "card" from "world".
 *
 * @param {Uint8ClampedArray|Uint8Array} gray
 * @param {number} w
 * @param {number} h
 * @param {{block?:number, c?:number, gc?:number, useGlobal?:boolean}} [opts]
 * @returns {Uint8Array} 255 where the pixel reads as bright
 */
export function adaptiveThreshold(gray, w, h, opts = {}) {
  const out = new Uint8Array(w * h)
  if (!gray || w < 2 || h < 2 || gray.length < w * h) return out
  const block = Math.max(3, Math.trunc(opts.block ?? 15)) | 1 // force odd
  const c = opts.c ?? 8
  const useGlobal = opts.useGlobal !== false
  const gc = opts.gc ?? 5

  let gMean = 0
  if (useGlobal) {
    let gs = 0
    for (let i = 0; i < w * h; i++) gs += gray[i]
    gMean = gs / (w * h)
  }
  const gCut = gMean - gc

  const stride = w + 1
  const ii = new Float64Array((w + 1) * (h + 1))
  for (let y = 0; y < h; y++) {
    let rowSum = 0
    const iiRow = (y + 1) * stride
    const iiPrev = y * stride
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x]
      ii[iiRow + x + 1] = rowSum + ii[iiPrev + x + 1] + ii[iiPrev + x] - ii[iiRow + x]
    }
  }

  const r = (block - 1) >> 1
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r)
    const y1 = Math.min(h - 1, y + r)
    const top = y0 * stride
    const bot = (y1 + 1) * stride
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r)
      const x1 = Math.min(w - 1, x + r)
      const sum = ii[bot + x1 + 1] - ii[bot + x0] - ii[top + x1 + 1] + ii[top + x0]
      const area = (x1 - x0 + 1) * (y1 - y0 + 1)
      const mean = sum / area
      const g = gray[y * w + x]
      out[y * w + x] = (g > mean - c && (!useGlobal || g > gCut)) ? 255 : 0
    }
  }
  return out
}

/**
 * Largest 8-connected run of bright pixels — the card.
 *
 * Two-pass iterative flood (explicit stack, no recursion) so a fully-bright
 * frame can't blow the call stack. Returns an explicit mask rather than just
 * the count because the mask is what the corner extraction consumes.
 *
 * @param {Uint8Array} binary — 0/255 from adaptiveThreshold
 * @param {number} w
 * @param {number} h
 * @returns {{mask: Uint8Array, count: number}}
 */
export function largestBrightRegion(binary, w, h) {
  const mask = new Uint8Array(w * h)
  if (!binary || w < 1 || h < 1) return { mask, count: 0 }

  const label = new Int32Array(w * h).fill(-1)
  const stack = new Int32Array(w * h)
  let bestLabel = -1
  let bestCount = 0
  let nextLabel = 0

  const dirs = [-1, 1, -w, w, -w - 1, -w + 1, w - 1, w + 1]

  for (let start = 0; start < w * h; start++) {
    if (binary[start] !== 255 || label[start] !== -1) continue
    const me = nextLabel++
    let sp = 0
    stack[sp++] = start
    label[start] = me
    let count = 0
    while (sp > 0) {
      const idx = stack[--sp]
      count++
      const x = idx % w
      for (let d = 0; d < 8; d++) {
        const ni = idx + dirs[d]
        // Reject out-of-frame neighbours first…
        if (ni < 0 || ni >= w * h) continue
        // …then reject COLUMN WRAPS: without this, the leftmost pixel of a row
        // would "connect" to the rightmost pixel of the row above and two
        // unrelated regions would be merged as one card.
        const dx = (ni % w) - x
        if (dx < -1 || dx > 1) continue
        if (binary[ni] !== 255 || label[ni] !== -1) continue
        label[ni] = me
        stack[sp++] = ni
      }
    }
    if (count > bestCount) { bestCount = count; bestLabel = me }
  }

  if (bestLabel >= 0) for (let i = 0; i < w * h; i++) if (label[i] === bestLabel) mask[i] = 255
  return { mask, count: bestCount }
}

// ─── Quad extraction ──────────────────────────────────────────────────────────

function angleAround(cx, cy, p) { return Math.atan2(p.y - cy, p.x - cx) }

/**
 * Four extreme corners of a pixel mask, ordered counter-clockwise about the
 * centroid (so they form a simple polygon the homography can consume).
 *
 * For any convex-ish blob the rotated-rectangle corners are exactly the extrema
 * of x+y (top-left), x−y (top-right), −(x+y) (bottom-right), −(x−y)
 * (bottom-left) — a cheap substitute for fitting a rectangle.
 *
 * @param {Uint8Array} mask
 * @param {number} w
 * @param {number} h
 * @returns {Array<{x:number,y:number}>|null} 4 ordered corners, or null
 */
export function quadFromMask(mask, w, h) {
  if (!mask || w < 2 || h < 2) return null
  let n = 0, sx = 0, sy = 0
  let minSum = Infinity, maxSum = -Infinity, minDif = Infinity, maxDif = -Infinity
  let pMinSum = null, pMaxSum = null, pMinDif = null, pMaxDif = null

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x] !== 255) continue
      n++
      sx += x; sy += y
      const s = x + y
      const d = x - y
      if (s < minSum) { minSum = s; pMinSum = { x, y } }
      if (s > maxSum) { maxSum = s; pMaxSum = { x, y } }
      if (d < minDif) { minDif = d; pMinDif = { x, y } }
      if (d > maxDif) { maxDif = d; pMaxDif = { x, y } }
    }
  }
  if (n < 16 || !pMinSum || !pMaxSum || !pMinDif || !pMaxDif) return null

  const cx = sx / n
  const cy = sy / n
  const corners = [pMinSum, pMinDif, pMaxSum, pMaxDif]
  corners.sort((a, b) => angleAround(cx, cy, a) - angleAround(cx, cy, b))
  return corners
}

/**
 * Is this quad worth warping? Guards against the two degenerate answers the
 * extractor produces: a thin line (all four points collinear) and a quad that
 * covers essentially the whole frame (i.e. we found "the background", not a
 * card — warping it changes nothing and costs a full resample).
 *
 * @param {Array<{x:number,y:number}>} q
 * @param {number} w
 * @param {number} h
 * @returns {boolean}
 */
export function isUsableQuad(q, w, h) {
  if (!q || q.length < 4 || !w || !h) return false
  // Shoelace area against the frame area.
  let area = 0
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4]
    area += a.x * b.y - b.x * a.y
  }
  area = Math.abs(area) / 2
  const frame = w * h
  if (!(area > frame * 0.08)) return false // too small to be the card
  if (area > frame * 1.3) return false      // implausibly large → math broke
  // No two corners may be on top of each other (zero-width edge).
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4]
    if (Math.hypot(a.x - b.x, a.y - b.y) < 3) return false
  }
  return true
}

// ─── Warping ──────────────────────────────────────────────────────────────────

/**
 * Resample `gray` into an outW×outH rectangle using a dst→src homography.
 * Bilinear sampling keeps bar edges anti-aliased instead of stair-stepping
 * them, which is what lets the binarizer see a clean run.
 *
 * @param {Uint8ClampedArray|Uint8Array} gray
 * @param {number} w source width
 * @param {number} h source height
 * @param {Float64Array|Array<number>} H dst→src homography (row-major 3×3)
 * @param {number} outW
 * @param {number} outH
 * @param {{fill?:number}} [opts]
 * @returns {{gray: Uint8ClampedArray, width: number, height: number}}
 */
export function warpGray(gray, w, h, H, outW, outH, opts = {}) {
  const fill = opts.fill ?? 255
  const out = new Uint8ClampedArray(outW * outH)
  if (!gray || !H || w < 1 || h < 1 || outW < 1 || outH < 1) {
    out.fill(fill)
    return { gray: out, width: Math.max(1, outW || 1), height: Math.max(1, outH || 1) }
  }

  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const p = applyH(H, x + 0.5, y + 0.5)
      if (!p.valid) { out[y * outW + x] = fill; continue }
      const sx = p.x - 0.5
      const sy = p.y - 0.5
      if (sx < -1 || sy < -1 || sx > w || sy > h) { out[y * outW + x] = fill; continue }
      const x0 = Math.floor(sx), y0 = Math.floor(sy)
      const tx = sx - x0, ty = sy - y0
      const clampX0 = Math.min(Math.max(x0, 0), w - 1)
      const clampX1 = Math.min(Math.max(x0 + 1, 0), w - 1)
      const clampY0 = Math.min(Math.max(y0, 0), h - 1)
      const clampY1 = Math.min(Math.max(y0 + 1, 0), h - 1)
      const i00 = clampY0 * w + clampX0
      const i10 = clampY0 * w + clampX1
      const i01 = clampY1 * w + clampX0
      const i11 = clampY1 * w + clampX1
      const top = gray[i00] * (1 - tx) + gray[i10] * tx
      const bot = gray[i01] * (1 - tx) + gray[i11] * tx
      out[y * outW + x] = top * (1 - ty) + bot * ty
    }
  }
  return { gray: out, width: outW, height: outH }
}

/** The destination rectangle as four TL,TR,BR,BL points. */
export function rectCorners(outW, outH) {
  return [
    { x: 0, y: 0 },
    { x: outW - 1, y: 0 },
    { x: outW - 1, y: outH - 1 },
    { x: 0, y: outH - 1 },
  ]
}

// ─── Public entry points ──────────────────────────────────────────────────────

/**
 * Find the card's quad in a (preferably downscaled) frame, or null.
 *
 * @param {Uint8ClampedArray|Uint8Array} gray
 * @param {number} w
 * @param {number} h
 * @param {{block?:number, c?:number, minArea?:number}} [opts]
 * @returns {Array<{x:number,y:number}>|null}
 */
export function findCardQuad(gray, w, h, opts = {}) {
  if (!gray || w < 8 || h < 8 || gray.length < w * h) return null
  const bin = adaptiveThreshold(gray, w, h, opts)
  const { mask, count } = largestBrightRegion(bin, w, h)
  // Reject "the whole frame is bright" (no card boundary visible).
  if (count < w * h * 0.06 || count > w * h * 0.995) return null
  const quad = quadFromMask(mask, w, h)
  if (!isUsableQuad(quad, w, h)) return null
  return quad
}

/**
 * Flatten a tilted card: detect its quad and resample it to outW×outH.
 *
 * @param {Uint8ClampedArray|Uint8Array} gray
 * @param {number} w
 * @param {number} h
 * @param {number} outW
 * @param {number} outH
 * @returns {{gray: Uint8ClampedArray, width: number, height: number, corners: Array<{x:number,y:number}>}|null}
 *   null when no card could be located — the caller must then decode the raw frame.
 */
export function deskewGray(gray, w, h, outW, outH) {
  const quad = findCardQuad(gray, w, h)
  if (!quad) return null
  // dst = the output rectangle, src = the detected quad.
  const H = homography(rectCorners(outW, outH), quad)
  if (!H) return null
  const warped = warpGray(gray, w, h, H, outW, outH)
  return { ...warped, corners: quad }
}
