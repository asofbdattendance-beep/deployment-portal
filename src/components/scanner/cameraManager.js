/**
 * cameraManager.js — the single owner of the camera stream.
 *
 * Design contract (this module exists to make it impossible to get wrong):
 *
 *  1. SINGLE WRITER. Exactly one stream is "active" at a time. `openCamera()`
 *     adopts an existing live stream rather than opening a second camera, and
 *     `stopStream()` is the ONLY teardown path. Nothing else in the app may
 *     call `track.stop()` directly — that is what used to freeze the preview
 *     black (a stale caller stopping the stream a newer caller had adopted).
 *  2. BORROW, DON'T STEAL. A caller that loses ownership must not tear the
 *     stream down; it just walks away. Teardown is explicit (`stopStream`).
 *  3. REAR CAMERA FIRST. Enumerate devices and ask for the back camera by exact
 *     id — `facingMode: 'environment'` silently resolves to the selfie camera
 *     on plenty of low-end Android devices, which looks like a dead preview.
 *  4. CAPABILITY PROBES NEVER THROW. Torch/focus/zoom differ wildly across
 *     Safari, Samsung Internet, Chrome and WebViews, so every probe degrades to
 *     a boolean instead of propagating an exception into the render loop.
 *  5. MISS-DRIVEN FOCUS, NOT TIMER-DRIVEN. Decode misses — not a wall clock —
 *     drive focus recovery: `focusHunt` re-asserts continuous AF first, then
 *     escalates to a manual-near nudge on a growing backoff, and
 *     `zoomRampForMisses` trades a little magnification for decode size,
 *     gently, because zoom amplifies focus hunting as much as it helps.
 *     A device that exposes no focus capability (iOS Safari commonly exposes
 *     neither `focusMode` nor `focusDistance`) gets a clean no-op, never a
 *     throw.
 */

/* ─── Platform detection ────────────────────────────────────────────────────── */

/**
 * Classify the browser from its UA. Pure so it can be tested per device.
 *
 * iPadOS 13+ Safari defaults to "Request Desktop Website" and sends a plain
 * Macintosh UA, so a UA-only check classes every modern iPad as a Mac — it
 * then gets the wrong permission hint. A Mac never reports touch points, an
 * iPad does, which is the standard way to tell them apart.
 *
 * @param {string} ua
 * @param {number} [maxTouchPoints]
 */
export function detectPlatform(ua, maxTouchPoints = 0) {
  const s = String(ua || '')
  const isIPadDesktop = /Macintosh/.test(s) && Number(maxTouchPoints) > 1
  const isIOS = /iPad|iPhone|iPod/.test(s) || isIPadDesktop
  return {
    isIOS,
    isSafari: /^((?!chrome|android).)*safari/i.test(s),
    isChrome: /chrome|chromium|crios/i.test(s) && !/edge|edg/i.test(s),
    isFirefox: /firefox|fxios/i.test(s),
    isSamsung: /samsungbrowser/i.test(s),
    isAndroid: /android/i.test(s),
    isMobile: isIOS || /android|iphone|ipad|ipod|mobile/i.test(s),
  }
}

export const platform = typeof navigator !== 'undefined'
  ? detectPlatform(navigator.userAgent, navigator.maxTouchPoints)
  : detectPlatform('')

// ─── Resolution Chain ─────────────────────────────────────────────────────────
// Progressive fallback: start high, drop down if the camera can't handle it.
// Starts at 1080p: phones deliver portrait frames, so a 720p stream is only 720
// px across the badge — ~1.5 px per Code 39 bar at a normal holding distance,
// where a slightly soft focus already drops ZXing to 5–40% reads (it needs
// ~2 px/bar). 1080 px across gives that margin back. Decode cost is bounded by
// the per-profile detect width in BarcodeScanner, not by the stream size.

const RESOLUTION_CHAIN = [
  { width: { ideal: 1920 }, height: { ideal: 1080 } },
  { width: { ideal: 1280 }, height: { ideal: 720 } },
  { width: { ideal: 720 }, height: { ideal: 540 } },
  { width: { ideal: 640 }, height: { ideal: 480 } },
  { width: { ideal: 480 }, height: { ideal: 360 } },
]

const REAR_LABEL = /(back|rear|environment|world|camera2?\s*0)/i

/** Narrow, defensive reads — several of these throw on odd WebViews. */
function safeCall(fn, fallback = undefined) {
  try { return fn() } catch { return fallback }
}

function videoTrackOf(stream) {
  return safeCall(() => stream?.getVideoTracks?.()[0], null) || null
}

/* ─── Module-level ownership ────────────────────────────────────────────────── */

let _active = null          // { stream, track, torchSupported, deviceId }
let _openingPromise = null
// Incremented by cancelPendingOpen(); compared to the value captured when an
// open began, so a stream from an abandoned attempt is stopped, not adopted.
let _abandonedOpens = 0

/** The stream this module currently owns, or null. */
export function getActiveStream() {
  return _active?.stream || null
}

