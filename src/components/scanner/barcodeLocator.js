/**
 * barcodeLocator.js — "SEE the barcode" instead of guessing where it is.
 *
 * WHY THIS EXISTS (the core of the real-world problem).
 *
 * The badge decoder walks straight horizontal scanlines and looks for a run of
 * bars it can decode. When a card is held tilted, small or off-centre the bars
 * those scanlines cross are wrong — the reader sees nothing even though the
 * camera image is perfectly sharp. Worse, the on-screen "guide rectangle" we
 * drew is a FIXED band (92% × 62% of the frame), i.e. a guess; the operator
 * cannot tell where to aim because we never show them where the decoder reads.
 *
 * This module locates the barcode itself (the cluster of parallel stripes — a
 * different, finer-grained problem than `scannerGeometry.js`, which locates the
 * whole CARD) and returns a tight box plus the stripe orientation. The caller
 * uses it to (a) draw a live aim rectangle and (b) crop/rotate the frame before
 * decoding.
 *
 * THE CONTRACT — A HINT, NEVER A GATE.
 *
 * `null` is a normal, expected outcome and simply means "decode the whole frame
 * exactly as today". Because the caller always falls back, a wrong or missing
 * box can only cost a little time — it can never block a read that would have
 * succeeded. That is why the thresholds here are conservative and why
 * confidence below the floor yields `null` rather than a low-quality box.
 *
 * ALGORITHM (chosen for cost — it runs on a low-end phone).
 *  1. One adaptive edge floor from a SPROUTED sample of horizontal luma deltas
 *     (mean + 3σ, clamped) — adapts to contrast without a magic constant.
 *  2. Row profile: per-row count of above-floor horizontal edges. Rows crossing
 *     near-vertical bars score high; flat background scores ~0.
 *  3. Contiguous run of high rows containing the peak → the stripe band.
 *  4. Column profile inside the band → the horizontal extent (the box).
 *  5. Orientation from a 18-bin histogram of gradient DIRECTION inside the box:
 *     bars run perpendicular to the gradient, giving the tilt and, with it,
 *     `rotation` — the 0/90 the caller must rotate by to make bars vertical.
 *  6. Confidence multiplies how far the signal stands out from background
 *     against how REGULAR the stripe spacing is. Regularity is the discriminator
 *     that separates a barcode from printed text: text is full of vertical
 *     strokes too, but with wildly uneven gaps.
 *  7. If the primary pass finds nothing (the bars are horizontal — the
 *     transposed image then looks like an ordinary vertical-bar barcode), the
 *     analysis is RETRIED ONCE on the transposed buffer and the box mapped back.
 *
 * Cost: O(width·height), three light passes, two small profile allocations, no
 * per-pixel object allocation, no nested window loops. Runs at most once per
 * frame, on the scanner's "hard path" only.
 */

/** Smallest edge magnitude worth calling an edge (sensor noise sits below this). */
const EDGE_FLOOR_MIN = 12
const EDGE_FLOOR_MAX = 64
/** A box narrower than this cannot be decoded anyway — reject it. */
const MIN_BOX_SPAN = 8
/** Below this, the buffer is too small to hold a barcode. */
const MIN_BUFFER = 16

/**
 * Adaptive edge floor from a sampled pass: mean + 3σ of |g[x+1] − g[x]|.
 *
 * A fixed threshold breaks on glossy stock (weak contrast) and on a noisy
 * back-lit frame (strong noise). Sampling ~120×160 pixels keeps this O(1) in
 * practice while still tracking the frame's actual contrast.
 *
 * @param {Uint8ClampedArray|Uint8Array} g
 * @param {number} w
 * @param {number} h
 * @returns {number} luma delta threshold in [EDGE_FLOOR_MIN, EDGE_FLOOR_MAX]
 */
function edgeFloor(g, w, h) {
  let s1 = 0
  let s2 = 0
  let n = 0
  const sy = Math.max(1, Math.floor(h / 120))
  const sx = Math.max(1, Math.floor(w / 160))
  for (let y = 0; y < h - 1; y += sy) {
    const row = y * w
    for (let x = 0; x + 1 < w; x += sx) {
      const d = Math.abs(g[row + x + 1] - g[row + x])
      s1 += d
      s2 += d * d
      n++
    }
  }
  if (n === 0) return EDGE_FLOOR_MIN
  const mean = s1 / n
  const sd = Math.sqrt(Math.max(0, s2 / n - mean * mean))
  return Math.min(EDGE_FLOOR_MAX, Math.max(EDGE_FLOOR_MIN, mean + 3 * sd))
}

