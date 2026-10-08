/* eslint-disable no-empty */
/**
 * BarcodeScanner — camera preview + barcode detection.
 *
 * Architecture (the ordering here is the whole point):
 *
 *  1. SESSION TOKENS, NOT SHARED BOOLEANS. Every `startScanner` run takes a
 *     monotonic session number and re-checks it after EVERY await. The old
 *     `mountedRef` boolean could not do this: React StrictMode sets it back to
 *     `true` on remount, so continuations from the *first* mount sailed through
 *     every guard and kept mutating the live session's stream — which froze the
 *     preview black while the camera LED stayed on. A stale session now walks
 *     away without touching the video element, React state, or a stream that a
 *     newer session has adopted.
 *  2. CAMERA FIRST, ENGINES SECOND. The preview must be on screen as fast as the
 *     hardware allows; the detector bundle is loaded in the background
 *     afterwards. The previous order (engine → camera → 5-frame profiling) left
 *     a black box for seconds on a slow phone.
 *  3. DETECT ON A CROP. Frames are cropped to a centred band and downscaled
 *     before decoding (see `computeRoi`), which is what keeps low-end phones
 *     above a usable frame rate. The band widens to the full frame if repeated
 *     passes miss, so a badge held close to the lens still gets read.
 *  4. QUALITY GUIDES, IT NEVER BLOCKS. A dim hall or a motion-blurred frame
 *     used to suppress detection entirely on Android, which presented as "the
 *     scanner doesn't work". Lighting hints are shown; the decoder always runs.
 *  5. NO STATE IN THE HOT LOOP. Frames are scheduled with
 *     `requestVideoFrameCallback` (falling back to rAF) and React state is only
 *     touched on real changes.
 */
import { useState, useRef, useEffect, forwardRef, useImperativeHandle, useCallback } from 'react'
import { CameraOff, RefreshCw, Zap, Focus } from 'lucide-react'
import { withTimeout, CAMERA_INIT_TIMEOUT, computeRoi, waitForVideoReady, isSecureCameraContext, isEdgeDetection, detectionBox, rgbaToGray } from '../../lib/scannerUtils'
import {
  openCamera,
  stopStream,
  cancelPendingOpen,
  isStreamLive,
  applyFocusConstraints,
  applyTapFocus,
  toggleTorch,
  describeCamera,
  platform,
} from './cameraManager'
import { BADGE_REGEX, sanitizeScannedBadge } from '../../lib/logic'


// ─── Device Profiles ──────────────────────────────────────────────────────────
const DEVICE_PROFILES = {
  fast:   { confirmWindow: 3, confirmThreshold: 2, minInterval: 50,  maxInterval: 150, frameSkip: 0 },
  medium: { confirmWindow: 4, confirmThreshold: 2, minInterval: 100, maxInterval: 300, frameSkip: 1 },
  slow:   { confirmWindow: 3, confirmThreshold: 1, minInterval: 200, maxInterval: 500, frameSkip: 2 },
}

const ENGINE_LABELS = { Native: 'Optimized', ZXing: 'Universal' }

// Max detection surface width. Lower = faster on weak hardware.
const DETECT_MAX_WIDTH = 720
// Consecutive misses before the crop widens from the band to the whole frame.
// 25 (was 15): full-frame costs ~1.75x pixels for the same 1D-only hints, so
// widen later — the hard-pass second look below buys capability instead.
const ROI_WIDEN_AFTER = 25
// Consecutive misses before a tap-to-focus hint is offered.
const GUIDANCE_AFTER = 10
// How long the aim rectangle lingers after the last detection. Short enough to
// feel attached to the badge, long enough not to blink between frames.
const AIM_HIDE_MS = 700
// Minimum ms between two aim-overlay repaints when the box has barely moved.
const AIM_THROTTLE_MS = 150
// Consecutive misses before the stripe localizer is asked to point at the
// barcode, and how often to re-ask afterwards. Both keep the localizer off the
// path entirely while a badge is reading normally.
// 8/6 (was 3/3): the localizer costs a full extra getImageData + gray pass +
// locateBarcode on the decode thread for overlay only — engaging during normal
// initial aiming taxed every badge wave.
const AIM_HINT_AFTER = 8
const AIM_HINT_EVERY = 6
// Consecutive misses before the hard-pass second look runs, and its stride.
// hardPass tries every ready engine x normal+inverted (+ widened 2D for ZXing)
// so it buys capability the base pass lacks — but at ~2-4x frame cost, hence
// gated well behind the cheap passes.
const HARD_PASS_AFTER = 10
const HARD_PASS_EVERY = 10
// Ms a busy/decision-declined badge stays damped. The 2s duplicate suppressor
// records only on ACCEPTANCE (a declined scan never ran, so its retry must not
// be swallowed) — but without any damp the same badge re-fires vibrate +
// onScan every frame for the whole RPC. 1500ms damps the storm while the
// operator's retry after ~1.5s still goes through.
const DECLINED_DAMP_MS = 1500

// ─── Quality Analysis ─────────────────────────────────────────────────────────

function createQualityChecker() {
  const c = document.createElement('canvas')
  c.width = 64; c.height = 48
  const ctx = c.getContext('2d', { willReadFrequently: true })

  /** Returns a hint reason, or null when the frame looks scannable. */
  return (video) => {
    try {
      if (!video?.videoWidth) return null
      ctx.drawImage(video, 0, 0, 64, 48)
      const d = ctx.getImageData(0, 0, 64, 48).data
      let sum = 0, sum2 = 0, minL = 255, maxL = 0
      const n = 64 * 48
      for (let i = 0; i < n; i++) {
        const l = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]
        sum += l; sum2 += l * l
        if (l < minL) minL = l
        if (l > maxL) maxL = l
      }
      const mean = sum / n
      const vari = sum2 / n - mean * mean
      const contrast = maxL - minL
      if (mean < 22) return 'dark'
      if (mean > 238) return 'bright'
      if (vari < 180) return 'blurry'
      if (contrast < 8) return 'low-contrast'
      return null
    } catch {
      return null // never let a quality probe break the loop
    }
  }
}

function guidanceFor(reason, elapsed, hasEverDetected, consecutiveFails) {
  if (reason === 'dark') return 'Better lighting needed'
  if (reason === 'bright') return 'Reduce glare'
  if (reason === 'blurry') return 'Hold steady'
  if (reason === 'low-contrast') return 'Move badge into the light'
  if (elapsed > 6000 && consecutiveFails > GUIDANCE_AFTER) {
    return hasEverDetected ? 'Align badge within the frame' : 'Tap the video to focus'
  }
  if (elapsed > 4000 && !hasEverDetected) return 'Align badge within the frame'
  return null
}

import { createEnginePool } from './enginePool'
import { locateBarcode } from './barcodeLocator'


// ─── Detection surface ────────────────────────────────────────────────────────

