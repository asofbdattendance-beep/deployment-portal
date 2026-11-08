/**
 * deviceCapabilities.js — scanner capability probe + adaptive performance tiers.
 *
 * WHY THIS EXISTS. Real badges are held tilted, glossy and at varying distance,
 * and they have to read on everything from a low-end Android to a flagship. The
 * old scanner had exactly one adaptive knob: a 3-frame decode-time profile that
 * picked cadence (`fast|medium|slow`) — resolution, how many orientations were
 * tried, and whether perspective correction ran were all fixed for every
 * device. A phone that could afford nothing still paid the heaviest cost, and a
 * flagship was capped at a budget it could blow past a hundred times over.
 *
 * This module is the single source of truth for "how much work may this device
 * do per frame, and how hard should the decoder push when it misses?"
 *
 * DESIGN CONTRACT
 *  1. PURE FIRST. `scannerTierFromSignals` and `budgetForTier` are pure functions
 *     of plain numbers, so every tier decision is unit-testable in node with no
 *     camera present. The guarded probes (`probeRuntimeCapabilities`) are the
 *     only part that touches `navigator`/DOM, and they never throw — a missing
 *     API returns `null`, never an exception, because this runs during a live
 *     preview where a thrown probe would kill the scan loop.
 *  2. CAPABILITY, NOT USER-AGENT. Tiers come from measured capability
 *     (cores, device memory, real decode timing) rather than UA sniffing,
 *     matching the repo-wide convention in `mobile.js`.
 *  3. BUDGETS ONLY *SEED* THE TIER. `BarcodeScanner` runs a runtime watchdog on
 *     top of this (rolling frame-time) so a device that hot-throttles still
 *     downshifts, and a cool flagship can upshift — a static tier is the floor,
 *     never the ceiling, of the adaptation.
 *  4. iOS SAFARI. `ImageCapture`, `pointsOfInterest` and often `focusMode` are
 *     absent there. Budgets still apply, but every feature that needs them is
 *     expressed as an optional capability so the consumer degrades to no-op
 *     instead of failing.
 *
 * Format lists are intentionally tiered too: the hard path on a low tier reads
 * only the formats our badges actually use (Code 39/128/93/Codabar/EAN), while
 * mid/high tiers add ITF + UPC and, only on the hard path, the 2D symbologies —
 * because every extra symbology the decoder attempts costs frame time.
 */

// ─── Tier definitions ─────────────────────────────────────────────────────────

/** Ordered weakest → strongest. The order matters: downshift walks backwards. */
export const SCANNER_TIERS = ['low', 'mid', 'high']

/** The formats every tier always enables. These are the real badge symbologies. */
export const BASE_1D_FORMATS = ['code_39', 'code_128', 'code_93', 'codabar', 'ean_13', 'ean_8']

/** Added from `mid` up: wider 1D coverage, still cheap to attempt. */
export const EXTENDED_1D_FORMATS = ['itf', 'upc_a', 'upc_e']

/** Only ever attempted on the HARD path of a `high` tier device. */
export const HARD_PATH_2D_FORMATS = ['data_matrix', 'pdf417', 'qr_code']

/**
 * Per-tier decode budget. Kept as a plain object so the whole adaptivity
 * contract is readable at a glance and cheap to snapshot into tests.
 *
 * `maxFrameMs` is the rolling frame-time ceiling the runtime watchdog enforces —
 * exceeding it downshifts (decked: drop deskew → drop rotations → lower width),
 * staying under it for a sustained window allows an upshift.
 */
export const SCANNER_TIER_BUDGETS = {
  low: {
    detectMaxWidth: 640,
    frameSkip: 2,
    minInterval: 200,
    maxInterval: 500,
    confirmWindow: 3,
    confirmThreshold: 2,
    /** Rotate attempts (0° + 180° only — the cheap ones). */
    maxAngles: 2,
    allowDeskew: false,
    stripCount: 1,
    quadrants: false,
    allowInverted: false,
    allowDualEngine: false,
    stillAfterMs: 2500,
    maxFrameMs: 40,
    formats: [...BASE_1D_FORMATS],
    hardPathFormats: [...BASE_1D_FORMATS],
  },
  mid: {
    detectMaxWidth: 960,
    frameSkip: 1,
    minInterval: 100,
    maxInterval: 300,
    confirmWindow: 4,
    confirmThreshold: 2,
    maxAngles: 4,
    allowDeskew: true,
    stripCount: 2,
    quadrants: false,
    allowInverted: true,
    allowDualEngine: true,
    stillAfterMs: 3000,
    maxFrameMs: 60,
    formats: [...BASE_1D_FORMATS, ...EXTENDED_1D_FORMATS],
    hardPathFormats: [...BASE_1D_FORMATS, ...EXTENDED_1D_FORMATS],
  },
  high: {
    detectMaxWidth: 1280,
    frameSkip: 0,
    minInterval: 50,
    maxInterval: 150,
    confirmWindow: 3,
    confirmThreshold: 2,
    maxAngles: 4,
    allowDeskew: true,
    stripCount: 3,
    quadrants: true,
    allowInverted: true,
    allowDualEngine: true,
    stillAfterMs: 3500,
    maxFrameMs: 80,
    formats: [...BASE_1D_FORMATS, ...EXTENDED_1D_FORMATS],
    hardPathFormats: [...BASE_1D_FORMATS, ...EXTENDED_1D_FORMATS, ...HARD_PATH_2D_FORMATS],
  },
}