/** Row / column profiles + the stripe band, for one orientation of the image. */
function analyze(g, w, h, edgeT) {
  if (w < MIN_BUFFER || h < MIN_BUFFER) return null
  const rowE = new Float64Array(h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    let c = 0
    for (let x = 0; x + 1 < w; x++) {
      if (Math.abs(g[row + x + 1] - g[row + x]) >= edgeT) c++
    }
    rowE[y] = c
  }

  let peak = 0
  let pi = -1
  for (let y = 0; y < h; y++) {
    if (rowE[y] > peak) {
      peak = rowE[y]
      pi = y
    }
  }
  // Not even one row carries a credible number of edges → there are no bars.
  if (pi < 0 || peak < Math.max(4, w * 0.02)) return null

  // 45% of the peak: high enough to skip gaps, low enough to keep a band whose
  // strength varies with lighting. Deliberately NOT mean-based — a card whose
  // bars fill most of the frame has a high mean, and a mean-derived cut would
  // exceed the peak and reject a perfectly good barcode.
  const thr = peak * 0.45
  let top = pi
  let bot = pi
  let gap = 0
  for (let y = pi - 1; y >= 0; y--) {
    if (rowE[y] >= thr) {
      top = y
      gap = 0
    } else if (++gap > 2) break
  }
  gap = 0
  for (let y = pi + 1; y < h; y++) {
    if (rowE[y] >= thr) {
      bot = y
      gap = 0
    } else if (++gap > 2) break
  }
  // A 1–2 row band is a hairline, not a barcode.
  if (bot - top < 4) return null

  // Column profile weighted by LOCAL EDGE DENSITY, not raw edge energy.
  //
  // Naively summing gradient magnitudes per column is wrong for a tilted card:
  // a barcode's boundary lines only cross any given column for a handful of
  // band rows (tilt sweeps them across ~8px), whereas the card's own straight
  // left/right border crosses EVERY band row — so the card border wins, the
  // search starts outside the barcode, immediately hits a gap, and the box
  // collapses to a single column. Density fixes this by asking the real
  // question: is this edge part of a dense, regular RUN of edges (a barcode)
  // or an isolated one (a card border)? An isolated edge gets density 0.
  const colE = new Float64Array(w)
  const positions = []
  const win = Math.max(8, Math.round(w * 0.07))
  for (let y = top; y <= bot; y++) {
    const row = y * w
    positions.length = 0
    for (let x = 0; x + 1 < w; x++) {
      if (Math.abs(g[row + x + 1] - g[row + x]) >= edgeT) positions.push(x)
    }
    if (positions.length < 2) continue
    // Two-pointer window over the sorted positions: O(edges), no nested scan.
    let lo = 0
    let hi = 0
    for (let i = 0; i < positions.length; i++) {
      const xi = positions[i]
      while (hi < positions.length && positions[hi] - xi <= win) hi++
      while (xi - positions[lo] > win) lo++
      const neighbours = hi - lo - 1 // excludes self
      if (neighbours > 0) colE[xi] += neighbours
    }
  }
  let cpeak = 0
  let ci = -1
  for (let x = 0; x < w; x++) {
    if (colE[x] > cpeak) {
      cpeak = colE[x]
      ci = x
    }
  }
  if (cpeak <= 0 || ci < 0) return null
  const cthr = cpeak * 0.25
  let left = ci
  let right = ci
  let cgap = 0
  for (let x = ci - 1; x >= 0; x--) {
    if (colE[x] >= cthr) {
      left = x
      cgap = 0
    } else if (++cgap > 4) break
  }
  cgap = 0
  for (let x = ci + 1; x < w; x++) {
    if (colE[x] >= cthr) {
      right = x
      cgap = 0
    } else if (++cgap > 4) break
  }
  if (right - left < MIN_BOX_SPAN) return null

  // Background = rows the band did NOT claim. Flat background ⇒ near zero, so
  // prominence separates a real stripe band from a frame with edges everywhere.
  let outsideN = 0
  let outsideSum = 0
  for (let y = 0; y < h; y++) {
    if (y < top || y > bot) {
      outsideSum += rowE[y]
      outsideN++
    }
  }
  const outsideMean = outsideN > 0 ? outsideSum / outsideN : null

  // Average edges per row inside the box — a barcode carries a dense, regular
  // run; sparse content does not.
  let inBand = 0
  const bandH = bot - top + 1
  for (let y = top; y <= bot; y++) {
    for (let x = left; x <= right; x++) if (colE[x] > 0) inBand++
  }
  const edgesPerRow = inBand / bandH

  // Regularity: fraction of consecutive edge gaps within ±40% of the median gap
  // (min ±2px so low-resolution barcodes aren't punished by rounding). Printed
  // text has vertical strokes too but wildly uneven spacing — this is the
  // discriminator that keeps it from being mistaken for a barcode.
  const regularity = gapRegularity(g, w, h, left, right, pi, edgeT)

  return {
    x: left,
    y: top,
    width: right - left + 1,
    height: bandH,
    peak,
    outsideMean,
    edgesPerRow,
    regularity,
  }
}

