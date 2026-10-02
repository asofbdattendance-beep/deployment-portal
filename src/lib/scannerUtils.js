/**
 * Scanner shared utilities — robustness layer for BarcodeScanner, ScannerPage,
 * DeptInchargePage, and offlineQueue.
 */

// ─── Constants ────────────────────────────────────────────────────────────────
export const SCAN_RPC_TIMEOUT = 8000   // ms — scan_in / scan_out
export const SESSION_RPC_TIMEOUT = 5000 // ms — get_open_session
export const CAMERA_INIT_TIMEOUT = 10000 // ms — getUserMedia + play
export const BUSY_SAFETY_TIMEOUT = 15000 // ms — auto-reset stuck busy flag (default; override via getBusySafetyTimeout)
export function getBusySafetyTimeout() {
  const g = typeof globalThis !== 'undefined' ? globalThis : {}
  const v = Number(g.__BUSY_SAFETY_TIMEOUT__ ?? BUSY_SAFETY_TIMEOUT)
  return Number.isFinite(v) && v > 0 ? v : BUSY_SAFETY_TIMEOUT
}
export const CACHE_TTL = 10 * 60 * 1000 // 10 minutes for preloadDeployed cache
export const MAX_DRAIN_ATTEMPTS = 12     // after this, mark permanently failed
export const SCAN_TOGGLE_GUARD_MS = 60 * 60 * 1000 // 1h — minimum dwell before an automatic IN↔OUT toggle

// ─── withinToggleGuard ────────────────────────────────────────────────────────
/**
 * Is a scan that would flip IN↔OUT too close to the opposite event to be made
 * automatically?
 *
 * The ladder itself is right — first scan IN, next scan OUT, next IN — but an
 * operator who re-scans a badge they just scanned (a double tap, a badge left
 * in front of the lens, a correction) silently writes a bogus 90-second session
 * and skews the attendance stats. So a toggle inside `windowMs` of the previous
 * event is held back for an explicit Confirm.
 *
 * Strictly-less-than: at exactly 60:00 the toggle is automatic again.
 *
 * @param {number} tsMs — epoch ms of the PREVIOUS event (open `in_date`+`in_time`,
 *   or the last CLOSED session's `out_date`+`out_time`). `NaN` when unknown.
 * @param {number} [nowMs]
 * @param {number} [windowMs]
 * @returns {boolean} true = confirm before toggling. A non-finite `tsMs` (we
 *   don't know when the last event was) is NOT guarded — we must not strand a
 *   legitimate scan behind a prompt we cannot justify. A ts in the future (clock
 *   skew between the scanner's device and the server) IS guarded: when in doubt,
 *   ask.
 */
export function withinToggleGuard(tsMs, nowMs = Date.now(), windowMs = SCAN_TOGGLE_GUARD_MS) {
  if (!Number.isFinite(tsMs)) return false
  return (nowMs - tsMs) < windowMs
}

/**
 * Human "N min" label for the confirm prompt, rounded to the nearest minute and
 * floored at 0 (a future timestamp must never read as a negative age).
 *
 * @param {number} tsMs
 * @param {number} [nowMs]
 * @returns {string} e.g. "8"
 */
export function minutesSince(tsMs, nowMs = Date.now()) {
  if (!Number.isFinite(tsMs)) return '0'
  return String(Math.max(0, Math.round((nowMs - tsMs) / 60000)))
}

// ─── isDecisionPopup ──────────────────────────────────────────────────────────
/**
 * Popup statuses that ask the operator a question which must be ANSWERED
 * before any other badge is scanned. While one of these is open, camera scans
 * are ignored so a second badge scanned behind the modal cannot silently
 * replace the pending question (the operator's Confirm click is aimed at the
 * dialog they see — if the dialog changed underneath, the click writes the
 * wrong sewadar). Answering or cancelling resumes the camera.
 *
 * Only this set is gated. `error` popups are deliberately NOT included: the
 * lookup-timeout and storage-failure paths explicitly tell the operator to
 * retry the scan, and blocking the retry would strand them. `in`/`out`
 * popups auto-dismiss and rapid back-to-back scanning must keep working.
 *
 * @param {string|null|undefined} status
 * @returns {boolean}
 */
export function isDecisionPopup(status) {
  return status === 'confirm_out' || status === 'confirm_in' || status === 'forgot'
}