/** True while the stream still has a live video track. */
export function isStreamLive(stream) {
  const track = videoTrackOf(stream)
  return !!track && track.readyState === 'live'
}

/**
 * The ONLY teardown path. Idempotent, and never touches a stream it does not own
 * beyond stopping that stream's own tracks.
 * @param {MediaStream|null} stream
 */
export function stopStream(stream) {
  if (!stream) return
  safeCall(() => stream.getTracks?.().forEach(t => t.stop()))
  if (_active?.stream === stream) _active = null
}

/* ─── Device selection & ranking ────────────────────────────────────────────── */

/**
 * Score a camera device based on label signals to prioritize the primary (1x)
 * autofocus camera over ultra-wide, macro, depth, or telephoto lenses.
 *
 * Many multi-camera Android devices (e.g. OnePlus, Oppo, Realme, Samsung) expose
 * the ultra-wide (0.6x) or fixed-focus macro lens as the first rear device.
 * Those lenses have heavy distortion, tiny barcodes at normal 15-25cm distance,
 * and lack autofocus, preventing reliable scanning.
 *
 * @param {MediaDeviceInfo} device
 * @param {number} [index]
 * @returns {number}
 */
export function scoreRearCamera(device, index = 0) {
  const label = String(device?.label || '').toLowerCase()
  let score = 100 - index // slight preference for earlier index if unlabelled

  // Penalize lenses that fail on 1D barcodes at standard distance
  if (/(ultra[- ]?wide|0\.[56]x)/i.test(label)) score -= 80
  if (/macro/i.test(label)) score -= 90
  if (/(depth|tof|bokeh|virtual)/i.test(label)) score -= 85
  if (/(tele|telephoto|periscope|zoom|[2-9]x|10x)/i.test(label)) score -= 50

  // Boost primary 1x autofocus camera
  if (/(main|primary|standard)/i.test(label)) score += 60
  if (/\b1x\b|\b1\.0x\b/i.test(label)) score += 50
  if (/wide/i.test(label) && !/ultra/i.test(label)) score += 30
  if (/(back|rear).*0\b/i.test(label) || /camera2?\s*0\b/i.test(label)) score += 15

  return score
}

/**
 * Enumerate all available rear cameras sorted by quality score.
 *
 * @returns {Promise<Array<MediaDeviceInfo & { score: number }>>}
 */
export async function getRearCameraList() {
  try {
    const devices = await navigator.mediaDevices?.enumerateDevices?.()
    if (!Array.isArray(devices) || !devices.length) return []
    const cams = devices.filter(d => d.kind === 'videoinput')
    if (!cams.length) return []

    // No labels yet (before permission). We cannot tell front from back, and
    // Firefox lists real deviceIds here with the selfie camera often first, so
    // pinning cams[0] by exact id opened the FRONT camera. Return nothing and
    // let the caller fall back to facingMode: 'environment', which every
    // browser resolves to the rear camera.
    const labeled = cams.filter(d => d.label)
    if (!labeled.length) return []

    const rearCams = labeled.filter(d => REAR_LABEL.test(d.label))
    if (!rearCams.length) return []

    return rearCams
      .map((d, i) => ({ ...d, score: scoreRearCamera(d, i) }))
      .sort((a, b) => b.score - a.score)
  } catch {
    return []
  }
}

/**
 * Find the rear camera's deviceId, preferring the primary autofocus lens.
 *
 * Labels are only populated once camera permission has been granted, so a first
 * call can legitimately return null — the caller then falls back to `facingMode`.
 *
 * @param {{preferredDeviceId?: string|null, excludeDeviceId?: string|null}|string} [opts]
 * @returns {Promise<string|null>}
 */
export async function pickRearDeviceId(opts = {}) {
  const { preferredDeviceId = null, excludeDeviceId = null } =
    (typeof opts === 'string' ? { preferredDeviceId: opts } : opts)
  try {
    const list = await getRearCameraList()
    if (!list.length) return null

    if (preferredDeviceId) {
      const match = list.find(d => d.deviceId === preferredDeviceId)
      if (match) return match.deviceId
    }

    const filtered = excludeDeviceId ? list.filter(d => d.deviceId !== excludeDeviceId) : list
    const pick = filtered[0] || list[0]
    return pick?.deviceId || null
  } catch {
    return null
  }
}

/**
 * Abandon an in-flight open so its result is never adopted.
 *
 * `getUserMedia` cannot be cancelled, so this does not stop the pending
 * permission prompt — it marks the attempt stale so that when it does resolve,
 * the freshly-created stream is immediately stopped instead of being handed to
 * a component that has already torn down (which would leave the camera LED on
 * with nothing using it).
 *
 * @returns {boolean} true if an in-flight attempt was abandoned
 */
/**
 * True only for OUR cancellation (cancelPendingOpen). A getUserMedia
 * AbortError is a real hardware failure (Firefox "Starting videoinput
 * failed", a camera grabbed by another app) and must reach the user as an
 * error with Retry — matching on `name` alone hid it behind an endless spinner.
 * @param {unknown} err
 */
