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
import { withTimeout, CAMERA_INIT_TIMEOUT, computeRoi, waitForVideoReady, isSecureCameraContext, isEdgeDetection } from '../../lib/scannerUtils'
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
import { BADGE_REGEX } from '../../lib/logic'


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
const ROI_WIDEN_AFTER = 15
// Consecutive misses before a tap-to-focus hint is offered.
const GUIDANCE_AFTER = 10

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
  const pausedRef = useRef(false)
  const channelRef = useRef(null)
  const isLeaderRef = useRef(true)
  const leaderClaimRef = useRef(0)
  const tapFocusCleanupRef = useRef(null)
  const lastRawRef = useRef(null)
  const engineLabelRef = useRef('')
  const guidanceRef = useRef(null)
  const detectMsRef = useRef({ avg: 0, last: 0 })
  const frameCountRef = useRef(0)
  const fpsRef = useRef({ frames: 0, last: Date.now() })

  const [status, setStatus] = useState('starting')
  const [errorMsg, setErrorMsg] = useState('')
  const [engineLabel, setEngineLabel] = useState('')
  const [fps, setFps] = useState(0)
  const [guidanceMsg, setGuidanceMsg] = useState(null)
  const [torchOn, setTorchOn] = useState(false)
  const [torchSupported, setTorchSupported] = useState(false)
  const [lastRaw, setLastRaw] = useState(null)
  const [debugLogs, setDebugLogs] = useState([])
  const [tapFocusActive, setTapFocusActive] = useState(false)

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

  const handleBarcodes = useCallback((barcodes, roi, engine) => {
    const cfg = configRef.current
    for (const b of barcodes) {
      const raw = String(b.rawValue || '').trim().toUpperCase()
      if (raw !== lastRawRef.current) { lastRawRef.current = raw; setLastRaw(raw) }
      if (!BADGE_REGEX.test(raw)) continue

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

      hasEverDetectedRef.current = true
      const { confirmed, count } = updateWindow(raw, cfg)
      if (debugOn) pushDebug(`window ${raw}: ${count}/${cfg.confirmThreshold} ${confirmed ? 'CONFIRMED' : ''}`)
      if (!confirmed) continue

      const now = Date.now()
      if (lastScanRef.current.badge === raw && now - lastScanRef.current.time < 2000) break
      lastScanRef.current = { badge: raw, time: now }
      try { navigator.vibrate?.(80) } catch {}
      pushDebug(`SCAN OK [${engine}]: ${raw}`)
      onScanRef.current?.(raw)
      break
    }
  }, [debugOn, pushDebug, updateWindow])

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
    if (!mountedRef.current || pausedRef.current) return
    const session = sessionRef.current
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
    if (!isCurrent(session) || !mountedRef.current) return
    // Hidden while decoding: hand control back to the visibility handler.
    if (pausedRef.current) return

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
      // Watchdog: a live preview that has never decoded anything is the
      // signature of a broken engine. Say so instead of hinting forever.
      if (engineReadyAtRef.current && !anyDecodeRef.current && Date.now() - engineReadyAtRef.current > 20000) {
        setStatus('error')
        setErrorMsg('This browser cannot read badges — try Chrome or Edge')
        return
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
      if (!isCurrent(session) || !mountedRef.current || pausedRef.current) return
      const c = configRef.current
      const wait = Math.max(c.minInterval, Math.min(c.maxInterval, (detectMs || 0) / 0.5))
      frameApiRef.current = 'timeout'
      frameHandleRef.current = setTimeout(() => {
        if (!isCurrent(session) || !mountedRef.current || pausedRef.current) { frameHandleRef.current = null; return }
        const v = videoRef.current
        if (v && typeof v.requestVideoFrameCallback === 'function') {
          frameApiRef.current = 'rvfc'
          // The session is re-checked HERE as well: a Retry between scheduling
          // and this callback would otherwise leave two permanent chains.
          frameHandleRef.current = v.requestVideoFrameCallback(() => {
            frameHandleRef.current = null
            if (!isCurrent(session) || !mountedRef.current || pausedRef.current) return
            detectLoop()
          })
        } else {
          frameApiRef.current = 'raf'
          frameHandleRef.current = requestAnimationFrame(() => {
            frameHandleRef.current = null
            if (!isCurrent(session) || !mountedRef.current || pausedRef.current) return
            detectLoop()
          })
        }
      }, wait)
    }
  }, [debugOn, pushDebug, setGuidance, isCurrent, handleBarcodes])

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
  }, [cancelFrame])

  // ─── Start ──────────────────────────────────────────────────────────

  const startScanner = useCallback(async ({ reclaim = false } = {}) => {
    if (!mountedRef.current) return
    // An explicit Retry re-claims leadership — otherwise the button on the
    // "another tab" screen is dead.
    if (reclaim) isLeaderRef.current = true
    const session = ++sessionRef.current   // any previous run is now stale
    cancelFrame()                          // reclaim the old chain's frame slot
    pausedRef.current = false
    // Fresh detection state (L-20): a Retry/restart must not inherit the
    // previous run's 2s duplicate-suppressor, its last-raw pill, its sliding
    // window, or its watchdog clock — otherwise the first post-restart scan
    // of the same badge is silently dropped, and a restart after the
    // watchdog error re-errors instantly on the stale timestamp (L-22).
    lastScanRef.current = { badge: null, time: 0 }
    lastRawRef.current = null
    slidingWindowRef.current = []
    frameCountRef.current = 0
    hasEverDetectedRef.current = false
    consecutiveFailsRef.current = 0
    roiModeRef.current = 'band'
    engineReadyAtRef.current = 0
    anyDecodeRef.current = false

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
    }

    // Start looping immediately; the loop waits for the engine on its own.
    detectLoop()

    // ── 3. Engines in the background — never block the preview.
    ensureEngines(session)
  }, [debugOn, pushDebug, setGuidance, isCurrent, detectLoop, ensureEngines, teardown, cancelFrame])

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
  useEffect(() => {
    const onVisibility = async () => {
      if (document.visibilityState === 'hidden') {
        pausedRef.current = true
        cancelFrame()
        return
      }
      if (!mountedRef.current) return
      pausedRef.current = false

      if (!isStreamLive(streamRef.current)) { startScanner(); return }

      // Resume ONLY if no loop is already scheduled. The in-flight pass, if
      // any, re-arms itself via scheduleNext once pausedRef clears — without
      // this guard we'd end up with two permanent decode chains.
      if (frameHandleRef.current != null) return

      const video = videoRef.current
      if (video) { try { await video.play() } catch {} }
      if (trackRef.current) { try { await applyFocusConstraints(trackRef.current) } catch {} }
      if (mountedRef.current && !pausedRef.current && isStreamLive(streamRef.current)) detectLoop()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [cancelFrame, detectLoop, startScanner, isCurrent])

  useImperativeHandle(ref, () => ({ restart: startScanner, stop: () => teardown() }), [startScanner, teardown])

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
        style={{ width: '100%', height: 'clamp(220px, 52vh, 420px)', objectFit: 'cover', display: 'block', cursor: 'crosshair' }}
      />

      {/* Loading overlay — also covers 'starting' so a stall is never a silent
          black rectangle. */}
      {(status === 'loading' || status === 'starting') && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.55)', color: '#fff', fontWeight: 600 }}>
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
        <button onClick={handleTorchToggle} aria-pressed={torchOn} style={{
          position: 'absolute', top: 8, right: 8,
          background: torchOn ? '#f59e0b' : 'rgba(0,0,0,0.6)',
          color: '#fff', border: 'none', borderRadius: 8,
          padding: '0.35rem 0.6rem', fontWeight: 700, fontSize: '0.75rem',
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

      {guidanceMsg && (
        <div style={{
          position: 'absolute', bottom: 10, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(0,0,0,0.7)', color: '#fff',
          padding: '0.35rem 0.7rem', borderRadius: 999,
          fontSize: '0.78rem', fontWeight: 600, whiteSpace: 'nowrap',
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