/** Fraction of inter-edge gaps near the median gap on one row (0 when unusable). */
function gapRegularity(g, w, h, left, right, rowIdx, edgeT) {
  const y = Math.min(Math.max(rowIdx, 0), h - 1)
  const row = y * w
  const gaps = []
  let prev = -1
  const end = Math.min(right, w - 2)
  for (let x = Math.max(left, 0); x <= end; x++) {
    if (Math.abs(g[row + x + 1] - g[row + x]) >= edgeT) {
      if (prev >= 0) gaps.push(x - prev)
      prev = x
    }
  }
  if (gaps.length < 3) return 0
  const sorted = [...gaps].sort((a, b) => a - b)
  const median = sorted[sorted.length >> 1]
  if (median <= 0) return 0
  const tol = Math.max(2, median * 0.4)
  let near = 0
  for (const gap of gaps) if (Math.abs(gap - median) <= tol) near++
  return near / gaps.length
}

/** Bring an angle into (−90, 90] — the stripe axis has 180° symmetry. */
function normAngle(a) {
  let v = a
  while (v > 90) v -= 180
  while (v <= -90) v += 180
  return v
}

/**
 * Sub-pixel shift `d` maximising the overlap of two binary edge sequences
 * (score(d) = Σ ref[x]·other[x+d]), or null when there is no signal at all.
 *
 * A parabolic fit through the top three scores recovers the fractional part:
 * a barcode tilted 0.2px per row shifts by a whole pixel only once every five
 * rows, so integer-only estimation would quantise the tilt in steps of ~10%.
 */
function bestShift(ref, other, len, maxShift) {
  if (len < 4) return null
  const scores = []
  let best = -1
  let bestD = 0
  for (let d = -maxShift; d <= maxShift; d++) {
    let s = 0
    const from = Math.max(0, -d)
    const to = Math.min(len, len - d)
    for (let x = from; x < to; x++) if (ref[x] && other[x + d]) s++
    scores.push(s)
    if (s > best) {
      best = s
      bestD = d
    }
  }
  if (best <= 0) return null
  const i = bestD + maxShift
  if (i > 0 && i < scores.length - 1) {
    const a = scores[i - 1]
    const b = scores[i]
    const c = scores[i + 1]
    const den = a - 2 * b + c
    if (den < -1e-9) {
      const delta = (0.5 * (a - c)) / den
      if (delta > -1 && delta < 1) return bestD + delta
    }
  }
  return bestD
}

function rowTilt(g, w, x0, x1, y0, y1, edgeT) {
  const len = x1 - x0 + 1
  if (len < 8) return null
  const prev = new Uint8Array(len)
  const cur = new Uint8Array(len)
  const fill = (arr, y) => {
    const row = y * w
    for (let i = 0; i < len; i++) {
      arr[i] = Math.abs(g[row + x0 + i + 1] - g[row + x0 + i]) >= edgeT ? 1 : 0
    }
  }
  fill(prev, y0)
  let sum = 0
  let cnt = 0
  for (let y = y0 + 1; y <= y1; y++) {
    fill(cur, y)
    const d = bestShift(prev, cur, len, 4)
    if (d !== null) {
      sum += d
      cnt++
    }
    prev.set(cur)
  }
  if (cnt < 4) return null
  return sum / cnt
}

function colTilt(g, w, x0, x1, y0, y1, edgeT) {
  const len = y1 - y0 + 1
  if (len < 8) return null
  const prev = new Uint8Array(len)
  const cur = new Uint8Array(len)
  const fill = (arr, x) => {
    for (let i = 0; i < len; i++) {
      const y = y0 + i
      arr[i] = Math.abs(g[(y + 1) * w + x] - g[y * w + x]) >= edgeT ? 1 : 0
    }
  }
  fill(prev, x0)
  let sum = 0
  let cnt = 0
  for (let x = x0 + 1; x <= x1; x++) {
    fill(cur, x)
    const d = bestShift(prev, cur, len, 4)
    if (d !== null) {
      sum += d
      cnt++
    }
    prev.set(cur)
  }
  if (cnt < 4) return null
  return sum / cnt
}