export function isAbandonedOpen(err) {
  return !!(err && typeof err === 'object' && err.abandoned === true)
}

export function cancelPendingOpen() {
  if (!_openingPromise) return false
  _openingPromise = null
  _abandonedOpens++
  return true
}

/* ─── Capability probes ─────────────────────────────────────────────────────── */

/**
 * Does this track have a usable torch?
 *
 * Safari (and some Android WebViews) omit `torch` from `getCapabilities()` but
 * still honour it through `applyConstraints`, so an advertised capability is
 * not required — we probe and read the setting back, then restore torch off so
 * a successful probe never lights up the camera unexpectedly.
 *
 * @param {MediaStreamTrack|null} track
 * @returns {Promise<boolean>}
 */
export async function probeTorch(track) {
  if (!track) return false
  const caps = safeCall(() => track.getCapabilities?.(), {}) || {}
  if (caps.torch) return true
  try {
    await track.applyConstraints({ advanced: [{ torch: true }] })
    const settings = safeCall(() => track.getSettings?.(), {}) || {}
    const nowCaps = safeCall(() => track.getCapabilities?.(), {}) || {}
    const supported = !!settings.torch || !!nowCaps.torch
    if (supported) {
      try { await track.applyConstraints({ advanced: [{ torch: false }] }) } catch { /* ignore */ }
    }
    return !!supported
  } catch {
    return false
  }
}

/**
 * Turn the torch on/off. Returns whether the change actually took, so the UI
 * never shows an "ON" pill the hardware rejected.
 * @returns {Promise<boolean>}
 */
export async function toggleTorch(track, on) {
  if (!track) return false
  try {
    await track.applyConstraints({ advanced: [{ torch: on }] })
    return true
  } catch {
    return false
  }
}

/* ─── Focus ─────────────────────────────────────────────────────────────────── */

/**
 * Some firmwares (OnePlus/OxygenOS, ColorOS, a few Samsungs) honour `ideal`
 * resolution constraints very loosely: you ask for 1920x1080 and get 640x480
 * with no error at all, so the resolution ladder in `openCameraInner` never
 * escalates — it only advances on a THROWN error. Code 39 needs about 2 px per
 * narrow module to survive soft focus, and a 640-wide stream cannot reach that
 * at arm's length, which is exactly the "works on most phones, not this one"
 * signature.
 *
 * So after the stream opens, check what we ACTUALLY got and re-ask using the
 * track's own capability maximum. `ideal` is used rather than `min` because a
 * hard `min` throws OverconstrainedError on firmwares that misreport caps, and
 * a failed re-ask must never cost us the working stream we already have.
 *
 * Never throws. Returns what happened so the HUD can show it.
 *
 * @param {MediaStreamTrack} track
 * @param {{minWidth?: number, requested?: number, debug?: boolean}} [opts]
 * @returns {Promise<{applied:boolean, from:number|null, to:number|null, capped?:number}>}
 */
export async function ensureUsableResolution(track, opts = {}) {
  const { minWidth = 1280, requested = 1920, debug = false } = opts
  const noop = (from) => ({ applied: false, from, to: from })
  if (!track || typeof track.getSettings !== 'function' || typeof track.applyConstraints !== 'function') {
    return noop(null)
  }
  const read = () => { try { return track.getSettings() || {} } catch { return {} } }
  const before = read()
  const fromW = Number(before.width) || 0
  const fromH = Number(before.height) || 0
  const maxDim = Math.max(fromW, fromH)
  const minDim = Math.min(fromW, fromH)

  // Already usable in either landscape (fromW >= minWidth) or portrait (maxDim >= minWidth && minDim >= 720)
  if (fromW >= minWidth || (maxDim >= minWidth && minDim >= 720)) return noop(fromW)

  let caps
  try { caps = track.getCapabilities?.() || {} } catch { caps = {} }
  const capMax = Number(caps.width?.max) || 0
  // The sensor genuinely cannot do better — nothing to ask for.
  if (capMax && capMax < minWidth) return { ...noop(fromW), capped: capMax }

  const targetW = Math.min(capMax || requested, requested)
  if (targetW <= fromW) return noop(fromW)

  // Keep the delivered aspect ratio: re-asking 1920x1080 on a 4:3 stream
  // letters out or gets rejected on some firmwares.
  const ar = fromW && Number(before.height) ? Number(before.height) / fromW : 3 / 4
  const capH = Number(caps.height?.max) || 0
  let targetH = Math.max(1, Math.round(targetW * ar))
  if (capH) targetH = Math.min(targetH, capH)

  try {
    await track.applyConstraints({ width: { ideal: targetW }, height: { ideal: targetH } })
  } catch {
    return noop(fromW)
  }

  const afterW = Number(read().width) || 0
  const applied = afterW > fromW
  if (debug) {
    console.log(`[CameraMgr] resolution ${fromW}px -> ${afterW}px (asked ${targetW}x${targetH})`)
  }
  return { applied, from: fromW, to: afterW || fromW }
}