// ─── Pure tier selection ──────────────────────────────────────────────────────

/** Cores/mem thresholds. Exported so tests document the exact cut-offs. */
export const TIER_SIGNALS = {
  HIGH_CORES: 8,
  HIGH_MEM_GB: 8,
  LOW_CORES: 4,
  LOW_MEM_GB: 2,
  /** Average single-pass decode time (ms) at which a device is considered slow. */
  SLOW_DECODE_MS: 120,
  /** ...and fast. */
  FAST_DECODE_MS: 30,
}

function clampTier(name) {
  return SCANNER_TIERS.includes(name) ? name : 'low'
}

/**
 * Decide a tier from measured signals. Pure and total: any `null`/`undefined`
 * signal is simply ignored rather than treated as a failure, so a browser that
 * refuses to expose `deviceMemory` (Safari does) still lands on a sane tier
 * from its core count or decode timing.
 *
 * Precedence: measured decode timing beats static signals. A device that
 * self-reports as strong but decodes a frame in 300ms IS slow for our purposes.
 *
 * @param {{cores?: number|null, memory?: number|null, avgDecodeMs?: number|null}} signals
 * @returns {'low'|'mid'|'high'}
 */
export function scannerTierFromSignals({ cores = null, memory = null, avgDecodeMs = null } = {}) {
  const slow = Number.isFinite(avgDecodeMs) && avgDecodeMs > TIER_SIGNALS.SLOW_DECODE_MS
  const fast = Number.isFinite(avgDecodeMs) && avgDecodeMs < TIER_SIGNALS.FAST_DECODE_MS

  // A measured slow decode is the strongest possible evidence — trust it over
  // any static signal a vendor has filled in optimistically.
  if (slow) return 'low'
  if (fast) return 'high'

  const strongCores = Number.isFinite(cores) && cores >= TIER_SIGNALS.HIGH_CORES
  const strongMem = Number.isFinite(memory) && memory >= TIER_SIGNALS.HIGH_MEM_GB
  const weakCores = Number.isFinite(cores) && cores <= TIER_SIGNALS.LOW_CORES
  const weakMem = Number.isFinite(memory) && memory <= TIER_SIGNALS.LOW_MEM_GB

  if (strongCores && strongMem) return 'high'
  // Two weak signals outrank one strong one: a dual-core 1GB phone with a
  // modern SoC is still the phone that drops frames.
  if (weakCores && weakMem) return 'low'
  if (weakCores || weakMem) return 'low'

  return 'mid'
}

/**
 * Resolve the decode budget for a tier, always returning a complete object.
 *
 * @param {'low'|'mid'|'high'} tier
 * @returns {typeof SCANNER_TIER_BUDGETS.low}
 */
export function budgetForTier(tier) {
  const key = SCANNER_TIER_BUDGETS[tier] ? tier : 'low'
  const b = SCANNER_TIER_BUDGETS[key]
  // Shallow copy is NOT enough: `formats`/`hardPathFormats` are arrays, and a
  // shared reference would let one consumer's `push()` leak into every other
  // consumer (and into the module constant itself). Arrays are cloned too.
  return { ...b, formats: [...b.formats], hardPathFormats: [...b.hardPathFormats] }
}

/**
 * The tier immediately above/below `tier`, or `null` at the ends. The runtime
 * watchdog walks these instead of indexing `SCANNER_TIERS` inline so tier
 * ordering has one owner.
 *
 * @param {'low'|'mid'|'high'} tier
 * @param {1|-1} direction — 1 = upshift, -1 = downshift
 * @returns {'low'|'mid'|'high'|null}
 */
