/**
 * cameraManager.js — Smart camera initialization for universal mobile compatibility.
 *
 * Handles:
 * - Platform detection (iOS, Android Chrome, Samsung Internet, Firefox)
 * - Continuous autofocus via applyConstraints (proven fix for blurry barcodes)
 * - Digital zoom on Android (makes barcodes larger, easier to detect)
 * - Tap-to-focus on supported devices
 * - Progressive fallback resolution chain
 * - Torch capability detection
 */

// ─── Platform Detection ───────────────────────────────────────────────────────

const UA = typeof navigator !== 'undefined' ? navigator.userAgent : ''

export const platform = {
  isIOS: /iPad|iPhone|iPod/.test(UA),
  isSafari: /^((?!chrome|android).)*safari/i.test(UA),
  isChrome: /chrome|chromium|crios/i.test(UA) && !/edge|edg/i.test(UA),
  isFirefox: /firefox|fxios/i.test(UA),
  isSamsung: /samsungbrowser/i.test(UA),
  isAndroid: /android/i.test(UA),
  isMobile: /android|iphone|ipad|ipod|mobile/i.test(UA),
}

// ─── Resolution Chain ─────────────────────────────────────────────────────────
// Progressive fallback: start high, drop down if camera can't handle it.

const RESOLUTION_CHAIN = [
  { width: { max: 1920, ideal: 1280 }, height: { max: 1080, ideal: 720 } },
  { width: { max: 1280, ideal: 720 }, height: { max: 720, ideal: 480 } },
  { width: { max: 640, ideal: 480 }, height: { max: 480, ideal: 360 } },
  { width: { max: 480, ideal: 360 }, height: { max: 360, ideal: 270 } },
]

// ─── Focus Management ─────────────────────────────────────────────────────────

/**
 * Apply continuous autofocus + optional zoom after camera starts.
 * This is the #1 fix for "camera won't focus on barcode" issues.
 *
 * Must be called AFTER video.play() — some devices need the stream to be
 * actively rendering before acceptConstraints works.
 *
 * @param {MediaStreamTrack} track
 * @param {object} opts
 * @param {boolean} [opts.applyZoom] — apply 1.5x zoom on Android
 * @param {boolean} [opts.debug]
 * @returns {Promise<{focusApplied: boolean, zoomApplied: boolean}>}
 */
export async function applyFocusConstraints(track, opts = {}) {
  const { applyZoom = true, debug = false } = opts
  const result = { focusApplied: false, zoomApplied: false }

  try {
    const caps = track.getCapabilities?.() || {}
    const constraints = track.getConstraints() || {}
    const advanced = constraints.advanced || []

    // Build the advanced constraints
    const newAdvanced = [...advanced]

    // Continuous autofocus — works on most Android Chrome, some Samsung
    if (caps.focusMode && caps.focusMode.includes('continuous')) {
      newAdvanced.push({ focusMode: 'continuous' })
      result.focusApplied = true
      if (debug) console.log('[CameraMgr] Applied focusMode: continuous')
    }

    // Digital zoom on Android — makes barcodes larger
    if (applyZoom && platform.isAndroid && caps.zoom) {
      const maxZoom = Math.min(caps.zoom.max || 1, 2)
      const idealZoom = Math.min(1.5, maxZoom)
      if (idealZoom > 1) {
        newAdvanced.push({ zoom: idealZoom })
        result.zoomApplied = true
        if (debug) console.log(`[CameraMgr] Applied zoom: ${idealZoom}`)
      }
    }

    // Exposure — prefer continuous auto-exposure
    if (caps.exposureMode && caps.exposureMode.includes('continuous')) {
      newAdvanced.push({ exposureMode: 'continuous' })
    }

    // White balance — prefer continuous
    if (caps.whiteBalanceMode && caps.whiteBalanceMode.includes('continuous')) {
      newAdvanced.push({ whiteBalanceMode: 'continuous' })
    }

    if (newAdvanced.length > advanced.length) {
      await track.applyConstraints({ advanced: newAdvanced })
      if (debug) console.log('[CameraMgr] Constraints applied successfully')
    }
  } catch (e) {
    if (debug) console.warn('[CameraMgr] applyConstraints failed:', e.message)
  }

  return result
}

/**
 * Apply tap-to-focus at a specific point on the video.
 * Uses focusMode: "manual" with focusDistance if supported.
 *
 * @param {MediaStreamTrack} track
 * @param {number} x — normalized 0-1 (relative to video width)
 * @param {number} y — normalized 0-1 (relative to video height)
 * @param {boolean} [debug]
 * @returns {Promise<boolean>} — true if focus was applied
 */