/**
 * Best-effort continuous autofocus, digital zoom and (when the caller supplies
 * a tap point) a focus region of interest.
 *
 * Must be called AFTER `video.play()` — some devices only accept advanced
 * constraints once the stream is actively rendering.
 *
 * Focus and zoom are applied in SEPARATE `applyConstraints` calls on purpose:
 * several Samsung firmwares (incl. the Galaxy Z Fold 6) reject or silently
 * ignore a combined advanced set, which used to void the autofocus request
 * along with the zoom. Flags are set only after their own call succeeds.
 *
 * @param {MediaStreamTrack} track
 * @param {{applyZoom?: boolean, point?: {x:number,y:number}|null, debug?: boolean}} [opts]
 * @returns {Promise<{focusApplied:boolean, zoomApplied:boolean, poiApplied:boolean}>}
 */
export async function applyFocusConstraints(track, opts = {}) {
  const { applyZoom = true, point = null, debug = false } = opts
  const result = { focusApplied: false, zoomApplied: false, poiApplied: false }
  if (!track) return result

  try {
    const caps = safeCall(() => track.getCapabilities?.(), {}) || {}

    // A focus region is the sharpest primitive available on Chrome/Android —
    // it beats both continuous AF and a distance guess for a small badge.
    if (point && typeof point.x === 'number' && typeof point.y === 'number') {
      if (typeof track.setPointOfInterest === 'function') {
        try {
          await track.setPointOfInterest(point.x, point.y)
          result.poiApplied = true
          if (debug) console.log(`[CameraMgr] focus ROI at (${point.x.toFixed(2)}, ${point.y.toFixed(2)})`)
        } catch { /* unsupported region */ }
      } else if (caps.pointsOfInterest) {
        focusSet.pointsOfInterest = [{ x: point.x, y: point.y }]
      }
    }

    const focusModes = Array.isArray(caps.focusMode) ? caps.focusMode : []
    const focusSet = {}
    // Some Samsung firmwares report no focusMode list at all while still
    // honouring continuous AF — request it anyway on Android rather than
    // leaving the lens at its (possibly macro-locked) default.
    if (focusModes.includes('continuous') || (platform.isAndroid && focusModes.length === 0)) {
      focusSet.focusMode = 'continuous'
    } else if (focusModes.includes('single-shot')) {
      // Some firmwares expose only single-shot/manual. Asking for nothing
      // leaves the lens wherever it booted (often macro-locked or at
      // infinity), which reads as "sharp everywhere except on the badge".
      // One single-shot cycle at start at least gets a real AF run.
      focusSet.focusMode = 'single-shot'
    }
    if (Array.isArray(caps.exposureMode) && caps.exposureMode.includes('continuous')) {
      focusSet.exposureMode = 'continuous'
    }
    if (Array.isArray(caps.whiteBalanceMode) && caps.whiteBalanceMode.includes('continuous')) {
      focusSet.whiteBalanceMode = 'continuous'
    }

    if (Object.keys(focusSet).length) {
      try {
        await track.applyConstraints({ advanced: [focusSet] })
        if (focusSet.focusMode) result.focusApplied = true
      } catch {
        // Fallback: if driver rejected combined set (OnePlus/OxygenOS/ColorOS), try focusMode independently
        if (focusSet.focusMode) {
          try {
            await track.applyConstraints({ advanced: [{ focusMode: focusSet.focusMode }] })
            result.focusApplied = true
          } catch { /* unsupported */ }
        }
      }
    }

    // Digital zoom makes the barcode larger in the frame, but it CANNOT add
    // detail — it crops the sensor. On a stream that is already narrow
    // (OxygenOS/ColorOS hand back 640x480 no matter what you ask) zooming just
    // shrinks the field of view for the same pixel budget, pushing the badge
    // closer to the px/module cliff. Only zoom when the stream is wide enough
    // that a crop still leaves detail behind. In portrait mode, height is the
    // longer dimension (1920x1080), so test the maximum dimension.
    let streamWidth = 0
    let streamHeight = 0
    try {
      const s = track.getSettings?.() || {}
      streamWidth = Number(s.width) || 0
      streamHeight = Number(s.height) || 0
    } catch { streamWidth = 0; streamHeight = 0 }
    const maxDim = Math.max(streamWidth, streamHeight)
    if (applyZoom && caps.zoom && (maxDim === 0 || maxDim >= 1280)) {
      const maxZoom = Number(caps.zoom.max) || 1
      const idealZoom = Math.min(1.25, maxZoom)
      if (idealZoom > 1) {
        try {
          await track.applyConstraints({ advanced: [{ zoom: idealZoom }] })
          result.zoomApplied = true
          if (debug) console.log(`[CameraMgr] zoom ${idealZoom}`)
        } catch { /* zoom unsupported despite caps — focus above stands */ }
      }
    }

    if (debug) console.log('[CameraMgr] focus constraints applied', result)
  } catch (e) {
    if (debug) console.warn('[CameraMgr] focus constraints failed:', e?.message)
  }

  return result
}