// ─── withTimeout ──────────────────────────────────────────────────────────────
/**
 * Wraps a promise with a timeout. Rejects with a descriptive error if the
 * promise doesn't resolve within `ms` milliseconds.
 *
 * @template T
 * @param {PromiseLike<T>|T} promise — a real Promise, OR a supabase `rpc()`
 *   builder (a `PromiseLike` with no `.catch`). Both are accepted.
 * @param {number} ms
 * @param {string} [label] — descriptive label for the error message
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms = 8000, label = 'Operation') {
  // Every caller passes a supabase `rpc()` builder, which is a bare
  // PromiseLike: it implements `then` and has NO `catch` method. Calling
  // `.catch()` on it directly threw "promise.catch is not a function" inside
  // every scan RPC, which the Scanner page surfaced verbatim in its error
  // toast — so no scan could ever be recorded. `Promise.resolve` assimilates any
  // thenable into a real Promise and leaves a genuine Promise untouched.
  const tracked = Promise.resolve(promise)
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  // Attach a no-op late handler so a slow wrapped promise that loses the
  // race never raises unhandled-rejection noise when it settles late.
  tracked.then(() => {}, () => {});
  return Promise.race([
    tracked.catch(e => { throw e; }),
    new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(new Error(`${label} timed out after ${ms}ms`));
      });
    })
  ]).finally(() => clearTimeout(timer));
}

// ─── safeOpenDB ───────────────────────────────────────────────────────────────
/**
 * Opens IndexedDB with error handling. Returns null if IndexedDB is unavailable
 * (private browsing, storage quota, unsupported browser).
 *
 * @param {string} dbName
 * @param {number} version
 * @returns {Promise<IDBDatabase | null>}
 */