/**
 * Measure the stripes' tilt and how axis-aligned their edges are.
 *
 * WHY NOT A GRADIENT-ORIENTATION HISTOGRAM (the obvious approach): rasterising
 * a shallow slope makes the vertical gradient SPARSE — the boundary shifts one
 * pixel every N rows, so `dy` is zero almost everywhere while `dx` is strong at
 * every transition. The histogram therefore collapses onto "horizontal" and
 * reports ~0° tilt for a card genuinely held at 11°. Measuring the shift
 * BETWEEN rows instead reads the geometry directly and is also cheap.
 *
 * The row/column choice decides which axis the bars run along: bars near
 * vertical shift between ROWS, bars near horizontal shift between COLUMNS.
 *
 * @returns {{angle:number, axis:number}} `angle` = bar tilt from vertical (−90, 90]
 */
function measureOrientation(g, w, h, box, edgeT) {
  const x0 = Math.max(0, box.x)
  const y0 = Math.max(0, box.y)
  const x1 = Math.min(w - 2, box.x + box.width - 1)
  const y1 = Math.min(h - 2, box.y + box.height - 1)
  if (x1 - x0 < 6 || y1 - y0 < 6) return { angle: 0, axis: 0.5 }

  let hE = 0
  let vE = 0
  for (let y = y0; y <= y1; y++) {
    const row = y * w
    const next = (y + 1) * w
    for (let x = x0; x <= x1; x++) {
      if (Math.abs(g[row + x + 1] - g[row + x]) >= edgeT) hE++
      if (Math.abs(g[next + x] - g[row + x]) >= edgeT) vE++
    }
  }
  const aniso = hE + vE > 0 ? Math.abs(hE - vE) / (hE + vE + 1) : 0
  // ANISOTROPY, not "horizontal-ness": a barcode held at 90° has every edge
  // running the OTHER way, so scoring raw horizontal-ness would mark a
  // perfectly good rotated barcode untrustworthy — exactly backwards.
  const axis = 0.5 + 0.5 * aniso

  const horizontalBars = vE > hE
  const tilt = horizontalBars
    ? colTilt(g, w, x0, x1, y0, y1, edgeT)
    : rowTilt(g, w, x0, x1, y0, y1, edgeT)

  let angle
  if (tilt === null) {
    angle = horizontalBars ? 90 : 0
  } else if (horizontalBars) {
    // Bars ≈ (1, m): signed angle from the vertical axis.
    angle = normAngle((Math.atan2(-1, tilt) * 180) / Math.PI)
  } else {
    // Bars ≈ (−s, 1) where s = −(row-to-row shift).
    angle = normAngle((Math.atan(-tilt) * 180) / Math.PI)
  }
  return { angle, axis }
}

function clamp01(v) {
  if (!Number.isFinite(v)) return 0
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** Transpose (swap rows/cols) — used once, only when the primary pass missed. */
function transpose(src, w, h) {
  const out = new Uint8ClampedArray(w * h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) out[x * h + y] = src[row + x]
  }
  return out
}

/**
 * Score one candidate box: orientation, rotation and confidence.
 * Returns null when it does not clear the trust floor (an expected outcome).
 */
function scoreBox(gray, w, h, box, edgeT, minConfidence) {
  const { angle, axis } = measureOrientation(gray, w, h, box, edgeT)
  const rotation = Math.abs(angle) > 45 ? 90 : 0
  // Prominence: how far the stripe band stands out from the rows it excluded.
  const prominence =
    box.outsideMean === null ? 0.4 : clamp01((box.peak - box.outsideMean) / (box.peak + 1))
  const density = clamp01(box.edgesPerRow / 40)
  // Missing metadata (e.g. a hand-built box) must degrade to 0, not NaN —
  // NaN would fail EVERY confidence comparison and silently reject good boxes.
  const regularity = Number.isFinite(box.regularity) ? box.regularity : 0
  // Multiplicative so weak spacing regularity (text, clutter) can drag an
  // otherwise strong signal below the floor — additive weights let text through.
  const confidence = clamp01(
    (0.6 * prominence + 0.4 * axis) * (0.35 + 0.65 * regularity) * (0.7 + 0.3 * density),
  )
  if (!(confidence >= minConfidence)) return null
  return {
    angle: Number.isFinite(angle) ? Number(angle.toFixed(1)) : 0,
    rotation,
    confidence: Number(confidence.toFixed(3)),
  }
}