export async function applyTapFocus(track, x, y, debug = false) {
  try {
    const caps = track.getCapabilities?.() || {}
    if (!caps.focusMode || !caps.focusMode.includes('manual')) {
      if (debug) console.log('[CameraMgr] tap-focus not supported (no manual focusMode)')
      return { applied: false, cleanup: () => {} }
    }

    // Calculate focus distance based on tap position
    // Center = far, edges = near (rough heuristic)
    const distFromCenter = Math.sqrt((x - 0.5) ** 2 + (y - 0.5) ** 2)
    const minDist = caps.focusDistance?.min || 0
    const maxDist = caps.focusDistance?.max || 10
    const focusDist = maxDist - (distFromCenter * (maxDist - minDist))

    await track.applyConstraints({
      advanced: [{
        focusMode: 'manual',
        focusDistance: Math.max(minDist, Math.min(maxDist, focusDist)),
      }],
    })

    if (debug) console.log(`[CameraMgr] tap-focus applied at (${x.toFixed(2)}, ${y.toFixed(2)}), dist: ${focusDist.toFixed(2)}`)

    // Revert to continuous after 3 seconds
    const revertTimer = setTimeout(() => {
      applyFocusConstraints(track, { debug }).catch(() => {})
    }, 3000)

    // Return cleanup function
    return { applied: true, cleanup: () => clearTimeout(revertTimer) }
  } catch (e) {
    if (debug) console.warn('[CameraMgr] tap-focus failed:', e.message)
    return { applied: false, cleanup: () => {} }
  }
}

// ─── Camera Initialization ────────────────────────────────────────────────────

let _openingCamera = false

/**
 * Open camera with progressive resolution fallback + platform-specific constraints.
 *
 * @param {object} opts
 * @param {number} [opts.startIndex] — resolution chain start index
 * @param {boolean} [opts.debug]
 * @param {AbortSignal} [opts.signal] — optional abort signal to cancel getUserMedia
 * @returns {Promise<{stream: MediaStream, torchSupported: boolean}>}
 * @throws {Error} with name 'NotAllowedError' | 'NotFoundError' | 'TimeoutError'
 */
export async function openCamera(opts = {}) {
  const { startIndex, debug = false, signal } = opts

  if (_openingCamera) {
    if (debug) console.warn('[CameraMgr] openCamera called while already opening')
    return null
  }
  _openingCamera = true
  try {
    const isIOS = platform.isIOS
    const chain = isIOS ? RESOLUTION_CHAIN.slice(1) : RESOLUTION_CHAIN
    const startIdx = startIndex ?? (isIOS ? 0 : 0)

    let lastError = null

    for (let i = startIdx; i < chain.length; i++) {
      try {
        if (debug) console.log(`[CameraMgr] Trying resolution ${i}: ${JSON.stringify(chain[i])}`)
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { ...chain[i], facingMode: { ideal: 'environment' } },
          audio: false,
          signal,
        })
        if (debug) console.log(`[CameraMgr] Camera opened at resolution ${i}`)
        return { stream, torchSupported: detectTorch(stream) }
      } catch (e) {
        lastError = e
        if (debug) console.warn(`[CameraMgr] Resolution ${i} failed:`, e.message)
        // Don't try further resolutions if permission denied
        if (e.name === 'NotAllowedError') throw e
      }
    }

    // Final fallback: no resolution constraints
    try {
      if (debug) console.log('[CameraMgr] Trying fallback (no resolution constraints)')
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
        signal,
      })
      return { stream, torchSupported: detectTorch(stream) }
    } catch (e) {
      if (e.name === 'NotAllowedError') throw e
      throw lastError || e
    }
  } finally {
    _openingCamera = false
  }
}

/**
 * Detect if torch/flashlight is supported.
 * @param {MediaStream} stream
 * @returns {boolean}
 */
function detectTorch(stream) {
  try {
    const caps = stream.getVideoTracks()[0]?.getCapabilities?.()
    return !!caps?.torch
  } catch { return false }
}

/**
 * Toggle torch on/off.
 * @param {MediaStreamTrack} track
 * @param {boolean} on
 */
export async function toggleTorch(track, on) {
  try {
    await track.applyConstraints({ advanced: [{ torch: on }] })
  } catch { /* torch not supported */ }
}