export function safeOpenDB(dbName, version) {
  return new Promise((resolve) => {
    try {
      if (!window.indexedDB) { resolve(null); return }
      const req = window.indexedDB.open(dbName, version)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('scan_queue')) db.createObjectStore('scan_queue', { keyPath: 'id' })
        if (!db.objectStoreNames.contains('sewadar_cache')) db.createObjectStore('sewadar_cache', { keyPath: 'key' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => { console.warn('[Scanner] IndexedDB open failed:', req.error); resolve(null) }
      // Some browsers fire onerror for quota/privacy — also handle blocked
      req.onblocked = () => { console.warn('[Scanner] IndexedDB blocked'); resolve(null) }
    } catch (e) {
      console.warn('[Scanner] IndexedDB unavailable:', e)
      resolve(null)
    }
  })
}

// ─── friendly ─────────────────────────────────────────────────────────────────
/**
 * Converts raw RPC / network error messages into human-readable strings.
 * Single source of truth — replaces the duplicated `friendly()` in both pages.
 *
 * @param {string} msg
 * @returns {string}
 */
export function friendly(msg) {
  const s = String(msg || '')
  if (s.includes('Invalid badge')) return 'Invalid badge format'
  if (s.includes('Badge not found')) return 'Badge not found in sewadars/VSS'
  if (s.includes('No open session')) return 'No open session to close'
  if (s.includes('Not authorized')) return 'Not authorized to scan'
  if (s.includes('Already IN')) return 'Already checked IN — please OUT first'
  if (s.includes('timed out')) return s // pass through timeout messages
  if (s.includes('Failed to fetch')) return 'Network error — will retry when online'
  return s || 'Scan failed — try again'
}

// ─── todayStrIST ──────────────────────────────────────────────────────────────
const IST_DATE_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' })

/**
 * Returns today's date as YYYY-MM-DD in IST timezone.
 * @returns {string}
 */
export function todayStrIST(d = new Date()) {
  return IST_DATE_FMT.format(d)
}

// ─── hhmmIST ───────────────────────────────────────────────────────────────────
const IST_TIME_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

/**
 * Wall-clock HH:MM in IST, independent of the DEVICE's timezone.
 *
 * `Date#getHours()` reads the scanner's local zone, but every stamp this app
 * writes or reads is IST: `out_time` is a bare `time` column
 * (`(p_ts AT TIME ZONE 'Asia/Kolkata')::time`, v41:102) and the client
 * re-interprets it as +05:30 (useScanHandler.js:382,387). A device set to
 * anything but IST therefore pre-filled the forgot-OUT with a time off by its
 * own UTC offset. `formatToParts` + explicit padding sidesteps both the h24
 * "24:00" midnight quirk and any locale-dependent zero padding.
 *
 * @param {Date} [d]
 * @returns {string} "HH:MM", 00:00–23:59
 */
export function hhmmIST(d = new Date()) {
  const parts = IST_TIME_FMT.formatToParts(d)
  const part = (type) => parts.find((p) => p.type === type)?.value ?? '00'
  return `${String(part('hour')).padStart(2, '0')}:${String(part('minute')).padStart(2, '0')}`
}

// ─── resolveForgotOutTime ──────────────────────────────────────────────────────
/**
 * Smallest legal gap between IN and OUT. `in_time`/`out_time` are `time`
 * columns and the UI edits HH:MM, so an OUT in the same minute as the IN is
 * stored as the identical minute — which v41:103-105 rejects with 'OUT time
 * must be after IN time'. One minute is the exact threshold, not a buffer.
 */
export const FORGOT_OUT_MIN_GAP_MIN = 1
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/**
 * The ONE place a forgot-OUT wall-clock is chosen, validated and clamped.
 *
 * Clamps into `[in_time + FORGOT_OUT_MIN_GAP_MIN, now]`, so the returned
 * value is always a timestamp `scan_out` will accept:
 *  - `value` null/''  → pre-fill with now, pulled into the legal window
 *  - future value     → clamped to now ('future'); v46 would otherwise doom the
 *                       follow-up re-IN with 'Timestamp cannot be in the future'
 *  - pre-IN value     → clamped to in_time + 1 min ('before_in')
 *  - malformed value  → `invalid: true`; callers keep their own "Pick a valid
 *                       OUT time" rejection and MUST check it before using `ts`
 *
 * Cross-midnight: the forgot prompt only fires past 12h and carries no date
 * input, so an HH:MM earlier than the IN wall-time is the NEXT day's
 * occurrence — otherwise a true post-midnight OUT is written on the IN's
 * date, crediting the wrong day under the event-date law. The roll applies
 * only when that next-day occurrence has already happened (≤ now); a
 * next-day occurrence still in the future keeps the same-day candidate and
 * the existing floor/future clamp decides.
 *
 * When the window is empty (`in_time + 1min > now` — the IN is itself ahead of
 * this device's clock) the floor wins: order-validity is the hard server
 * constraint, while recency only trips the 5-minute DB guard this device is
 * already failing to keep.
 *
 * @param {object} o
 * @param {string} o.inDate — YYYY-MM-DD, the open session's `in_date`
 * @param {string} [o.inTime] — HH:MM[:SS], the open session's `in_time`
 * @param {string|null} [o.value] — operator-entered "HH:MM"; null = pre-fill
 * @param {number} [o.nowMs]
 * @returns {{value: string, ts: number, clamped: 'future'|'before_in'|null, invalid: boolean, outDate: string}}
 *   `outDate` is the resolved OUT's YYYY-MM-DD in IST (may be inDate + 1).
 */
export function resolveForgotOutTime({ inDate, inTime = null, value = null, nowMs = Date.now() } = {}) {
  const inTs = inDate && inTime ? Date.parse(`${inDate}T${inTime}+05:30`) : NaN
  const lo = Number.isFinite(inTs) ? inTs + FORGOT_OUT_MIN_GAP_MIN * 60000 : -Infinity
  const hi = nowMs
  const bound = (x) => (lo > hi ? [lo, 'before_in']
    : x < lo ? [lo, 'before_in']
    : x > hi ? [hi, 'future']
    : [x, null])

  const m = HHMM_RE.exec(String(value ?? '').trim())
  const invalid = value != null && value !== '' && !m
  let cand = m && inDate ? Date.parse(`${inDate}T${m[1]}:${m[2]}:00+05:30`) : NaN
  if (Number.isFinite(cand) && Number.isFinite(inTs) && cand < inTs && cand + 86400000 <= hi) {
    cand += 86400000
  }
  const [ts, clamped] = bound(Number.isFinite(cand) ? cand : hi)
  return { value: hhmmIST(new Date(ts)), ts, clamped, invalid, outDate: todayStrIST(new Date(ts)) }
}

// ─── isTimestampStale (V14: client clock-skew budget) ─────────────────────────
/**
 * Server-matching clock-skew budgets. `scan_in`/`scan_out` (v26/v46) raise
 * 'Timestamp cannot be in the future' past now()+5min and 'Timestamp too old'
 * before now()-30d — both STRICT comparisons, so the boundary itself is
 * still accepted server-side and must read as fresh here too.
 */
export const CLOCK_SKEW_FUTURE_MS = 5 * 60 * 1000
export const CLOCK_SKEW_MAX_AGE_MS = 30 * 24 * 3600 * 1000

/**
 * Is a scan timestamp outside the window the server will accept?
 *
 * Pure pre-check used to translate a clock-skew rejection into the
 * 'Device clock looks wrong' warning (V14) — and to double-check an outgoing
 * ts against the same budget before it is sent. Warn-only: it never rewrites
 * the timestamp (unlike resolveForgotOutTime, which clamps operator input
 * into the legal window). A non-finite ts (unknown, never a skew proof) or
 * nowMs reads as fresh so a missing value can never strand a scan.
 *
 * @param {number} tsMs — epoch ms under test (e.g. Date.parse(ts))
 * @param {number} [nowMs]
 * @returns {boolean} true = more than 5 min in the future, or more than 30 days old
 */
export function isTimestampStale(tsMs, nowMs = Date.now()) {
  if (!Number.isFinite(tsMs) || !Number.isFinite(nowMs)) return false
  return tsMs > nowMs + CLOCK_SKEW_FUTURE_MS || tsMs < nowMs - CLOCK_SKEW_MAX_AGE_MS
}

// ─── isSecureCameraContext ─────────────────────────────────────────────────────
/**
 * True only when the page can actually acquire a camera. `navigator.mediaDevices`
 * is undefined on insecure origins (plain http:// on a non-localhost host) and in
 * non-browser contexts, which is the single most common "blank scanner" cause.
 * @returns {boolean}
 */
export function isSecureCameraContext() {
  if (typeof window === 'undefined') return false
  if (window.isSecureContext === false) return false
  return !!navigator?.mediaDevices?.getUserMedia
}

// ─── rgbaToGray ───────────────────────────────────────────────────────────────
/**
 * Collapse a canvas `ImageData` (4 bytes/px RGBA) to 1 byte/px grayscale.
 *
 * ZXing's `RGBLuminanceSource` decides how to read its buffer by
 * `BYTES_PER_ELEMENT`: a `Uint8ClampedArray` has value 1, so it is interpreted
 * as ALREADY-grayscale. Handing it raw RGBA therefore feeds the binarizer a
 * squashed, channel-interleaved frame and it never decodes anything. Converting
 * explicitly is the only way to get a real luminance buffer.
 *
 * Uses luma weights (0.299/0.587/0.114) rather than a flat channel average so
 * binarization sees the contrast that actually matters for a dark badge.
 *
 * One decode runs per frame, so one module-level scratch buffer is shared
 * across calls (L-21: allocating per frame stalls low-end phones in GC). The
 * buffer is only valid until the next call — the sole caller (the ZXing
 * decode path) consumes it synchronously inside the same detect() pass.
 *
 * @param {{data: Uint8ClampedArray|Uint8Array, width: number, height: number}} imageData
 * @returns {Uint8ClampedArray} length = width * height
 */
let _grayScratch = null
export function rgbaToGray(imageData) {
  const { data, width, height } = imageData || {}
  if (!data || !width || !height) return new Uint8ClampedArray(0)
  const n = width * height
  if (!_grayScratch || _grayScratch.length !== n) _grayScratch = new Uint8ClampedArray(n)
  const out = _grayScratch
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    out[i] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000
  }
  return out
}

