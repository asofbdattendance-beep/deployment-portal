/* eslint-disable no-empty */
import { useState, useRef, useEffect, forwardRef, useImperativeHandle, useCallback } from 'react'
import { CameraOff, RefreshCw, Zap, Focus } from 'lucide-react'
import { withTimeout, CAMERA_INIT_TIMEOUT } from '../../lib/scannerUtils'
import { openCamera, applyFocusConstraints, applyTapFocus, toggleTorch, platform } from './cameraManager'

const BADGE_REGEX = /^(FB(597[1-9]|59[89]\d|600\d|601[01])(GA|LA)\d{4}|BH\d{4}[A-Z]{1,2}\d{4}|VS[A-Z0-9]+)$/i

// ─── Device Profiles ──────────────────────────────────────────────────────────
const DEVICE_PROFILES = {
  fast:   { resolutionIndex: 0, confirmWindow: 3, confirmThreshold: 2, minInterval: 50,  maxInterval: 150, frameSkip: 0, useQualityGate: false },
  medium: { resolutionIndex: 1, confirmWindow: 4, confirmThreshold: 2, minInterval: 100, maxInterval: 300, frameSkip: 1, useQualityGate: true },
  slow:   { resolutionIndex: 2, confirmWindow: 3, confirmThreshold: 1, minInterval: 200, maxInterval: 500, frameSkip: 2, useQualityGate: true },
}

const ENGINE_LABELS = { Native: 'Optimized', WASM: 'Fallback', ZXing: 'Basic' }

// ─── Quality Thresholds (adaptive) ────────────────────────────────────────────
const QUALITY_STRICT = { MIN_BRIGHTNESS: 25, MAX_BRIGHTNESS: 230, MIN_VARIANCE: 400, MIN_CONTRAST: 15 }
const QUALITY_RELAXED = { MIN_BRIGHTNESS: 15, MAX_BRIGHTNESS: 240, MIN_VARIANCE: 200, MIN_CONTRAST: 8 }

// ─── Engine Pool ──────────────────────────────────────────────────────────────
// Priority: Native BarcodeDetector → undecaf WASM → @zxing/library JS
// Each engine tracks consecutive failures; after 3 failures, auto-switch.