export function adjacentTier(tier, direction) {
  const i = SCANNER_TIERS.indexOf(clampTier(tier))
  const next = i + Number(direction)
  if (next < 0 || next >= SCANNER_TIERS.length) return null
  return SCANNER_TIER_BUDGETS[SCANNER_TIERS[next]] ? SCANNER_TIERS[next] : null
}

// ─── Capability probing (guarded, never throws) ───────────────────────────────

/**
 * Capability snapshot shape. Every field nullable — Safari/iOS omit several.
 * @typedef {Object} ScannerCapabilities
 * @property {boolean} barcodeDetector
 * @property {string[]} supportedFormats
 * @property {boolean} imageCapture
 * @property {boolean} continuousFocus
 * @property {boolean} manualFocus
 * @property {boolean} pointsOfInterest
 * @property {boolean} zoom
 * @property {boolean} torch
 * @property {number|null} cores
 * @property {number|null} memory
 */

/**
 * Build the capability snapshot from already-known facts (pure — used directly
 * by tests and by the runtime probe below).
 *
 * @param {object} input
 * @returns {ScannerCapabilities}
 */
export function capabilitiesFrom({
  barcodeDetector = false,
  supportedFormats = [],
  imageCapture = false,
  focusModes = [],
  pointsOfInterest = false,
  hasZoom = false,
  torch = false,
  cores = null,
  memory = null,
} = {}) {
  const modes = Array.isArray(focusModes) ? focusModes : []
  return {
    barcodeDetector: !!barcodeDetector,
    supportedFormats: Array.isArray(supportedFormats) ? [...supportedFormats] : [],
    imageCapture: !!imageCapture,
    continuousFocus: modes.includes('continuous'),
    manualFocus: modes.includes('manual'),
    pointsOfInterest: !!pointsOfInterest,
    zoom: !!hasZoom,
    torch: !!torch,
    cores: Number.isFinite(cores) ? cores : null,
    memory: Number.isFinite(memory) ? memory : null,
  }
}

/** Safe core count. Safari/iOS return nothing — hence the null default. */
export function readCoreCount(nav = typeof navigator !== 'undefined' ? navigator : null) {
  try {
    const c = nav?.hardwareConcurrency
    return Number.isFinite(c) && c > 0 ? c : null
  } catch { return null }
}

/** Safe device memory in GB. */
export function readMemoryGB(nav = typeof navigator !== 'undefined' ? navigator : null) {
  try {
    const m = nav?.deviceMemory
    return Number.isFinite(m) && m > 0 ? m : null
  } catch { return null }
}

/**
 * Probe everything the runtime can tell us about itself. NEVER throws: each
 * capability is independently wrapped so one hostile WebView refusing
 * `getCapabilities()` cannot take out the rest of the snapshot.
 *
 * Only `supportedFormats` is async (BarcodeDetector exposes it as a promise).
 *
 * @param {{track?: MediaStreamTrack|null, withFormats?: boolean}} [opts]
 * @returns {Promise<ScannerCapabilities>}
 */
export async function probeRuntimeCapabilities({ track = null, withFormats = true } = {}) {
  const hasDetector = typeof window !== 'undefined' && 'BarcodeDetector' in window
  let supportedFormats = []
  if (withFormats && hasDetector) {
    try {
      const list = await window.BarcodeDetector.getSupportedFormats?.()
      if (Array.isArray(list)) supportedFormats = list
    } catch { supportedFormats = [] }
  }

  let focusModes = []
  let pointsOfInterest = false
  let hasZoom = false
  let torch = false
  try {
    const caps = track?.getCapabilities?.() || {}
    focusModes = Array.isArray(caps.focusMode) ? caps.focusMode : []
    pointsOfInterest = Array.isArray(caps.pointsOfInterest) || !!caps.pointsOfInterest
    hasZoom = !!caps.zoom
    torch = !!caps.torch
  } catch { /* capability probes must never throw */ }

  return capabilitiesFrom({
    barcodeDetector: hasDetector,
    supportedFormats,
    imageCapture: typeof ImageCapture !== 'undefined',
    focusModes,
    pointsOfInterest,
    hasZoom,
    torch,
    cores: readCoreCount(),
    memory: readMemoryGB(),
  })
}

/**
 * Decide the initial tier from a capability snapshot. Static signals only —
 * real decode timing refines this later in `BarcodeScanner`.
 *
 * @param {ScannerCapabilities} caps
 * @returns {'low'|'mid'|'high'}
 */
export function tierFromCapabilities(caps) {
  if (!caps) return 'mid'
  return scannerTierFromSignals({ cores: caps.cores, memory: caps.memory })
}