/**
 * Tap-to-focus.
 *
 * Prefers a point-of-interest region (Chrome/Android, accurate, no revert
 * needed). Falls back to the legacy `focusMode: 'manual'` + `focusDistance`
 * heuristic on devices that only expose distance control, and schedules a
 * revert to continuous AF.
 * On modern Android devices without manual distance (e.g. Samsung Galaxy A35),
 * triggers an active single-shot AF scan cycle and reverts to continuous AF.
 *
 * @param {MediaStreamTrack} track
 * @param {number} x — 0-1 across the video
 * @param {number} y — 0-1 down the video
 * @returns {Promise<{applied:boolean, mode:'poi'|'distance'|'single-shot'|null, cleanup:()=>void}>}
 */
export async function applyTapFocus(track, x, y) {
  if (!track) return { applied: false, mode: null, cleanup: () => {} }

  if (typeof track.setPointOfInterest === 'function') {
    try {
      await track.setPointOfInterest(x, y)
      return { applied: true, mode: 'poi', cleanup: () => {} }
    } catch { /* fall through to distance */ }
  }

  const caps = safeCall(() => track.getCapabilities?.(), {}) || {}
  const focusModes = Array.isArray(caps.focusMode) ? caps.focusMode : []

  if (focusModes.includes('manual') && caps.focusDistance) {
    try {
      const minDist = caps.focusDistance?.min || 0
      const maxDist = caps.focusDistance?.max || 10
      // Centre of frame = far subject, edges = near (rough but effective).
      const distFromCenter = Math.sqrt((x - 0.5) ** 2 + (y - 0.5) ** 2)
      const focusDist = Math.max(minDist, Math.min(maxDist, maxDist - distFromCenter * (maxDist - minDist)))

      await track.applyConstraints({ advanced: [{ focusMode: 'manual', focusDistance: focusDist }] })
      const revertTimer = setTimeout(() => {
        applyFocusConstraints(track).catch(() => {})
      }, 3000)

      return { applied: true, mode: 'distance', cleanup: () => clearTimeout(revertTimer) }
    } catch {
      return { applied: false, mode: null, cleanup: () => {} }
    }
  }

  // Devices that expose single-shot or continuous AF without manual distance
  // (e.g. Samsung Galaxy A35): trigger an active single-shot refocus cycle, then revert.
  if (focusModes.includes('single-shot') || (platform.isAndroid && focusModes.length === 0)) {
    try {
      const advanced = []
      if (caps.pointsOfInterest) {
        advanced.push({ pointsOfInterest: [{ x, y }] })
      }
      advanced.push({ focusMode: 'single-shot' })
      await track.applyConstraints({ advanced })
      const revertTimer = setTimeout(() => {
        track.applyConstraints?.({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {})
      }, 1500)
      return { applied: true, mode: 'single-shot', cleanup: () => clearTimeout(revertTimer) }
    } catch {
      return { applied: false, mode: null, cleanup: () => {} }
    }
  }

  return { applied: false, mode: null, cleanup: () => {} }
}

/* ─── Adaptive focus hunt & zoom ────────────────────────────────────────────── */

// Miss-driven focus recovery. A fixed re-assert timer cannot tell "focus is
// fine" from "the phone locked onto the background", so a hunt escalates:
// continuous AF first, then a manual-near nudge, with a growing backoff so a
// stubborn phone is nudged on a backing-off schedule, not spammed.
const FOCUS_HUNT_BASE_MS = 1000 // first re-hunt delay — short, while the operator is still waving the badge
const FOCUS_HUNT_MAX_MS = 4000  // backoff ceiling — a hunt must never become a busy loop
const FOCUS_HUNT_MAX_ATTEMPT = 5 // attempt cap: nextMs saturates at FOCUS_HUNT_MAX_MS from here on
const MANUAL_FOCUS_HOLD_MS = 1200 // how long manual-near is held before continuous AF returns

/**
 * True when continuous AF can be requested on this device.
 *
 * Mirrors `applyFocusConstraints`: an explicit `continuous` in the advertised
 * focusMode list, or — on Android — an empty list, because several Samsung
 * firmwares report no focusMode at all while still honouring continuous AF.
 * iOS Safari commonly exposes neither focusMode nor focusDistance, which is
 * exactly the case `focusHunt` must no-op on.
 */
function continuousFocusRequestable(caps) {
  const focusModes = Array.isArray(caps.focusMode) ? caps.focusMode : []
  return focusModes.includes('continuous') || (platform.isAndroid && focusModes.length === 0)
}

/**
 * One miss-driven focus hunt.
 *
 * NOT a timer — the caller invokes this when decodes keep missing and uses
 * `nextMs` to schedule the next hunt. Attempt 1 re-requests continuous AF
 * (cheap, and enough for a phone that merely dropped its AF lock). Attempt 2+
 * escalates to a brief manual-near nudge: small badges are held close to the
 * lens, so a near-biased `focusDistance` breaks a background lock that
 * continuous AF won't, then continuous AF is restored after a short hold.
 *
 * Fully guarded: a track that throws on `getCapabilities`/`applyConstraints`,
 * or advertises no usable focus capability (iOS Safari commonly exposes
 * neither `focusMode` nor `focusDistance`), yields
 * `{ mode: 'none', ok: false, nextMs }` — a clean no-op, never a throw.
 *
 * @param {MediaStreamTrack} track
 * @param {number} [attempt] — 1-based hunt number; capped so callers can't overflow
 * @param {{debug?: boolean}} [opts]
 * @returns {Promise<{mode:'continuous'|'manual'|'none', ok:boolean, nextMs:number}>}
 */
export async function focusHunt(track, attempt = 1, opts = {}) {
  const { debug = false } = opts
  const nextMs = () => {
    const n = Number.isFinite(attempt) ? Math.trunc(attempt) : 1
    const a = Math.min(Math.max(1, n), FOCUS_HUNT_MAX_ATTEMPT)
    return Math.min(FOCUS_HUNT_MAX_MS, FOCUS_HUNT_BASE_MS * a)
  }
  const none = () => ({ mode: 'none', ok: false, nextMs: nextMs() })

  if (!track) return none()

  try {
    const caps = safeCall(() => track.getCapabilities?.(), {}) || {}

    if (attempt <= 1) {
      // First hunt: re-assert continuous AF — the same reasoning as
      // applyFocusConstraints, in its own call so a firmware that rejects
      // it cannot take a zoom or focus request down with it.
      if (continuousFocusRequestable(caps)) {
        await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] })
        if (debug) console.log('[CameraMgr] focus hunt: re-asserted continuous AF')
        return { mode: 'continuous', ok: true, nextMs: nextMs() }
      }
      // Firmware that hides continuous AF but does expose single-shot: one
      // real AF cycle beats leaving the lens wherever it booted (macro-locked
      // or at infinity is exactly the "everything is sharp except the badge"
      // signature). The caller's backoff turns this into a periodic re-focus.
      const singleShot = Array.isArray(caps.focusMode) && caps.focusMode.includes('single-shot')
      if (singleShot) {
        await track.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] })
        if (debug) console.log('[CameraMgr] focus hunt: single-shot cycle')
        return { mode: 'single-shot', ok: true, nextMs: nextMs() }
      }
      return none()
    }

    // Escalation: manual focus biased NEAR, then back to continuous. Only
    // possible when the device advertises BOTH manual mode and a distance
    // range — without them there is nothing to nudge (iOS Safari).
    const focusModes = Array.isArray(caps.focusMode) ? caps.focusMode : []
    if (!focusModes.includes('manual') || !caps.focusDistance) return none()
    const minDist = Number(caps.focusDistance.min) || 0
    const maxDist = Number(caps.focusDistance.max) || 10
    const near = minDist + (maxDist - minDist) * 0.25

    await track.applyConstraints({ advanced: [{ focusMode: 'manual', focusDistance: near }] })
    // Hold manual-near briefly, then hand the lens back to continuous AF —
    // leaving it manual would strand the next badge at the wrong distance.
    setTimeout(() => {
      track.applyConstraints?.({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {})
    }, MANUAL_FOCUS_HOLD_MS)
    if (debug) console.log(`[CameraMgr] focus hunt: manual-near @ ${near}`)
    return { mode: 'manual', ok: true, nextMs: nextMs() }
  } catch {
    return none()
  }
}