function createDetectSurface() {
  let canvas = null
  let ctx = null

  return {
    /** The cropped, downscaled canvas handed to the detectors. */
    get canvas() { return canvas },
    /** Raw pixels of the current crop — the ZXing path decodes from this. */
    read() {
      if (!canvas || !ctx) return null
      try { return ctx.getImageData(0, 0, canvas.width, canvas.height) } catch { return null }
    },
    /** Crop + downscale one video frame into a canvas the decoder can chew. */
    grab(video, roi) {
      if (!video?.videoWidth) return null
      if (!ctx) {
        canvas = document.createElement('canvas')
        canvas.width = roi.dw
        canvas.height = roi.dh
        ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) return null
      }
      if (canvas.width !== roi.dw || canvas.height !== roi.dh) {
        canvas.width = roi.dw
        canvas.height = roi.dh
      }
      try {
        ctx.drawImage(video, roi.sx, roi.sy, roi.sw, roi.sh, 0, 0, roi.dw, roi.dh)
        return canvas
      } catch {
        return null
      }
    },
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

const BarcodeScanner = forwardRef(function BarcodeScanner({ onScan, debug = false }, ref) {
  const videoRef = useRef(null)
  const sessionRef = useRef(0)          // monotonic — the cancellation authority
  const mountedRef = useRef(true)
  const streamRef = useRef(null)
  const trackRef = useRef(null)
  const frameHandleRef = useRef(null)    // rAF or video-frame callback id
  const frameApiRef = useRef('raf')
  const engineRef = useRef(null)
  const engineLoadingRef = useRef(false)
  const onScanRef = useRef(onScan)
  const lastScanRef = useRef({ badge: null, time: 0 })
  // Busy-decline damp: a scan the handler declined (busy / decision-pending,
  // returns exactly false) never ran, so the 2s suppressor must NOT record it —
  // but re-firing vibrate + onScan every frame for the whole RPC storms the
  // main thread. This short damp (DECLINED_DAMP_MS) is separate from the
  // acceptance suppressor above.
  const lastDeclinedRef = useRef({ badge: null, time: 0 })
  const slidingWindowRef = useRef([])
  const configRef = useRef(DEVICE_PROFILES.medium)
  const surfaceRef = useRef(null)
  const qualityRef = useRef(null)
  const hasEverDetectedRef = useRef(false)
  const consecutiveFailsRef = useRef(0)
  const roiModeRef = useRef('band')
  const engineReadyAtRef = useRef(0)      // when detection first became possible
  const anyDecodeRef = useRef(false)      // has a raw value EVER been decoded?
  const startTimeRef = useRef(Date.now())
  // V8: the single paused flag is split in two. A visibility pause (hidden
  // tab) and a decision pause (confirm/forgot popup via pause()/resume()) are
  // independent: a visibility resume or a startScanner restart must never clear
  // a decision pause, and a decision resume must not restart the loop while the
  // tab is hidden. loopGenRef is the decode-chain generation — pause, restart
  // and resume bump it so an in-flight decode pass (which captured the old
  // generation) walks away instead of arming a second permanent chain.
  const visibilityPausedRef = useRef(false)
  const decisionPausedRef = useRef(false)
  const loopGenRef = useRef(0)
  const channelRef = useRef(null)
  const isLeaderRef = useRef(true)
  const leaderClaimRef = useRef(0)
  const tapFocusCleanupRef = useRef(null)
  // Periodic AF re-assert while nothing has decoded yet (foldables / Samsung
  // firmwares that quietly drop continuous AF). Owned by the session: started
  // once the preview is live, cleared in teardown().
  const refocusTimerRef = useRef(null)
  const lastRawRef = useRef(null)
  // Reject-hint throttle (epoch ms of the last shown hint) and its hide
  // timeout — the "invalid badge" pill is transient and must not re-flash on
  // every rejected frame.
  const rejectHintAtRef = useRef(0)
  const rejectHintTimerRef = useRef(null)
  const engineLabelRef = useRef('')
  const guidanceRef = useRef(null)
  const detectMsRef = useRef({ avg: 0, last: 0 })
  const frameCountRef = useRef(0)
  const fpsRef = useRef({ frames: 0, last: Date.now() })
  // Aim overlay: the last published box (for throttling) and its fade timer.
  const aimBoxRef = useRef(null)
  const aimTimerRef = useRef(null)

  const [status, setStatus] = useState('starting')
  const [errorMsg, setErrorMsg] = useState('')
  const [engineLabel, setEngineLabel] = useState('')
  const [fps, setFps] = useState(0)
  const [guidanceMsg, setGuidanceMsg] = useState(null)
  const [torchOn, setTorchOn] = useState(false)
  const [torchSupported, setTorchSupported] = useState(false)
  const [lastRaw, setLastRaw] = useState(null)
  // Dedicated reject-hint state. NOT guidanceMsg: that is recomputed from
  // quality/fail counters every frame (setGuidance in detectLoop) and would
  // wipe a reject hint within one frame of showing it.
  const [rejectHint, setRejectHint] = useState(null)
  const [debugLogs, setDebugLogs] = useState([])
  const [tapFocusActive, setTapFocusActive] = useState(false)
  const [aimBox, setAimBox] = useState(null)

  onScanRef.current = onScan

  const debugOn = debug || (typeof window !== 'undefined' && /[?&]scannerdebug=1/.test(window.location.search))

  /** Is this start attempt still the one that owns the component? */
  const isCurrent = useCallback(session => session === sessionRef.current, [])

  const pushDebug = useCallback((msg) => {
    if (!debugOn) return
    setDebugLogs(prev => [`${new Date().toLocaleTimeString()} ${msg}`, ...prev].slice(0, 25))
    try { console.log('[Scanner]', msg) } catch {}
  }, [debugOn])

  const setGuidance = useCallback((msg) => {
    if (guidanceRef.current === msg) return
    guidanceRef.current = msg
    setGuidanceMsg(msg)
  }, [])

  // ─── Aim overlay (Option B: feedback, never a gate) ──────────────────
  //
  // The rectangle shows the operator WHERE the decoder just read. It is pure
  // feedback: `detectionBox` returning null (or being called at all) has no
  // effect on whether a scan is accepted — decoding always runs on the normal
  // ROI exactly as before.
  //
  // Two things keep it off the hot path: it only runs when a detection
  // actually succeeds (not every frame), and repaints are throttled so a
  // stationary badge doesn't re-render the whole tree ~10×/s. The fade timer,
  // by contrast, is ALWAYS refreshed, so a badge held steady stays boxed
  // instead of blinking out on the throttle.
  const publishAim = useCallback((box) => {
    if (aimTimerRef.current) { clearTimeout(aimTimerRef.current); aimTimerRef.current = null }
    aimTimerRef.current = setTimeout(() => {
      aimTimerRef.current = null
      aimBoxRef.current = null
      setAimBox(null)
    }, AIM_HIDE_MS)

    const now = Date.now()
    const last = aimBoxRef.current
    if (last && now - last.at < AIM_THROTTLE_MS
      && Math.abs(last.left - box.left) < 8
      && Math.abs(last.top - box.top) < 8) return
    aimBoxRef.current = { ...box, at: now }
    setAimBox(box)
  }, [])

  const clearAim = useCallback(() => {
    if (aimTimerRef.current) { clearTimeout(aimTimerRef.current); aimTimerRef.current = null }
    aimBoxRef.current = null
    setAimBox(null)
  }, [])

  // ─── Localizer aim hint ─────────────────────────────────────────────
  //
  // When the DECODER is the thing failing, cornerPoints never exist, so the
  // rectangle above would have nothing to show — precisely the "it won't catch
  // the badge" situation this whole change is about. `locateBarcode` can still
  // find the stripe pattern from geometry alone, so it points at the barcode
  // while the decoder keeps trying.
  //
  // Deliberately conservative, because this runs on the frame loop:
  //   - only after AIM_HINT_AFTER consecutive misses, and then only every
  //     AIM_HINT_EVERY-th frame — never while a badge is reading normally;
  //   - it ONLY publishes an overlay. It never feeds, narrows or suppresses a
  //     decode, so a null or wrong box can cost at most a misleading rectangle,
  //     never a missed scan (the non-regression contract: a HINT, not a GATE).
  // Any throw is swallowed — a hint must never be able to break the loop.
  const publishLocalizerAim = useCallback((roi, video) => {
    try {
      const img = surfaceRef.current?.read?.()
      if (!img || !video?.videoWidth) return
      const box = locateBarcode(rgbaToGray(img), img.width, img.height, { minConfidence: 0.55 })
      if (!box) return
      // detectionBox speaks in corner points; a rect's four corners are enough
      // to recover it, and they arrive in the same detect-canvas space the ROI
      // describes.
      const corners = [
        { x: box.x, y: box.y },
        { x: box.x + box.width, y: box.y },
        { x: box.x + box.width, y: box.y + box.height },
        { x: box.x, y: box.y + box.height },
      ]
      const css = detectionBox(corners, roi, video.videoWidth, video.videoHeight, video.getBoundingClientRect())
      if (css) publishAim(css)
    } catch { /* hint only — never let it touch the loop */ }
  }, [publishAim])

  // Declared before detectLoop, which depends on them (const TDZ).

  const updateWindow = useCallback((badge, cfg) => {
    const now = Date.now()
    const w = slidingWindowRef.current
    w.push({ badge, time: now })
    let t = w.filter(e => e.time > now - 3000)
    if (t.length > cfg.confirmWindow) t = t.slice(-cfg.confirmWindow)
    slidingWindowRef.current = t
    const c = t.filter(e => e.badge === badge).length
    return { confirmed: c >= cfg.confirmThreshold, count: c }
  }, [])

  // Dedicated transient hint for reads the sanitizer could not recover.
  // Ref-throttled to one show per 2s (a steady misread stream otherwise
  // re-flashes the pill every frame) and self-hiding via timeout — guidanceMsg
  // cannot carry this: detectLoop recomputes it every frame.
  const throttledRejectHint = useCallback(() => {
    const now = Date.now()
    if (now - rejectHintAtRef.current < 2000) return
    rejectHintAtRef.current = now
    if (rejectHintTimerRef.current) { clearTimeout(rejectHintTimerRef.current); rejectHintTimerRef.current = null }
    setRejectHint('Invalid badge — try again')
    rejectHintTimerRef.current = setTimeout(() => {
      rejectHintTimerRef.current = null
      setRejectHint(null)
    }, 2000)
  }, [])

  const handleBarcodes = useCallback((barcodes, roi, engine) => {
    const cfg = configRef.current
    for (const b of barcodes) {
      const raw = String(b.rawValue || '').trim().toUpperCase()
      // The decode gate runs through the sanitizer: Code-39 guards, case and
      // confusion misreads are recovered here instead of dying at the regex.
      // The sanitizer returns the ORIGINAL (normalised) value when nothing
      // can be recovered — its codified contract (logic.test.js) — so
      // validity is still judged on the cleaned result, never the raw read.
      const cleaned = sanitizeScannedBadge(b.rawValue)
      // Every dedupe key below is the CLEANED value: '*FB…*' and 'FB…*' are
      // one badge, so window counts, the 2s suppressor and the pill's
      // change-detection must not re-arm when only the guards differ.
      if (cleaned !== lastRawRef.current) { lastRawRef.current = cleaned; setLastRaw(raw) }
      if (!cleaned || !BADGE_REGEX.test(cleaned)) { throttledRejectHint(); continue }

      // Reject detections hugging the frame edge. cornerPoints arrive in
      // detect-canvas coordinates, so map them back to video pixels first.
      // This is NOT debug-gated: a debug build must accept exactly what
      // production accepts, otherwise a badge that scans locally fails for users.
      // L-15: judged through isEdgeDetection so ZXing's 2-point reads get the
      // same verdict as native 4-point quads (the old >= 4 inline test could
      // never fire on the ZXing path).
      if (videoRef.current?.videoWidth && isEdgeDetection(b.cornerPoints, roi, videoRef.current.videoWidth, videoRef.current.videoHeight)) {
        if (debugOn) pushDebug(`edge reject: ${raw}`)
        continue
      }

      // Aim feedback over what we just read — placed after the edge reject so
      // the rectangle never marks a detection we refused to trust. Runs before
      // the confirm window, because aiming is exactly what an operator needs
      // while the threshold is still counting up.
      const v = videoRef.current
      if (v?.videoWidth) {
        const box = detectionBox(b.cornerPoints, roi, v.videoWidth, v.videoHeight, v.getBoundingClientRect())
        if (box) publishAim(box)
      }

      hasEverDetectedRef.current = true
      const { confirmed, count } = updateWindow(cleaned, cfg)
      if (debugOn) pushDebug(`window ${cleaned}: ${count}/${cfg.confirmThreshold} ${confirmed ? 'CONFIRMED' : ''}`)
      if (!confirmed) continue

      const now = Date.now()
      if (lastScanRef.current.badge === cleaned && now - lastScanRef.current.time < 2000) break
      // Declined-vibrate damp: a badge declined moments ago (busy /
      // decision-pending) keeps re-offering onScan every confirmed frame per
      // the T11 contract — but the per-frame vibrate is pure storm, so damp
      // vibrate only, never the offer itself.
      const declinedDamped = lastDeclinedRef.current.badge === cleaned && now - lastDeclinedRef.current.time < DECLINED_DAMP_MS
      if (!declinedDamped) { try { navigator.vibrate?.(80) } catch {} }
      pushDebug(`SCAN OK [${engine}]: ${cleaned}`)
      // Camera-suppressor contract (see the busy guard in useScanHandler.js):
      // the suppressor records only on ACCEPTANCE. A declined scan (the
      // handler returned exactly `false` — busy or decision-pending) never
      // ran, so burning the 2s window on it would swallow the retry as a
      // duplicate. Any other return (undefined, true, a promise) records.
      // Declined scans record into the short damp above instead.
      const accepted = onScanRef.current?.(cleaned)
      if (accepted !== false) {
        lastScanRef.current = { badge: cleaned, time: now }
        lastDeclinedRef.current = { badge: null, time: 0 }
      } else {
        lastDeclinedRef.current = { badge: cleaned, time: now }
      }
      break
    }
  }, [debugOn, pushDebug, updateWindow, publishAim, throttledRejectHint])

  // ─── Frame scheduling ───────────────────────────────────────────────

  const cancelFrame = useCallback(() => {
    if (frameHandleRef.current == null) return
    try {
      if (frameApiRef.current === 'timeout') clearTimeout(frameHandleRef.current)
      else if (frameApiRef.current === 'rvfc' && videoRef.current?.cancelVideoFrameCallback) {
        videoRef.current.cancelVideoFrameCallback(frameHandleRef.current)
      } else {
        cancelAnimationFrame(frameHandleRef.current)
      }
    } catch {}
    frameHandleRef.current = null
  }, [])

  // ─── Detection loop ─────────────────────────────────────────────────

  const detectLoop = useCallback(async () => {
    if (!mountedRef.current || visibilityPausedRef.current || decisionPausedRef.current) return
    const session = sessionRef.current
    const gen = loopGenRef.current
    const video = videoRef.current
    if (!video) return

    // Engines are still downloading — keep the preview live, just wait.
    if (!engineRef.current?.isReady()) {
      frameApiRef.current = 'timeout'
      frameHandleRef.current = setTimeout(() => {
        frameHandleRef.current = null
        if (isCurrent(session) && mountedRef.current) detectLoop()
      }, 120)
      return
    }
    if (!video.videoWidth) { scheduleNext(); return }

    const cfg = configRef.current
    frameCountRef.current++

    if (cfg.frameSkip && frameCountRef.current % (cfg.frameSkip + 1) !== 0) { scheduleNext(); return }

    // Quality is a HINT, never a gate — blocking here is what made dim-hall
    // scanning look broken on Android.
    const elapsed = Date.now() - startTimeRef.current
    const hint = qualityRef.current?.(video) || null
    setGuidance(guidanceFor(hint, elapsed, hasEverDetectedRef.current, consecutiveFailsRef.current))

    const roi = computeRoi(video.videoWidth, video.videoHeight, {
      mode: roiModeRef.current,
      maxWidth: DETECT_MAX_WIDTH,
    })
    const surface = surfaceRef.current?.grab(video, roi)
    if (!surface) { scheduleNext(); return }

    const t0 = performance.now()
    const { barcodes, engine } = await engineRef.current.detect(surfaceRef.current)
    const elapsedMs = performance.now() - t0
    detectMsRef.current.last = elapsedMs
    detectMsRef.current.avg = detectMsRef.current.avg ? detectMsRef.current.avg * 0.8 + elapsedMs * 0.2 : elapsedMs

    // A newer session took over while we were decoding — drop the result.
    // A newer generation (pause/restart/resume bumped loopGenRef mid-decode)
    // means this pass is stale: walk away so only the newest chain arms.
    if (!isCurrent(session) || !mountedRef.current) return
    if (gen !== loopGenRef.current) return
    // Paused while decoding (hidden tab or decision popup): hand control back
    // to whoever owns the pause instead of arming another pass.
    if (visibilityPausedRef.current || decisionPausedRef.current) return

    fpsRef.current.frames++
    if (Date.now() - fpsRef.current.last > 1000) {
      setFps(fpsRef.current.frames)
      fpsRef.current = { frames: 0, last: Date.now() }
    }

    if (barcodes?.length) {
      consecutiveFailsRef.current = 0
      anyDecodeRef.current = true
      // Re-narrow the crop once a badge reads, so a full-frame pass doesn't
      // permanently halve the frame rate on a low-end phone.
      if (roiModeRef.current === 'full') roiModeRef.current = 'band'
      handleBarcodes(barcodes, roi, engine)
    } else {
      consecutiveFailsRef.current++
      // Point at the barcode while the DECODER is the thing failing. Throttled
      // both by miss count and frame number so a hopeless loop never pays the
      // localizer on every pass. Pure overlay — see publishLocalizerAim.
      if (consecutiveFailsRef.current >= AIM_HINT_AFTER && frameCountRef.current % AIM_HINT_EVERY === 0) {
        publishLocalizerAim(roi, video)
      }
      // Watchdog: a live preview that has never decoded anything is the
      // signature of a broken engine. Say so instead of hinting forever.
      if (engineReadyAtRef.current && !anyDecodeRef.current && Date.now() - engineReadyAtRef.current > 20000) {
        setStatus('error')
        setErrorMsg('This browser cannot read badges — try Chrome or Edge')
        return
      }
      // Hard-pass second look: base detect() runs ONE engine with 1D-only
      // hints. hardPass tries every ready engine x normal+inverted+rotated (+
      // widened 2D for ZXing) — the only path that reads inverted/rotated/2D
      // badges. Gated by miss count + stride so its ~2-4x cost never taxes
      // normal reads.
      if (consecutiveFailsRef.current >= HARD_PASS_AFTER && frameCountRef.current % HARD_PASS_EVERY === 0) {
        try {
          const hard = await engineRef.current?.hardPass?.(surfaceRef.current)
          if (!isCurrent(session) || !mountedRef.current) return
          if (gen !== loopGenRef.current) return
          if (visibilityPausedRef.current || decisionPausedRef.current) return
          if (hard?.barcodes?.length) {
            consecutiveFailsRef.current = 0
            anyDecodeRef.current = true
            if (roiModeRef.current === 'full') roiModeRef.current = 'band'
            handleBarcodes(hard.barcodes, roi, hard.engine || 'hard')
          }
        } catch { /* hardPass never throws by contract; belt-and-braces */ }
      }
      if (roiModeRef.current === 'band' && consecutiveFailsRef.current >= ROI_WIDEN_AFTER) {
        roiModeRef.current = 'full'
        if (debugOn) pushDebug('roi widened to full frame after repeated misses')
      }
    }

    if (engineRef.current.getActiveId() !== engineLabelRef.current) {
      engineLabelRef.current = engineRef.current.getActiveId()
      setEngineLabel(engineLabelRef.current)
    }

    scheduleNext(elapsedMs)

    // Pace by a timeout, then hand off to a frame callback (or rAF) for the
    // next pass. The timeout enforces the device profile's duty cycle — without
    // it, a 200ms decode on a slow phone would re-fire the instant it finished
    // and starve the UI thread.
    function scheduleNext(detectMs = 0) {
      if (!isCurrent(session) || !mountedRef.current || visibilityPausedRef.current || decisionPausedRef.current || gen !== loopGenRef.current) return
      const c = configRef.current
      const wait = Math.max(c.minInterval, Math.min(c.maxInterval, (detectMs || 0) / 0.5))
      frameApiRef.current = 'timeout'
      frameHandleRef.current = setTimeout(() => {
        if (!isCurrent(session) || !mountedRef.current || visibilityPausedRef.current || decisionPausedRef.current || gen !== loopGenRef.current) { frameHandleRef.current = null; return }
        const v = videoRef.current
        if (v && typeof v.requestVideoFrameCallback === 'function') {
          frameApiRef.current = 'rvfc'
          // The session is re-checked HERE as well: a Retry between scheduling
          // and this callback would otherwise leave two permanent chains.
          frameHandleRef.current = v.requestVideoFrameCallback(() => {
            frameHandleRef.current = null
            if (!isCurrent(session) || !mountedRef.current || visibilityPausedRef.current || decisionPausedRef.current || gen !== loopGenRef.current) return
            detectLoop()
          })
        } else {
          frameApiRef.current = 'raf'
          frameHandleRef.current = requestAnimationFrame(() => {
            frameHandleRef.current = null
            if (!isCurrent(session) || !mountedRef.current || visibilityPausedRef.current || decisionPausedRef.current || gen !== loopGenRef.current) return
            detectLoop()
          })
        }
      }, wait)
    }
  }, [debugOn, pushDebug, setGuidance, isCurrent, handleBarcodes, publishLocalizerAim])

  // ─── Tap to Focus ───────────────────────────────────────────────────

  // Core focus action at normalised (0-1) frame coordinates. Split out so
  // keyboard activation can focus the frame centre without pointer data.
  const focusAt = useCallback(async (x, y) => {
    if (tapFocusCleanupRef.current) { try { tapFocusCleanupRef.current() } catch {} tapFocusCleanupRef.current = null }

    setTapFocusActive(true)
    pushDebug(`tap-focus at (${x.toFixed(2)}, ${y.toFixed(2)})`)
    const result = await applyTapFocus(trackRef.current, x, y)
    if (result?.cleanup) tapFocusCleanupRef.current = result.cleanup
    if (!mountedRef.current) return
    // Also push a focus ROI through the continuous-AF path where supported.
    applyFocusConstraints(trackRef.current, { point: { x, y }, applyZoom: false }).catch(() => {})
    setTimeout(() => { if (mountedRef.current) setTapFocusActive(false) }, 1500)
  }, [pushDebug])

  const handleVideoTap = useCallback(async (e) => {
    const video = videoRef.current
    if (!trackRef.current || !video) return
    const rect = video.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    await focusAt(
      (e.clientX - rect.left) / rect.width,
      (e.clientY - rect.top) / rect.height,
    )
  }, [focusAt])

  // L-17: the video is an operable control, so it must answer the keyboard.
  // Pointer position is meaningless here — focus the frame centre.
  const handleVideoKey = useCallback((e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    if (!trackRef.current || !videoRef.current) return
    focusAt(0.5, 0.5)
  }, [focusAt])

  // ─── Torch ──────────────────────────────────────────────────────────

  const torchOnRef = useRef(false)
  const handleTorchToggle = useCallback(async () => {
    const track = trackRef.current
    if (!track) return
    const next = !torchOnRef.current   // ref, not state: rapid taps must not desync
    const ok = await toggleTorch(track, next)
    if (!mountedRef.current) return
    // Only reflect a change the hardware actually accepted.
    if (!ok) { torchOnRef.current = false; setTorchOn(false); return }
    torchOnRef.current = next
    setTorchOn(next)
  }, [])

  /**
   * Load detector engines off the critical path.
   *
   * The preview is already live by the time this runs, so a slow bundle can
   * never hold the scanner on a black box. `engineLoadingRef` keeps concurrent
   * starts from stacking duplicate imports.
   */
  const ensureEngines = useCallback(async (session) => {
    if (engineRef.current?.isReady()) {
      // Re-arm the watchdog clock for the live session (L-22): the pool
      // survives a restart, so without this a Retry inherits the previous
      // run's timestamp and the watchdog re-errors on the first pass.
      if (isCurrent(session) && mountedRef.current) {
        engineReadyAtRef.current = Date.now()
        anyDecodeRef.current = false
      }
      return
    }
    if (engineLoadingRef.current) return
    engineLoadingRef.current = true
    try {
      const pool = createEnginePool(debugOn)
      await pool.init()

      // The engine bundle is session-INDEPENDENT. Publish it even if this
      // session is stale, otherwise the newer session (which saw the in-flight
      // load and returned early) would be left with no engine and a live
      // preview that can never scan.
      if (!engineRef.current?.isReady() && pool.isReady()) {
        engineRef.current = pool
        engineLabelRef.current = pool.getActiveId()
        setEngineLabel(engineLabelRef.current)
        engineReadyAtRef.current = Date.now()
        anyDecodeRef.current = false
        pushDebug(`engine ready: ${pool.getActiveId()}`)
      }

      // Arm the engine we didn't pick (L-14) — fire-and-forget. The loader
      // never rejects and touches no session state, so a stale session may
      // safely arm it for the session that is actually live.
      pool.armFallback()

      if (!isCurrent(session) || !mountedRef.current) return
      if (!pool.isReady() && !engineRef.current?.isReady()) {
        setStatus('error')
        setErrorMsg('No barcode detection engine available — try Chrome or Edge')
        return
      }

      // Device profiling in the background: refine the frame budget without
      // blocking the first frames the user is already scanning with. It reuses
      // the same crop path as the real loop so the timing is representative.
      const v = videoRef.current
      const frames = []
      for (let i = 0; i < 3 && v?.videoWidth; i++) {
        if (!isCurrent(session)) break   // don't burn decodes for a dead session
        const roi = computeRoi(v.videoWidth, v.videoHeight, { mode: roiModeRef.current, maxWidth: DETECT_MAX_WIDTH })
        if (!surfaceRef.current?.grab(v, roi)) break
        const t0 = performance.now()
        await pool.detect(surfaceRef.current)
        frames.push(performance.now() - t0)
      }
      if (frames.length === 3 && isCurrent(session) && mountedRef.current) {
        const avg = frames.reduce((a, b) => a + b, 0) / frames.length
        const prof = avg < 30 ? 'fast' : avg < 120 ? 'medium' : 'slow'
        configRef.current = DEVICE_PROFILES[prof]
        if (debugOn) pushDebug(`profile ${prof} (~${Math.round(avg)}ms/frame)`)
      }
    } catch { /* engine pool already logged; the loop just keeps retrying */ }
    finally {
      engineLoadingRef.current = false
    }
  }, [debugOn, pushDebug, isCurrent])

  // ─── Teardown ───────────────────────────────────────────────────────
  /** Cancel the current session and release the stream it owns. */
  const teardown = useCallback(({ stopCamera = true } = {}) => {
    sessionRef.current++            // invalidate every in-flight continuation
    cancelFrame()
    if (refocusTimerRef.current) { clearInterval(refocusTimerRef.current); refocusTimerRef.current = null }
    if (rejectHintTimerRef.current) { clearTimeout(rejectHintTimerRef.current); rejectHintTimerRef.current = null }
    channelRef.current?.close(); channelRef.current = null
    if (tapFocusCleanupRef.current) { try { tapFocusCleanupRef.current() } catch {} tapFocusCleanupRef.current = null }
    if (stopCamera) {
      // Abandon any open still in flight so its stream is stopped on arrival
      // rather than adopted by a component that no longer exists.
      cancelPendingOpen()
      const stream = streamRef.current
      if (stream) stopStream(stream)
      streamRef.current = null
      trackRef.current = null
      if (videoRef.current) {
        try { videoRef.current.pause?.() } catch {}
        videoRef.current.srcObject = null
        try { videoRef.current.load() } catch {}
      }
    }
    slidingWindowRef.current = []
    frameCountRef.current = 0
    hasEverDetectedRef.current = false
    consecutiveFailsRef.current = 0
    roiModeRef.current = 'band'
    engineReadyAtRef.current = 0
    anyDecodeRef.current = false
    // Same fresh-scan reset as startScanner (L-20): a stop() followed by an
    // external restart must not inherit the suppressor either.
    lastScanRef.current = { badge: null, time: 0 }
    lastRawRef.current = null
    // A rectangle must not outlive the session that drew it — Retry, unmount
    // and a tab-leader yield all land here.
    clearAim()
  }, [cancelFrame, clearAim])

  // ─── Start ──────────────────────────────────────────────────────────

  const startScanner = useCallback(async ({ reclaim = false } = {}) => {
    if (!mountedRef.current) return
    // An explicit Retry re-claims leadership — otherwise the button on the
    // "another tab" screen is dead.
    if (reclaim) isLeaderRef.current = true
    const session = ++sessionRef.current   // any previous run is now stale
    cancelFrame()                          // reclaim the old chain's frame slot
    loopGenRef.current++                   // invalidate any in-flight decode pass
    // V8: only the visibility pause is cleared by a (re)start. A decision
    // pause (confirm/forgot popup open) survives the restart and is re-asserted
    // after the preview is live, so the restart cannot silently resume scanning
    // behind the operator's pending question.
    visibilityPausedRef.current = false
    // Fresh detection state (L-20): a Retry/restart must not inherit the
    // previous run's 2s duplicate-suppressor, its last-raw pill, its sliding
    // window, or its watchdog clock — otherwise the first post-restart scan
    // of the same badge is silently dropped, and a restart after the
    // watchdog error re-errors instantly on the stale timestamp (L-22).
    lastScanRef.current = { badge: null, time: 0 }
    lastRawRef.current = null
    rejectHintAtRef.current = 0
    slidingWindowRef.current = []
    frameCountRef.current = 0
    hasEverDetectedRef.current = false
    consecutiveFailsRef.current = 0
    roiModeRef.current = 'band'
    engineReadyAtRef.current = 0
    anyDecodeRef.current = false
    // A restart must not inherit the previous run's aim rectangle either.
    clearAim()

    if (!isSecureCameraContext()) {
      setStatus('error')
      setErrorMsg('Camera needs HTTPS or localhost — open the portal over https://')
      return
    }

    // Double-tab guard — only one active scanner tab.
    try {
      channelRef.current?.close()
      const ch = new BroadcastChannel('scanner-leader')
      channelRef.current = ch
      const claim = Date.now() + Math.random() // sub-ms jitter breaks same-ms ties
      leaderClaimRef.current = claim
      ch.onmessage = e => {
        // Only yield to a strictly newer claim, so two tabs cannot ping-pong.
        if (e?.data?.type === 'take-leader' && e.data.at > leaderClaimRef.current) {
          isLeaderRef.current = false
          teardown()
          setStatus('yielded')
          setErrorMsg('Scanner active in another tab — close that tab to use this one')
        }
      }
      ch.postMessage({ type: 'take-leader', at: claim })
    } catch { /* BroadcastChannel unsupported */ }
    if (!isLeaderRef.current) return

    setStatus('loading')
    setErrorMsg('')
    setGuidance(null)
    setDebugLogs([])
    setLastRaw(null)
    setEngineLabel('')
    startTimeRef.current = Date.now()

    // L-22: the error screen unmounts <video>, so on Retry this ref is null
    // until React commits the loading state. Reading it synchronously killed
    // every Retry at "Video element missing". Wait for the element (bounded,
    // session-checked) — it resolves immediately when already mounted.
    if (!videoRef.current) {
      const deadline = Date.now() + 2000
      while (!videoRef.current && Date.now() < deadline) {
        if (!isCurrent(session) || !mountedRef.current) return
        await new Promise(r => setTimeout(r, 50))
      }
    }

    if (debugOn) {
      pushDebug(`start session #${session} · secure=${window.isSecureContext} · ${platform.isIOS ? 'iOS' : 'other'}`)
      try {
        const perm = await navigator.permissions?.query?.({ name: 'camera' })
        if (!isCurrent(session) || !mountedRef.current) return
        pushDebug(`permission: ${perm?.state || 'unknown'}`)
      } catch { /* permissions API unavailable */ }
    }

    // ── 1. Camera first. Nothing else may delay the preview.
    let opened
    try {
      opened = await withTimeout(openCamera({ debug: debugOn }), CAMERA_INIT_TIMEOUT, 'Camera')
    } catch (err) {
      // An abandoned open is a normal cancellation, never a user-facing error.
      if (err?.name === 'AbortError' || !isCurrent(session) || !mountedRef.current) return
      const msg = String(err?.message || '')
      if (msg.includes('timed out')) {
        setStatus('error'); setErrorMsg('Camera took too long to start — tap Retry')
      } else if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') {
        const hint = platform.isIOS
          ? 'Go to Settings → Safari → Camera → Allow, then tap Retry'
          : 'Open the address-bar camera icon → Allow, then tap Retry'
        setStatus('error'); setErrorMsg(`Camera permission denied — ${hint}`)
      } else if (err?.name === 'NotFoundError') {
        setStatus('error'); setErrorMsg('No camera found on this device')
      } else {
        setStatus('error'); setErrorMsg(msg || 'Camera failed to start')
      }
      return
    }
    if (!opened?.stream) { if (isCurrent(session)) { setStatus('error'); setErrorMsg('Camera failed to start') } return }

    // A stale session must not touch the video element, React state, or a
    // stream a newer session has adopted. It only reclaims its own stream when
    // nothing is left alive to own it (a real unmount).
    if (!isCurrent(session)) {
      if (!mountedRef.current) stopStream(opened.stream)
      return
    }

    const stream = opened.stream
    streamRef.current = stream
    trackRef.current = opened.track || stream.getVideoTracks()[0] || null
    setTorchSupported(!!opened.torchSupported)

    const video = videoRef.current
    if (!video) { stopStream(stream); setStatus('error'); setErrorMsg('Video element missing'); return }

    video.srcObject = stream
    try {
      await video.play()
    } catch {
      if (!isCurrent(session)) { if (!mountedRef.current) stopStream(stream); return }
      // V8: a rejected play() leaves the track live with a black preview and
      // the camera LED on — release the stream through the teardown path
      // before surfacing the error, so Retry starts from a clean slate.
      stopStream(stream)
      streamRef.current = null
      trackRef.current = null
      try { video.srcObject = null } catch {}
      setStatus('error'); setErrorMsg('Could not start video playback — tap Retry')
      return
    }
    // Stale after play(): walk away. `stream` may be the shared adopted stream,
    // so only reclaim it when nothing is left alive to own it.
    if (!isCurrent(session)) { if (!mountedRef.current) stopStream(stream); return }

    if (debugOn) {
      const dims = await waitForVideoReady(video, 1500)
      if (!isCurrent(session)) return
      pushDebug(`video ${dims.width}×${dims.height}${dims.timedOut ? ' (no loadeddata)' : ''}`)
      pushDebug(`camera: ${JSON.stringify(describeCamera(stream))}`)
    }

    // ── 2. Preview is live. Focus + engines happen after.
    setStatus('ready')
    qualityRef.current = createQualityChecker()
    surfaceRef.current = createDetectSurface()

    if (trackRef.current) {
      applyFocusConstraints(trackRef.current, { applyZoom: true, debug: debugOn }).then(r => {
        if (!isCurrent(session) || !mountedRef.current) return
        if (debugOn) pushDebug(`focus: ${r.poiApplied ? 'roi' : r.focusApplied ? 'continuous' : 'device default'}, zoom: ${r.zoomApplied ? 'yes' : 'no'}`)
      }).catch(() => {})
      // Re-assert AF every 4s until the first decode: some devices drop
      // continuous focus after the initial lock attempt. Stops itself on the
      // first decode, on pause, or when the session ends.
      if (refocusTimerRef.current) clearInterval(refocusTimerRef.current)
      refocusTimerRef.current = setInterval(() => {
        if (!isCurrent(session) || !mountedRef.current) {
          clearInterval(refocusTimerRef.current); refocusTimerRef.current = null
          return
        }
        if (hasEverDetectedRef.current || visibilityPausedRef.current || decisionPausedRef.current) return
        const t = trackRef.current
        if (!t || t.readyState !== 'live') return
        applyFocusConstraints(t, { applyZoom: false, debug: debugOn }).then(r => {
          if (debugOn && r.focusApplied) pushDebug('focus: re-asserted continuous AF')
        }).catch(() => {})
      }, 4000)
    }

    // Start looping immediately — unless a decision popup is open, in which
    // case re-assert the pause: the preview goes live but no decode chain is
    // armed until resume() answers the pending question.
    if (decisionPausedRef.current) {
      cancelFrame()
    } else {
      detectLoop()
    }

    // ── 3. Engines in the background — never block the preview.
    ensureEngines(session)
  }, [debugOn, pushDebug, setGuidance, isCurrent, detectLoop, ensureEngines, teardown, cancelFrame, clearAim])

  // ─── Lifecycle ──────────────────────────────────────────────────────

  useEffect(() => {
    mountedRef.current = true
    startScanner()
    return () => {
      mountedRef.current = false
      teardown()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Safari pauses <video> while backgrounded and never resumes it, and the
  // camera can die entirely — so resume by *condition*, not by restarting.
  // Mobile: the hidden branch also RELEASES the camera hardware (tracks
  // stopped, refs cleared). A backgrounded tab holding the stream keeps the
  // privacy LED on and the battery draining for the whole hidden period;
  // the visible branch below already re-acquires when the stream is not
  // live, so this only trades a fast resume for a clean one.
  useEffect(() => {
    const onVisibility = async () => {
      if (document.visibilityState === 'hidden') {
        visibilityPausedRef.current = true
        loopGenRef.current++
        cancelFrame()
        try {
          const stream = streamRef.current
          if (stream) {
            for (const t of stream.getTracks()) { try { t.stop() } catch {} }
          }
        } catch {}
        streamRef.current = null
        trackRef.current = null
        return
      }
      if (!mountedRef.current) return
      visibilityPausedRef.current = false
      // A decision popup open across the hide/show cycle keeps the LOOP
      // halted — but the STREAM must still be re-acquired: the hidden branch
      // stops every track, and returning here with a dead stream left a
      // permanent black preview with no error and no Retry. Preview live,
      // decode still paused — the guards below re-arm nothing while decided.
      if (decisionPausedRef.current) {
        if (!isStreamLive(streamRef.current)) { startScanner(); }
        else { cancelFrame(); }
        return
      }

      if (!isStreamLive(streamRef.current)) { startScanner(); return }

      // Resume ONLY if no loop is already scheduled. The in-flight pass, if
      // any, carries the pre-hide generation and walks away once it finishes —
      // without this guard we'd end up with two permanent decode chains.
      if (frameHandleRef.current != null) return
      // New generation: any decode pass still in flight from before the hide
      // captured the old generation and walks away instead of re-arming, so
      // the chain armed below is the only one.
      loopGenRef.current++

      const video = videoRef.current
      if (video) { try { await video.play() } catch {} }
      if (trackRef.current) { try { await applyFocusConstraints(trackRef.current) } catch {} }
      if (mountedRef.current && !visibilityPausedRef.current && !decisionPausedRef.current && isStreamLive(streamRef.current)) detectLoop()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [cancelFrame, detectLoop, startScanner, isCurrent])

  // Offline engine retry: the ZXing chunk is lazily imported, so an uncached
  // first load with no network leaves a live preview that can never decode —
  // and nothing re-ran ensureEngines on reconnect. Retry once per reconnect.
  useEffect(() => {
    const onOnline = () => {
      if (!mountedRef.current) return
      if (!engineRef.current?.isReady() && !engineLoadingRef.current) {
        ensureEngines(sessionRef.current)
      }
    }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [ensureEngines])

  useImperativeHandle(ref, () => ({
    restart: startScanner,
    stop: () => teardown(),
    // L-46: the pages' "camera paused" claim is only true if the decode loop
    // actually halts. pause() stops scheduling (the preview keeps its last
    // frame, the stream stays live); resume() restarts the loop only when no
    // chain is already scheduled, mirroring the visibility handler, and
    // re-opens the camera when the stream died while paused. V8: pause() sets
    // the DECISION pause only (never the visibility one), and resume() clears
    // just that flag — resuming while the tab is hidden leaves the loop halted
    // for the visibility handler. Both bump the loop generation and resume()
    // re-checks the session token, so an in-flight decode pass can never arm a
    // second chain alongside the resumed one.
    pause: () => { decisionPausedRef.current = true; loopGenRef.current++; cancelFrame() },
    resume: () => {
      const session = sessionRef.current
      decisionPausedRef.current = false
      if (!mountedRef.current) return
      if (!isCurrent(session)) return
      // Hidden tab: leave the loop halted; the visibility handler restarts it
      // on return (and re-checks the decision flag there).
      if (visibilityPausedRef.current) return
      if (!isStreamLive(streamRef.current)) { startScanner(); return }
      if (frameHandleRef.current != null) return
      loopGenRef.current++
      if (!isCurrent(session) || visibilityPausedRef.current || decisionPausedRef.current) return
      detectLoop()
    },
  }), [startScanner, teardown, cancelFrame, detectLoop, isCurrent])

  // ─── Error State ────────────────────────────────────────────────────

  if (status === 'error' || status === 'yielded') return (
    <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 12, padding: '1.25rem', textAlign: 'center' }}>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '0.6rem' }}><CameraOff size={28} style={{ color: '#b91c1c' }} /></div>
      <div style={{ fontWeight: 700, marginBottom: '0.4rem' }}>Camera error</div>
      <div style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: '0.9rem' }}>{errorMsg}</div>
      <button onClick={() => startScanner({ reclaim: true })} className="btn btn-primary"><RefreshCw size={14} /> Retry</button>
    </div>
  )

  // ─── Main UI ────────────────────────────────────────────────────────

  return (
    <div style={{ position: 'relative', background: '#000', borderRadius: 12, overflow: 'hidden' }}>
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        webkit-playsinline="true"
        onClick={handleVideoTap}
        role="button"
        tabIndex={0}
        aria-label="Tap to focus camera"
        onKeyDown={handleVideoKey}
        className="scanner-video"
        style={{ width: '100%', height: 'clamp(220px, 52vh, 420px)', objectFit: 'cover', display: 'block', cursor: 'crosshair' }}
      />

      {/* Loading overlay — also covers 'starting' so a stall is never a silent
          black rectangle. The spinner reuses .spin so a slow cold start reads
          as working, not frozen. */}
      {(status === 'loading' || status === 'starting') && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.6rem', background: 'rgba(0,0,0,0.55)', color: '#fff', fontWeight: 600 }}>
          <span className="spin scanner-init-spinner" aria-hidden="true" />
          Starting camera… {engineLabel}
        </div>
      )}

      {tapFocusActive && (
        <div style={{
          position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
          width: 60, height: 60, border: '2px solid #f59e0b', borderRadius: 8,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(245,158,11,0.15)', pointerEvents: 'none',
          animation: 'tapFocusPulse 1.5s ease-out',
        }}>
          <Focus size={20} style={{ color: '#f59e0b' }} />
        </div>
      )}

      {/* Status pills */}
      <div style={{ position: 'absolute', top: 8, left: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <span className="pill" style={{ background: 'rgba(0,0,0,0.6)', color: '#fff', fontSize: '0.65rem' }}>
          {ENGINE_LABELS[engineLabel] || engineLabel || '…'} {fps ? `${fps} fps` : ''}
        </span>
        {platform.isIOS && <span className="pill" style={{ background: 'rgba(16,185,129,0.9)', color: '#fff', fontSize: '0.62rem' }}>iOS</span>}
        {lastRaw && <span className="pill" style={{ background: 'rgba(59,130,246,0.9)', color: '#fff', fontSize: '0.62rem' }}>{lastRaw}</span>}
      </div>

      {torchSupported ? (
        <button onClick={handleTorchToggle} aria-pressed={torchOn} className="scanner-torch" style={{
          position: 'absolute', top: 8, right: 8,
          background: torchOn ? '#f59e0b' : 'rgba(0,0,0,0.6)',
          color: '#fff', border: 'none', borderRadius: 8,
          padding: '0.35rem 0.6rem', fontWeight: 700, fontSize: '0.75rem',
          touchAction: 'manipulation',
        }}><Zap size={12} aria-hidden="true" /> {torchOn ? 'Torch on' : 'Torch'}</button>
      ) : null}

      {status === 'ready' && !hasEverDetectedRef.current && (
        <div style={{
          position: 'absolute', top: 8, right: torchSupported ? 80 : 8,
          background: 'rgba(0,0,0,0.5)', color: '#fff', borderRadius: 6,
          padding: '0.25rem 0.5rem', fontSize: '0.6rem', display: 'flex', alignItems: 'center', gap: 4,
        }}>
          <Focus size={10} /> Tap to focus
        </div>
      )}

      {/* Reject hint — a decode the sanitizer could not recover. Amber to read
          as "rejected" against the black guidance pill; dedicated state because
          guidanceMsg is recomputed every frame and would wipe this instantly.
          Transient: throttledRejectHint arms the 2s hide-timeout. */}
      {rejectHint && (
        <div style={{
          position: 'absolute', bottom: 10, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(245,158,11,0.95)', color: '#fff',
          padding: '0.35rem 0.7rem', borderRadius: 999,
          fontSize: '0.78rem', fontWeight: 600,
          whiteSpace: 'normal', maxWidth: 'calc(100% - 20px)', textAlign: 'center',
        }}>{rejectHint}</div>
      )}

      {guidanceMsg && (
        <div style={{
          position: 'absolute', bottom: rejectHint ? 44 : 10, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(0,0,0,0.7)', color: '#fff',
          padding: '0.35rem 0.7rem', borderRadius: 999,
          fontSize: '0.78rem', fontWeight: 600,
          // Wraps instead of overflowing narrow phones; on desktop the copy
          // still fits one line, so wide screens render unchanged.
          whiteSpace: 'normal', maxWidth: 'calc(100% - 20px)', textAlign: 'center',
        }}>{guidanceMsg}</div>
      )}

      {/* Guide box mirrors the decode ROI: a centred band covering 92% of the
          width and 62% of the height (see computeRoi wFrac/hFrac) — NOT the
          full frame. An inset full-frame box tells the operator to aim where
          the decoder never reads (L-16). objectFit: cover crops symmetric
          overflow, so the centred CSS band stays aligned with the crop. */}
      <div data-testid="roi-guide" style={{
        position: 'absolute', left: '4%', right: '4%', top: '19%', bottom: '19%',
        pointerEvents: 'none',
        border: '2px solid rgba(255,255,255,0.35)', borderRadius: 12,
      }} />

      {/* Aim rectangle: where the decoder last read. Feedback only — it is
          published from handleBarcodes AFTER the edge reject and has no say in
          whether a scan is accepted (see detectionBox). The short transition
          smooths jitter between frames without feeling detached from the badge. */}
      {aimBox && (
        <div data-testid="aim-box" aria-hidden="true" style={{
          position: 'absolute',
          left: aimBox.left,
          top: aimBox.top,
          width: aimBox.width,
          height: aimBox.height,
          border: '2px solid rgba(52,211,153,0.95)',
          borderRadius: 8,
          boxShadow: '0 0 0 1px rgba(0,0,0,0.45) inset',
          pointerEvents: 'none',
          transition: 'left 90ms linear, top 90ms linear, width 90ms linear, height 90ms linear',
        }} />
      )}

      {debugOn && (
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0, maxHeight: 130, overflow: 'auto',
          background: 'rgba(0,0,0,0.85)', color: '#a7f3d0',
          fontSize: '0.65rem', fontFamily: 'monospace', padding: '0.4rem 0.6rem',
          borderTop: '1px solid #333',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontWeight: 700 }}>DEBUG · session {sessionRef.current} · roi {roiModeRef.current} · {Math.round(detectMsRef.current.last)}ms</span>
            <button onClick={() => setDebugLogs([])} style={{ background: '#333', color: '#fff', border: 'none', borderRadius: 4, padding: '2px 6px', fontSize: '0.6rem' }}>Clear</button>
          </div>
          {debugLogs.length === 0
            ? <div style={{ opacity: 0.6 }}>waiting… hold the badge ~15cm away, keep it in the frame</div>
            : debugLogs.map((l, i) => <div key={i} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l}</div>)}
        </div>
      )}
    </div>
  )
})

export default BarcodeScanner
export { BADGE_REGEX }