/**
 * Locate a barcode, or return null.
 *
 * @param {Uint8ClampedArray|Uint8Array} gray one byte per pixel
 * @param {number} width
 * @param {number} height
 * @param {{minConfidence?:number}} [opts]
 * @returns {{x:number,y:number,width:number,height:number,angle:number,rotation:number,confidence:number}|null}
 *   `x,y` = top-left of the box in the buffer's own coordinates;
 *   `angle` = stripe tilt from vertical in degrees (−90, 90];
 *   `rotation` = nearest multiple of 90 (0 or 90) to rotate by so bars go vertical;
 *   `confidence` = 0..1. `null` ⇒ decode the whole frame.
 */
export function locateBarcode(gray, width, height, opts = {}) {
  if (!gray || !Number.isFinite(width) || !Number.isFinite(height)) return null
  const w = Math.trunc(width)
  const h = Math.trunc(height)
  if (w < MIN_BUFFER || h < MIN_BUFFER || gray.length < w * h) return null
  const minConfidence = opts.minConfidence ?? 0.5

  const edgeT = edgeFloor(gray, w, h)
  const trans = transpose(gray, w, h)

  let box = analyze(gray, w, h, edgeT)
  let flipped = false
  if (!box) {
    const t = analyze(trans, h, w, edgeT)
    if (!t) return null
    box = { ...t, x: t.y, y: t.x, width: t.height, height: t.width } // keep regularity/peak/etc
    flipped = true
  }

  let scored = scoreBox(gray, w, h, box, edgeT, minConfidence)
  if (!scored && !flipped) {
    // The primary pass produced a box that does not clear the trust floor —
    // the classic signature of a HORIZONTAL barcode, whose card edges look
    // like a plausible-but-wrong box. Retry transposed before giving up.
    const t = analyze(trans, h, w, edgeT)
    if (t) {
      // `flipped` is deliberately NOT reassigned here: it is only ever read to
      // decide whether the PRIMARY pass already used the transposed view.
      box = { ...t, x: t.y, y: t.x, width: t.height, height: t.width } // keep regularity/peak/etc
      scored = scoreBox(gray, w, h, box, edgeT, minConfidence)
    }
  }
  if (!scored) return null

  return {
    x: Math.max(0, Math.round(box.x)),
    y: Math.max(0, Math.round(box.y)),
    width: Math.round(box.width),
    height: Math.round(box.height),
    angle: scored.angle,
    rotation: scored.rotation,
    confidence: scored.confidence,
  }
}

/**
 * Clamp a box to the buffer; null when null, malformed or below MIN_BOX_SPAN.
 *
 * @param {{x:number,y:number,width:number,height:number}|null} box
 * @param {number} width
 * @param {number} height
 */
export function clampBoxTo(box, width, height) {
  if (!box || !Number.isFinite(width) || !Number.isFinite(height)) return null
  // Math.max/min propagate NaN, so a malformed coordinate would otherwise sail
  // straight through and hand the caller a NaN box.
  const bx = Number(box.x)
  const by = Number(box.y)
  const bw = Number(box.width)
  const bh = Number(box.height)
  if (!Number.isFinite(bx) || !Number.isFinite(by) || !Number.isFinite(bw) || !Number.isFinite(bh)) {
    return null
  }
  const w = Math.trunc(width)
  const h = Math.trunc(height)
  const x0 = Math.max(0, Math.min(w - 1, Math.round(bx)))
  const y0 = Math.max(0, Math.min(h - 1, Math.round(by)))
  const x1 = Math.max(0, Math.min(w, x0 + Math.round(bw)))
  const y1 = Math.max(0, Math.min(h, y0 + Math.round(bh)))
  const nw = x1 - x0
  const nh = y1 - y0
  if (nw < MIN_BOX_SPAN || nh < MIN_BOX_SPAN) return null
  return { x: x0, y: y0, width: nw, height: nh }
}

/**
 * Grow a box by `amount` px per side, clamped to the buffer.
 *
 * WHY PADDING MATTERS: a barcode needs a quiet zone of light around it. A
 * razor-tight crop can hand the decoder a box whose outermost bar abuts the
 * edge of the crop, and decode success then FALLS — which would make this
 * module able to hurt the very thing it is meant to help.
 *
 * @param {{x:number,y:number,width:number,height:number}|null} box
 * @param {number} amount
 * @param {number} width
 * @param {number} height
 */
export function padBox(box, amount, width, height) {
  if (!box || !Number.isFinite(width) || !Number.isFinite(height)) return null
  const pad = Math.max(0, Math.round(amount) || 0)
  return clampBoxTo(
    {
      x: (Number(box.x) || 0) - pad,
      y: (Number(box.y) || 0) - pad,
      width: (Number(box.width) || 0) + pad * 2,
      height: (Number(box.height) || 0) + pad * 2,
    },
    width,
    height,
  )
}