/**
 * The digital zoom to request after a run of consecutive decode misses.
 *
 * WHY A RAMP: zoom makes a small barcode physically larger in the frame, which
 * genuinely helps the decoder — but it also magnifies focus hunting and
 * motion blur, so a heavy crop can cost more detections than it cures. Hence
 * gentle: hold 1.0 through the first couple of misses (most misses are angle
 * or glare, not size), then +0.25 per couple of misses, stopping at a modest
 * 1.75 cap — and never above what the device actually supports.
 *
 * Pure and total: null/undefined caps (or no zoom capability) → 1.0.
 *
 * @param {number} misses — consecutive decode misses
 * @param {{zoom?: {min: number, max: number}}} [caps]
 * @returns {number}
 */
export function zoomRampForMisses(misses, caps) {
  if (!caps || !caps.zoom) return 1.0
  const m = Number.isFinite(misses) ? Math.max(0, Math.trunc(misses)) : 0
  const ramped = m <= 2 ? 1.0 : 1 + 0.25 * Math.ceil((m - 2) / 2)
  return Math.min(Math.max(Math.min(ramped, 1.75), 1), Number(caps.zoom.max) || 1)
}

/**
 * Current digital zoom, or null when the device doesn't expose it.
 * Never throws, never NaN — null is the caller's signal to skip zoom logic.
 *
 * @param {MediaStreamTrack|null} track
 * @returns {number|null}
 */