function createEnginePool(debug) {
  const engines = [
    { id: 'Native', ready: false, detector: null, failures: 0, maxFailures: 3 },
    { id: 'WASM', ready: false, detector: null, failures: 0, maxFailures: 3 },
    { id: 'ZXing', ready: false, detector: null, failures: 0, maxFailures: 3 },
  ]
  let activeIndex = 0
  let zxingReader = null
  let zxingCanvas = null
  let zxingCtx = null

  const getActive = () => engines[activeIndex]

  const initNative = async () => {
    if (!('BarcodeDetector' in window)) return false
    try {
      const fmts = await window.BarcodeDetector.getSupportedFormats()
      if (!fmts.includes('code_39') && !fmts.includes('code_128')) return false
      engines[0].detector = new window.BarcodeDetector({
        formats: ['code_39', 'code_128', 'codabar', 'code_93', 'ean_13', 'ean_8'],
      })
      engines[0].ready = true
      if (debug) console.log('[Engine] Native BarcodeDetector ready')
      return true
    } catch { return false }
  }

  const initWASM = async () => {
    try {
      const { BarcodeDetectorPolyfill } = await import(/* @vite-ignore */ '@undecaf/barcode-detector-polyfill')
      if (!('BarcodeDetector' in window)) window.BarcodeDetector = BarcodeDetectorPolyfill
      engines[1].detector = new window.BarcodeDetector({
        formats: ['code_39', 'code_128', 'codabar', 'code_93', 'ean_13', 'ean_8'],
      })
      engines[1].ready = true
      if (debug) console.log('[Engine] WASM (undecaf) ready')
      return true
    } catch (e) {
      if (debug) console.warn('[Engine] WASM load failed:', e.message)
      return false
    }
  }

  const initZXing = async () => {
    try {
      const { BrowserMultiFormatReader } = await import('@zxing/library')
      zxingReader = new BrowserMultiFormatReader()
      zxingCanvas = document.createElement('canvas')
      zxingCtx = zxingCanvas.getContext('2d')
      engines[2].ready = true
      if (debug) console.log('[Engine] ZXing JS ready')
      return true
    } catch (e) {
      if (debug) console.warn('[Engine] ZXing load failed:', e.message)
      return false
    }
  }

  const init = async () => {
    const nativeOk = await initNative()
    if (nativeOk) { activeIndex = 0; return }
    const wasmOk = await initWASM()
    if (wasmOk) { activeIndex = 1; return }
    await initZXing()
    activeIndex = 2
  }

  const detect = async (video) => {
    const engine = getActive()
    if (!engine.ready || (engine.id !== 'ZXing' && !engine.detector)) {
      engine.failures = (engine.failures || 0) + 1
      if (engine.failures >= engine.maxFailures) fallback()
      return { barcodes: [], engine: engine.id }
    }

    try {
      if (engine.id === 'ZXing') {
        zxingCanvas.width = video.videoWidth || 640
        zxingCanvas.height = video.videoHeight || 480
        zxingCtx.drawImage(video, 0, 0, zxingCanvas.width, zxingCanvas.height)
        const result = await zxingReader.decodeFromCanvas(zxingCanvas)
        engine.failures = 0
        return { barcodes: result ? [{ rawValue: result.getText(), cornerPoints: [] }] : [], engine: engine.id }
      }
      const barcodes = await engine.detector.detect(video)
      engine.failures = 0
      return { barcodes: barcodes || [], engine: engine.id }
    } catch (e) {
      engine.failures++
      if (debug) console.warn(`[Engine] ${engine.id} detect error (${engine.failures}/${engine.maxFailures}):`, e.message)
      if (engine.failures >= engine.maxFailures) fallback()
      return { barcodes: [], engine: engine.id }
    }
  }

  const fallback = () => {
    const prev = getActive().id
    if (activeIndex < engines.length - 1) {
      activeIndex++
      if (debug) console.log(`[Engine] Fallback: ${prev} → ${getActive().id}`)
    } else {
      // All engines exhausted — reset after cooldown
      engines.forEach(e => { e.failures = 0; e.ready = true })
      activeIndex = 0
      if (debug) console.log('[Engine] All scan engines failed — resetting in 5s…')
      setTimeout(() => {
        engines.forEach(e => { e.failures = 0; e.ready = true })
        activeIndex = 0
        if (debug) console.log('[Engine] Engines reset')
      }, 5000)
    }
  }

  const getActiveId = () => getActive().id
  const isReady = () => engines.some(e => e.ready)

  return { init, detect, getActiveId, isReady, fallback }
}

// ─── Quality Analysis (adaptive) ──────────────────────────────────────────────

function createQualityChecker(strict = false) {
  const thresholds = strict ? QUALITY_STRICT : QUALITY_RELAXED
  const c = document.createElement('canvas')
  c.width = 64; c.height = 48
  const ctx = c.getContext('2d', { willReadFrequently: true })

  return (video, relax = false) => {
    const t = relax ? QUALITY_RELAXED : thresholds
    try {
      ctx.drawImage(video, 0, 0, 64, 48)
      const d = ctx.getImageData(0, 0, 64, 48).data
      let sum = 0, sum2 = 0, minL = 255, maxL = 0
      const n = 64 * 48
      for (let i = 0; i < n; i++) {
        const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2]
        const l = 0.299 * r + 0.587 * g + 0.114 * b
        sum += l; sum2 += l * l
        if (l < minL) minL = l
        if (l > maxL) maxL = l
      }
      const mean = sum / n
      const vari = sum2 / n - mean * mean
      const contrast = maxL - minL

      if (mean < t.MIN_BRIGHTNESS) return { ok: false, reason: 'dark' }
      if (mean > t.MAX_BRIGHTNESS) return { ok: false, reason: 'bright' }
      if (vari < t.MIN_VARIANCE) return { ok: false, reason: 'blurry' }
      if (contrast < t.MIN_CONTRAST) return { ok: false, reason: 'low-contrast' }
      return { ok: true }
    } catch { return { ok: true } }
  }
}