// ─── computeRoi ────────────────────────────────────────────────────────────────
/**
 * Region-of-interest crop used for every detection pass.
 *
 * Badges are wide and short, so a centred horizontal band covers far more
 * barcode pixels than a full-frame pass while costing much less to decode —
 * that is what keeps low-end phones scanning fast. `mode: 'full'` widens the
 * crop to the whole frame, which the scanner falls back to when a band keeps
 * missing (badge held close to the lens, or a portrait capture).
 *
 * @param {number} vw — video intrinsic width
 * @param {number} vh — video intrinsic height
 * @param {{mode?: 'band'|'full', maxWidth?: number}} [opts]
 * @returns {{sx:number, sy:number, sw:number, sh:number, dw:number, dh:number, scale:number}}
 */
export function computeRoi(vw, vh, opts = {}) {
  const { mode = 'band', maxWidth = 720 } = opts
  if (!vw || !vh) return { sx: 0, sy: 0, sw: 0, sh: 0, dw: 0, dh: 0, scale: 1 }

  const wFrac = mode === 'full' ? 1 : 0.92
  const hFrac = mode === 'full' ? 1 : 0.62

  const sw = Math.max(1, Math.round(vw * wFrac))
  const sh = Math.max(1, Math.round(vh * hFrac))
  const sx = Math.max(0, Math.round((vw - sw) / 2))
  const sy = Math.max(0, Math.round((vh - sh) / 2))

  // Never upscale — only ever pay for a smaller decode surface.
  const scale = sw > maxWidth ? maxWidth / sw : 1
  const dw = Math.max(1, Math.round(sw * scale))
  const dh = Math.max(1, Math.round(sh * scale))

  return { sx, sy, sw, sh, dw, dh, scale }
}