export function getZoom(track) {
  if (!track) return null
  const settings = safeCall(() => track.getSettings?.(), null)
  const z = settings?.zoom
  return Number.isFinite(z) ? z : null
}

/**
 * Set digital zoom, clamped to what the device advertises.
 *
 * Zoom goes out in its OWN `applyConstraints` call carrying ONLY `zoom` — the
 * same Samsung-firmware reasoning as `applyFocusConstraints`: a combined
 * advanced set is rejected or silently ignored there, which would void the
 * zoom. The returned `zoom` is read back from `getSettings()` when the device
 * reports it, so the caller learns the value actually in effect; on any
 * failure it gets `{ ok: false, zoom: <current> }` and can retry later.
 *
 * @param {MediaStreamTrack} track
 * @param {number} level
 * @returns {Promise<{ok: boolean, zoom: number|null}>}
 */
export async function setZoom(track, level) {
  const current = getZoom(track)
  if (!track || !Number.isFinite(level)) return { ok: false, zoom: current }
  try {
    const caps = safeCall(() => track.getCapabilities?.(), {}) || {}
    if (!caps.zoom) return { ok: false, zoom: current }
    const min = Number(caps.zoom.min) || 1
    const max = Number(caps.zoom.max) || 1
    const clamped = Math.min(Math.max(level, min), max)
    await track.applyConstraints({ advanced: [{ zoom: clamped }] })
    const readBack = getZoom(track)
    return { ok: true, zoom: Number.isFinite(readBack) ? readBack : clamped }
  } catch {
    return { ok: false, zoom: current }
  }
}

// Mean luma (0-255) below which a frame is genuinely dark: badge contrast
// collapses well before the operator perceives the scene as "dark", so the
// threshold sits low. This gates an ACTIONABLE torch suggestion, not the
// passive "dark" hint `guidanceFor` already shows.
const DARK_LUMA_THRESHOLD = 40

/**
 * Should the UI suggest turning the torch on?
 *
 * Both conditions must hold: the frame is genuinely dark (mean luma < 40 —
 * below this, badge contrast is too poor for reliable decoding) AND the
 * device actually has a torch. Pure and total: missing/NaN inputs → false.
 * Deliberately narrower than `guidanceFor`'s 'dark' hint, which only advises;
 * this one triggers an action, so it fires only when the torch can help.
 *
 * @param {number} meanLuma — 0-255 average frame luminance
 * @param {{torch?: boolean}} [caps]
 * @returns {boolean}
 */
export function shouldSuggestTorch(meanLuma, caps) {
  if (!Number.isFinite(meanLuma) || meanLuma >= DARK_LUMA_THRESHOLD) return false
  return !!(caps && caps.torch)
}

/**
 * Drive `focusHunt` on an interval owned by the caller.
 *
 * This helper only paces hunts: the first after `interval`, then whatever
 * `focusHunt` returns as `nextMs` (which grows with the attempt count, so a
 * phone that won't focus is nudged on a backing-off schedule rather than
 * spammed). The caller owns the miss streak — stop this when a decode
 * succeeds and restart it when misses pile up.
 *
 * The returned `stop()` is idempotent and leaves this helper's own timer
 * chain dead — safe to call from an unmount path, as many times as needed.
 * (A manual-near revert timer scheduled by an in-flight `focusHunt` is that
 * function's own concern and self-clears after its hold.)
 *
 * @param {MediaStreamTrack} track
 * @param {{interval?: number, debug?: boolean}} [opts]
 * @returns {() => void} stop
 */