function getGuidanceMessage(qualityResult, elapsed, hasEverDetected, consecutiveFails) {
  if (elapsed < 2000) return null
  if (!qualityResult.ok) {
    if (qualityResult.reason === 'dark') return 'Better lighting needed'
    if (qualityResult.reason === 'bright') return 'Reduce glare'
    if (qualityResult.reason === 'blurry') return 'Hold steady'
    if (qualityResult.reason === 'low-contrast') return 'Move barcode into light'
  }
  if (elapsed > 8000 && !hasEverDetected && consecutiveFails > 10) return 'Having trouble? Use manual entry or tap video to focus'
  if (elapsed > 5000 && !hasEverDetected) return 'Align barcode within frame'
  return null
}

// ─── Component ────────────────────────────────────────────────────────────────

const BarcodeScanner = forwardRef(function BarcodeScanner({ onScan, debug = false }, ref) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const trackRef = useRef(null)
  const rafRef = useRef(null)
  const engineRef = useRef(null)
  const mountedRef = useRef(true)
  const onScanRef = useRef(onScan)
  const lastScanRef = useRef({ badge: null, time: 0 })
  const slidingWindowRef = useRef([])
  const configRef = useRef(DEVICE_PROFILES.medium)
  const qualityRef = useRef(null)
  const hasEverDetectedRef = useRef(false)
  const frameCountRef = useRef(0)
  const fpsRef = useRef({ frames: 0, last: Date.now() })
  const startTimeRef = useRef(Date.now())
  const consecutiveFailsRef = useRef(0)
  const adaptiveRelaxRef = useRef(false)
  const focusRetryRef = useRef(null)
  const timeoutRef = useRef(null)
  const pausedRef = useRef(false)
  const channelRef = useRef(null)
  const isLeaderRef = useRef(true)
  const tapFocusCleanupRef = useRef(null)
  const tapFocusTimerRef = useRef(null)
  const lastRawRef = useRef(null)
  const engineLabelRef = useRef(null)
  const guidanceMsgRef = useRef(null)

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

  // ─── Helpers ──────────────────────────────────────────────────────

  const pushDebug = useCallback((msg) => {
    if (!debug) return
    setDebugLogs(prev => [`${new Date().toLocaleTimeString()} ${msg}`, ...prev].slice(0, 25))
    try { console.log('[Scanner]', msg) } catch {}
  }, [debug])

  const stopScanner = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null }
    if (focusRetryRef.current) clearTimeout(focusRetryRef.current)
    focusRetryRef.current = null
    if (tapFocusTimerRef.current) { clearTimeout(tapFocusTimerRef.current); tapFocusTimerRef.current = null }
    if (tapFocusCleanupRef.current) { try { tapFocusCleanupRef.current() } catch {} tapFocusCleanupRef.current = null }
    channelRef.current?.close(); channelRef.current = null
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop())
    streamRef.current = null
    trackRef.current = null
    if (videoRef.current) { videoRef.current.srcObject = null; try { videoRef.current.load() } catch {} }
    slidingWindowRef.current = []
    frameCountRef.current = 0
    hasEverDetectedRef.current = false
    consecutiveFailsRef.current = 0
    adaptiveRelaxRef.current = false
  }, [])

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

  // ─── Tap to Focus ─────────────────────────────────────────────────

  const handleVideoTap = useCallback(async (e) => {
    if (!trackRef.current || !videoRef.current) return
    const rect = videoRef.current.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const y = (e.clientY - rect.top) / rect.height

    if (tapFocusCleanupRef.current) { try { tapFocusCleanupRef.current() } catch {} tapFocusCleanupRef.current = null }
    if (tapFocusTimerRef.current) { clearTimeout(tapFocusTimerRef.current); tapFocusTimerRef.current = null }

    setTapFocusActive(true)
    pushDebug(`tap-focus at (${x.toFixed(2)}, ${y.toFixed(2)})`)
    const result = await applyTapFocus(trackRef.current, x, y, debug)
    if (result?.cleanup) tapFocusCleanupRef.current = result.cleanup
    if (!mountedRef.current) return
    tapFocusTimerRef.current = setTimeout(() => {
      if (mountedRef.current) setTapFocusActive(false)
      tapFocusTimerRef.current = null
    }, 1500)
  }, [debug, pushDebug])

  // ─── Detect Loop ──────────────────────────────────────────────────

  const detectLoop = useCallback(async () => {
    if (!mountedRef.current || !engineRef.current?.isReady() || !videoRef.current || pausedRef.current) return
    const cfg = configRef.current
    frameCountRef.current++

    if (cfg.frameSkip && frameCountRef.current % (cfg.frameSkip + 1) !== 0) {
      rafRef.current = requestAnimationFrame(() => detectLoop())
      return
    }

    // Adaptive quality gate — relax after 15 consecutive fails
    const elapsed = Date.now() - startTimeRef.current
    const shouldRelax = consecutiveFailsRef.current > 15
    if (shouldRelax && !adaptiveRelaxRef.current) {
      adaptiveRelaxRef.current = true
      pushDebug('quality gate relaxed (adaptive)')
    }

    if (cfg.useQualityGate && qualityRef.current && elapsed > 5000 && !debug) {
      const q = qualityRef.current(videoRef.current, adaptiveRelaxRef.current)
      const msg = getGuidanceMessage(q, elapsed, hasEverDetectedRef.current, consecutiveFailsRef.current)
      if (msg) { if (msg !== guidanceMsgRef.current) { guidanceMsgRef.current = msg; setGuidanceMsg(msg) } }
      else if (hasEverDetectedRef.current) { if (null !== guidanceMsgRef.current) { guidanceMsgRef.current = null; setGuidanceMsg(null) } }
      if (!q.ok && !platform.isIOS) {
        pushDebug(`quality blocked: ${q.reason}`)
        rafRef.current = requestAnimationFrame(() => detectLoop())
        return
      }
    }

    const t0 = performance.now()
    const { barcodes, engine } = await engineRef.current.detect(videoRef.current)
    const elapsedMs = performance.now() - t0
    const nextDelay = Math.max(cfg.minInterval, Math.min(cfg.maxInterval, elapsedMs / 0.5))

    fpsRef.current.frames++
    if (Date.now() - fpsRef.current.last > 1000) {
      setFps(fpsRef.current.frames)
      fpsRef.current = { frames: 0, last: Date.now() }
    }

    if (barcodes && barcodes.length) {
      consecutiveFailsRef.current = 0
      for (const b of barcodes) {
        const raw = String(b.rawValue || '').trim().toUpperCase()
        if (raw !== lastRawRef.current) { lastRawRef.current = raw; setLastRaw(raw) }
        if (!BADGE_REGEX.test(raw)) {
          if (debug) pushDebug(`regex reject: ${raw}`)
          continue
        }
        // Margin check
        const margin = debug ? 0 : 0.02
        if (margin > 0 && b.cornerPoints && b.cornerPoints.length >= 4 && videoRef.current.videoWidth) {
          const cx = b.cornerPoints.reduce((s, p) => s + p.x, 0) / 4
          const cy = b.cornerPoints.reduce((s, p) => s + p.y, 0) / 4
          const vw = videoRef.current.videoWidth, vh = videoRef.current.videoHeight
          const mx = vw * margin, my = vh * margin
          if (cx < mx || cx > vw - mx || cy < my || cy > vh - my) {
            if (debug) pushDebug(`margin reject: ${raw} at ${Math.round(cx)},${Math.round(cy)}`)
            continue
          }
        }
        hasEverDetectedRef.current = true
        const { confirmed, count } = updateWindow(raw, cfg)
        if (debug) pushDebug(`window ${raw}: ${count}/${cfg.confirmThreshold} ${confirmed ? 'CONFIRMED' : ''}`)
        if (confirmed) {
          const now = Date.now()
          if (lastScanRef.current.badge === raw && now - lastScanRef.current.time < 2000) {
            if (debug) pushDebug(`debounce skip: ${raw}`)
            break
          }
          lastScanRef.current = { badge: raw, time: now }
          try { navigator.vibrate?.(80) } catch {}
          pushDebug(`SCAN OK [${engine}]: ${raw}`)
          onScanRef.current?.(raw)
          break
        }
      }
    } else {
      consecutiveFailsRef.current++
      if (debug && elapsed > 3000 && frameCountRef.current % 30 === 0) {
        pushDebug(`no barcode — fps ${fpsRef.current.frames} engine ${engine} fails:${consecutiveFailsRef.current}`)
      }
    }

    const newLabel = engineRef.current.getActiveId(); if (newLabel !== engineLabelRef.current) { engineLabelRef.current = newLabel; setEngineLabel(newLabel) }
    timeoutRef.current = setTimeout(() => { if (mountedRef.current) rafRef.current = requestAnimationFrame(detectLoop) }, nextDelay)
  }, [debug, pushDebug, updateWindow])

  // ─── Start Scanner ────────────────────────────────────────────────

  const startScanner = useCallback(async () => {
    if (!mountedRef.current) return
    stopScanner()
    if (!isLeaderRef.current) return
    // Double-tab guard — only one active scanner tab
    try {
      channelRef.current?.close()
      const ch = new BroadcastChannel('scanner-leader')
      channelRef.current = ch
      isLeaderRef.current = true
      ch.onmessage = (e) => {
        if (e.data === 'take-leader') {
          // Another tab wants to be leader — yield
          isLeaderRef.current = false
          stopScanner()
          setStatus('yielded')
          setErrorMsg('Scanner active in another tab — close that tab to use this one')
        }
      }
      // Announce we're becoming leader
      ch.postMessage('take-leader')
    } catch { /* BroadcastChannel not supported — proceed without guard */ }
    setStatus('loading')
    setErrorMsg('')
    setGuidanceMsg(null)
    setDebugLogs([])
    setLastRaw(null)
    setEngineLabel('')
    startTimeRef.current = Date.now()
    consecutiveFailsRef.current = 0
    adaptiveRelaxRef.current = false
    pushDebug('startScanner init')

    // 1. Init engine pool
    const pool = createEnginePool(debug)
    engineRef.current = pool
    await pool.init()
    if (!pool.isReady()) {
      setStatus('error')
      setErrorMsg('No barcode detection engine available — try Chrome or Edge')
      return
    }
    setEngineLabel(pool.getActiveId())

    // 2. Open camera (with timeout)
    let stream, torchSupported
    try {
      const result = await withTimeout(
        openCamera({ debug }),
        CAMERA_INIT_TIMEOUT,
        'Camera'
      )
      if (!result) throw new Error('Camera is already being opened — please wait')
      stream = result.stream
      torchSupported = result.torchSupported
    } catch (err) {
      const msg = String(err?.message || '')
      if (msg.includes('timed out')) {
        setStatus('error'); setErrorMsg('Camera took too long to start — tap Retry')
      } else if (err?.name === 'NotAllowedError') {
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
        const hint = isIOS
          ? 'Go to Settings → Safari → Camera → Allow, then tap Retry'
          : 'Click the camera icon in the address bar → Allow → Retry'
        setStatus('error'); setErrorMsg(`Camera permission denied — ${hint}`)
      } else if (err?.name === 'NotFoundError') {
        setStatus('error'); setErrorMsg('No camera found on this device')
      } else {
        setStatus('error'); setErrorMsg(msg || 'Camera failed to start')
      }
      return
    }

    if (!mountedRef.current) { stream.getTracks().forEach(t => t.stop()); return }
    streamRef.current = stream
    trackRef.current = stream.getVideoTracks()[0]
    setTorchSupported(torchSupported)

    // 3. Attach to video element
    videoRef.current.srcObject = stream
    try {
      await videoRef.current.play()
    } catch {
      setStatus('error'); setErrorMsg('Could not start video playback'); return
    }

    // 4. Apply focus constraints (THE critical fix for mobile focus)
    pushDebug('applying focus constraints...')
    const focusResult = await applyFocusConstraints(trackRef.current, { applyZoom: true, debug })
    pushDebug(`focus: ${focusResult.focusApplied ? 'continuous' : 'default'}, zoom: ${focusResult.zoomApplied ? '1.5x' : 'none'}`)

    // 5. Retry focus if first attempt didn't apply (some devices need 2-3s)
    if (!focusResult.focusApplied) {
      focusRetryRef.current = setTimeout(async () => {
        if (!mountedRef.current || !trackRef.current) return
        pushDebug('retrying focus constraints...')
        const retry = await applyFocusConstraints(trackRef.current, { applyZoom: true, debug })
        pushDebug(`focus retry: ${retry.focusApplied ? 'applied' : 'not supported'}`)
      }, 2500)
    }

    // 6. Init quality checker
    qualityRef.current = createQualityChecker()

    // 7. Profile device speed (5 frames)
    try {
      const times = []
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now()
        try { await pool.detect(videoRef.current) } catch {}
        times.push(performance.now() - t0)
      }
      const avg = times.reduce((a, b) => a + b, 0) / times.length
      const prof = avg < 30 ? 'fast' : avg < 120 ? 'medium' : 'slow'
      configRef.current = DEVICE_PROFILES[prof]
      if (platform.isIOS) configRef.current = { ...configRef.current, useQualityGate: false }
      pushDebug(`device profile: ${prof} (avg ${Math.round(avg)}ms/frame)`)
    } catch {}

    setStatus('ready')
    detectLoop()
  }, [debug, pushDebug, stopScanner, detectLoop])

  // ─── Lifecycle ────────────────────────────────────────────────────

  useEffect(() => {
    mountedRef.current = true
    startScanner()
    return () => { mountedRef.current = false; stopScanner() }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        pausedRef.current = true
        // Stop detection loop but keep camera alive
        if (rafRef.current) cancelAnimationFrame(rafRef.current)
        if (timeoutRef.current) clearTimeout(timeoutRef.current)
        rafRef.current = null
        timeoutRef.current = null
        // Disable camera track to save battery
        const track = trackRef.current
        if (track) track.enabled = false
      } else if (document.visibilityState === 'visible' && mountedRef.current) {
        if (status !== 'ready') {
          startScanner()
          return
        }
        pausedRef.current = false
        // Re-enable camera track
        const track = trackRef.current
        if (track) track.enabled = true
        // Resume detection — also re-play video if Safari paused it
        if (videoRef.current && videoRef.current.paused) {
          videoRef.current.play().catch(() => {})
        }
        detectLoop()
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [status, detectLoop, startScanner])

  useImperativeHandle(ref, () => ({ restart: startScanner, stop: stopScanner }))

  // ─── Torch Toggle ─────────────────────────────────────────────────

  const handleTorchToggle = useCallback(async () => {
    const track = trackRef.current
    if (!track) return
    setTorchOn(prev => {
      toggleTorch(track, !prev)
      return !prev
    })
  }, [])

  // ─── Error State ──────────────────────────────────────────────────

  if (status === 'error' || status === 'yielded') return (
    <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 12, padding: '1.25rem', textAlign: 'center' }}>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '0.6rem' }}><CameraOff size={28} style={{ color: '#b91c1c' }} /></div>
      <div style={{ fontWeight: 700, marginBottom: '0.4rem' }}>Camera error</div>
      <div style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: '0.9rem' }}>{errorMsg}</div>
      <button onClick={startScanner} className="btn btn-primary"><RefreshCw size={14} /> Retry</button>
    </div>
  )

  // ─── Main UI ──────────────────────────────────────────────────────

  return (
    <div style={{ position: 'relative', background: '#000', borderRadius: 12, overflow: 'hidden' }}>
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        webkit-playsinline="true"
        onClick={handleVideoTap}
        style={{ width: '100%', height: 320, objectFit: 'cover', display: 'block', cursor: 'crosshair' }}
      />

      {/* Loading overlay */}
      {status === 'loading' && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.55)', color: '#fff', fontWeight: 600 }}>
          Loading camera… {engineLabel}
        </div>
      )}

      {/* Tap-to-focus indicator */}
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

      {/* Status pills — top left */}
      <div style={{ position: 'absolute', top: 8, left: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <span className="pill" style={{ background: 'rgba(0,0,0,0.6)', color: '#fff', fontSize: '0.65rem' }}>
          {ENGINE_LABELS[engineLabel] || engineLabel || '…'} {fps ? `${fps} fps` : ''}
        </span>
        {platform.isIOS && <span className="pill" style={{ background: 'rgba(16,185,129,0.9)', color: '#fff', fontSize: '0.62rem' }}>iOS</span>}
        {lastRaw && <span className="pill" style={{ background: 'rgba(59,130,246,0.9)', color: '#fff', fontSize: '0.62rem' }}>{lastRaw}</span>}
        {adaptiveRelaxRef.current && <span className="pill" style={{ background: 'rgba(245,158,11,0.9)', color: '#fff', fontSize: '0.62rem' }}>Relaxed</span>}
      </div>

      {/* Torch — top right */}
      {torchSupported && (
        <button onClick={handleTorchToggle} style={{
          position: 'absolute', top: 8, right: 8,
          background: torchOn ? '#f59e0b' : 'rgba(0,0,0,0.6)',
          color: '#fff', border: 'none', borderRadius: 8,
          padding: '0.35rem 0.6rem', fontWeight: 700, fontSize: '0.75rem',
        }}><Zap size={12} /> {torchOn ? 'ON' : 'Torch'}</button>
      )}

      {/* Tap hint — bottom right */}
      {status === 'ready' && !hasEverDetectedRef.current && (
        <div style={{
          position: 'absolute', top: 8, right: torchSupported ? 80 : 8,
          background: 'rgba(0,0,0,0.5)', color: '#fff', borderRadius: 6,
          padding: '0.25rem 0.5rem', fontSize: '0.6rem', display: 'flex', alignItems: 'center', gap: 4,
        }}>
          <Focus size={10} /> Tap to focus
        </div>
      )}

      {/* Guidance message — bottom center */}
      {guidanceMsg && (
        <div style={{
          position: 'absolute', bottom: 10, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(0,0,0,0.7)', color: '#fff',
          padding: '0.35rem 0.7rem', borderRadius: 999,
          fontSize: '0.78rem', fontWeight: 600, whiteSpace: 'nowrap',
        }}>{guidanceMsg}</div>
      )}

      {/* Frame guide border */}
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        border: '2px solid rgba(255,255,255,0.35)', borderRadius: 12, margin: 24,
      }} />

      {/* Debug panel */}
      {debug && (
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0, maxHeight: 120, overflow: 'auto',
          background: 'rgba(0,0,0,0.85)', color: '#a7f3d0',
          fontSize: '0.65rem', fontFamily: 'monospace', padding: '0.4rem 0.6rem',
          borderTop: '1px solid #333',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontWeight: 700 }}>DEBUG</span>
            <button onClick={() => setDebugLogs([])} style={{ background: '#333', color: '#fff', border: 'none', borderRadius: 4, padding: '2px 6px', fontSize: '0.6rem' }}>Clear</button>
          </div>
          {debugLogs.length === 0
            ? <div style={{ opacity: 0.6 }}>waiting… point at FB/BH/VS badge, ensure good light, hold 15cm away</div>
            : debugLogs.map((l, i) => <div key={i} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l}</div>)
          }
        </div>
      )}

      {/* Test badge — debug only */}
      {debug && (
        <button onClick={() => onScanRef.current?.('FB5982GA0025')} style={{
          position: 'absolute', top: 40, right: 8,
          background: 'rgba(59,130,246,0.9)', color: '#fff', border: 'none', borderRadius: 6,
          padding: '0.3rem 0.5rem', fontSize: '0.65rem', fontWeight: 700,
        }}>Test FB</button>
      )}
    </div>
  )
})

export default BarcodeScanner
export { BADGE_REGEX }