// ─── isEdgeDetection ─────────────────────────────────────────────────────────
/**
 * True when a detection's centroid hugs the frame edge (< 2% margin).
 *
 * Points arrive in detect-canvas coordinates, so they are mapped back to
 * video pixels first (divide by the downscaled size, multiply by the crop,
 * add the crop offset) — the same mapping the inline guard in
 * BarcodeScanner.handleBarcodes used.
 *
 * L-15: the old guard required `cornerPoints.length >= 4`, which the ZXing
 * path can never satisfy (a 1D barcode yields 2 result points), so edge
 * rejection silently differed by browser/engine. Two points centroid just as
 * well as four for a centre-within-margin test, so the threshold is >= 2.
 * Fewer than 2 points (or no video size) never blocks: degenerate data must
 * not suppress a read.
 *
 * @param {Array<{x:number,y:number}>} points
 * @param {{sx:number,sy:number,sw:number,sh:number,dw:number,dh:number}} roi
 * @param {number} vw — video intrinsic width
 * @param {number} vh — video intrinsic height
 * @returns {boolean}
 */
export function isEdgeDetection(points, roi, vw, vh) {
  if (!points || points.length < 2 || !roi || !vw || !vh || !roi.dw || !roi.dh) return false
  let sx = 0, sy = 0
  for (const p of points) { sx += p.x; sy += p.y }
  const cx = (sx / points.length / roi.dw) * roi.sw + roi.sx
  const cy = (sy / points.length / roi.dh) * roi.sh + roi.sy
  const mx = vw * 0.02, my = vh * 0.02
  return cx < mx || cx > vw - mx || cy < my || cy > vh - my
}

// ─── waitForVideoReady ─────────────────────────────────────────────────────────
/**
 * Resolve once the <video> actually has frames to paint.
 *
 * Resolves rather than rejects on timeout: some devices never fire `loadeddata`
 * yet still composite the stream, and a rejected wait would strand the preview
 * on a black box — the exact failure this component is meant to eliminate.
 *
 * @param {HTMLVideoElement} video
 * @param {number} [ms]
 * @returns {Promise<{width:number, height:number, timedOut?:boolean}>}
 */
export function waitForVideoReady(video, ms = 4000) {
  return new Promise((resolve) => {
    if (!video) { resolve({ width: 0, height: 0, timedOut: true }); return }

    const detach = () => {
      clearTimeout(timer)
      video.removeEventListener?.('loadeddata', check)
      video.removeEventListener?.('loadedmetadata', check)
      video.removeEventListener?.('canplay', check)
    }

    const check = () => {
      if (video.readyState < 2 || !video.videoWidth) return false
      detach()
      resolve({ width: video.videoWidth, height: video.videoHeight })
      return true
    }

    const timer = setTimeout(() => {
      detach()
      resolve({ width: video.videoWidth || 0, height: video.videoHeight || 0, timedOut: true })
    }, ms)

    if (check()) return
    video.addEventListener?.('loadeddata', check)
    video.addEventListener?.('loadedmetadata', check)
    video.addEventListener?.('canplay', check)
  })
}