export function beginFocusHunt(track, opts = {}) {
  const { interval = FOCUS_HUNT_BASE_MS } = opts
  let stopped = false
  let timer = null
  let attempt = 0

  function schedule(ms) {
    if (stopped) return
    timer = setTimeout(run, ms)
  }

  async function run() {
    if (stopped) return
    attempt += 1
    try {
      const res = await focusHunt(track, attempt, opts)
      if (stopped) return
      schedule(Number.isFinite(res?.nextMs) ? res.nextMs : interval)
    } catch {
      // focusHunt is guarded and should never throw; never let the chain die.
      if (!stopped) schedule(interval)
    }
  }

  schedule(interval)

  return function stop() {
    stopped = true
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
}

/* ─── Camera opening ────────────────────────────────────────────────────────── */

/**
 * Acquire the rear camera.
 *
 * Safe to call concurrently and repeatedly: a live stream is adopted, and an
 * in-flight attempt is shared rather than duplicated. Callers that lose the
 * race MUST NOT stop the returned stream — that is the caller's job only when
 * it has actually become the owner (see `stopStream`).
 *
 * @param {{startIndex?: number, debug?: boolean}} [opts]
 * @returns {Promise<{stream: MediaStream, track: MediaStreamTrack, torchSupported: boolean, deviceId: string|null, resolutionIndex: number, adopted: boolean}>}
 */
export function openCamera(opts = {}) {
  const { preferredDeviceId = null, forceNew = false } = opts
  if (!forceNew && _active && isStreamLive(_active.stream)) {
    if (!preferredDeviceId || _active.deviceId === preferredDeviceId) {
      return Promise.resolve({ ..._active, adopted: true })
    }
  }
  if (_active) stopStream(_active.stream) // switching camera or dead stream sitting around

  if (_openingPromise) return _openingPromise

  const abandonMark = _abandonedOpens
  const attempt = openCameraInner(opts).then(
    res => {
      _openingPromise = null
      // Abandoned while in flight (component unmounted or handed the camera
      // to another tab) — reclaim the hardware instead of leaking it.
      if (_abandonedOpens !== abandonMark) {
        safeCall(() => res.stream?.getTracks?.().forEach(t => t.stop()))
        const err = new Error('Camera open was abandoned')
        err.name = 'AbortError'
        err.abandoned = true
        throw err
      }
      _active = {
        stream: res.stream,
        track: res.track,
        torchSupported: res.torchSupported,
        deviceId: res.deviceId,
      }
      return res
    },
    err => { _openingPromise = null; throw err },
  )
  _openingPromise = attempt
  return attempt
}

async function openCameraInner({ startIndex = 0, debug = false, preferredDeviceId = null } = {}) {
  // No camera API at all: plain-HTTP page (getUserMedia exists only in a
  // secure context), or an old in-app WebView. Fail once with a clear name
  // instead of walking the whole resolution chain on a TypeError.
  if (typeof navigator === 'undefined' || typeof navigator.mediaDevices?.getUserMedia !== 'function') {
    const err = new Error('Camera API unavailable in this browser')
    err.name = 'NotSupportedError'
    throw err
  }
  let deviceId = await pickRearDeviceId({ preferredDeviceId })
  const chain = RESOLUTION_CHAIN.slice(Math.max(0, startIndex))
  let lastError = null

  for (let i = 0; i < chain.length; i++) {
    const video = { ...chain[i] }
    if (deviceId) video.deviceId = { exact: deviceId }
    else video.facingMode = { ideal: 'environment' }

    try {
      if (debug) console.log(`[CameraMgr] opening res#${i} device=${deviceId || 'facingMode'}`)
      const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false })
      const track = videoTrackOf(stream)
      if (!track) {
        safeCall(() => stream.getTracks?.().forEach(t => t.stop()))
        throw new Error('Camera returned no video track')
      }
      const torchSupported = await probeTorch(track)
      // Ask once more for a usable resolution: some firmwares ignore `ideal`
      // and hand back 640x480 without throwing (see ensureUsableResolution).
      await ensureUsableResolution(track, { debug })
      const actualDeviceId = safeCall(() => track.getSettings?.().deviceId, null) || deviceId || null
      return { stream, track, torchSupported, deviceId: actualDeviceId, resolutionIndex: i, adopted: false }
    } catch (e) {
      lastError = e
      if (debug) console.warn(`[CameraMgr] res#${i} failed:`, e?.message)
      // Permission and hardware-absent are terminal — retrying changes nothing.
      if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError' || e?.name === 'NotFoundError') throw e
      // An exact deviceId that the device won't honour falls back to facingMode.
      if (deviceId && e?.name === 'OverconstrainedError') deviceId = null
    }
  }

  // Last resort: let the browser choose, no resolution or device hints at all.
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    })
    const track = videoTrackOf(stream)
    if (!track) {
      safeCall(() => stream.getTracks?.().forEach(t => t.stop()))
      throw lastError || new Error('Camera returned no video track')
    }
    const actualDeviceId = safeCall(() => track.getSettings?.().deviceId, null) || null
    return { stream, track, torchSupported: await probeTorch(track), deviceId: actualDeviceId, resolutionIndex: -1, adopted: false }
  } catch (e) {
    if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') throw e
    throw lastError || e
  }
}

/* ─── Diagnostics ───────────────────────────────────────────────────────────── */

/**
 * Snapshot of everything the on-screen debug HUD needs: what the camera can do
 * and what we actually got. Never throws.
 * @param {MediaStream|null} stream
 */
export function describeCamera(stream) {
  const track = videoTrackOf(stream)
  if (!track) return { track: false, live: false, settings: null, caps: null }
  return {
    track: true,
    live: track.readyState === 'live',
    settings: safeCall(() => track.getSettings?.(), null),
    caps: safeCall(() => {
      const c = track.getCapabilities?.() || {}
      return {
        torch: !!c.torch,
        zoom: c.zoom ? { min: c.zoom.min, max: c.zoom.max } : null,
        focusMode: c.focusMode || null,
        focusDistance: c.focusDistance || null,
        pointsOfInterest: c.pointsOfInterest || null,
      }
    }, null),
  }
}
