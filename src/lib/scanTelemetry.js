/**
 * scanTelemetry — background device log for the camera scanner (v85).
 *
 * The scanner reads badges on most phones but not all, and until this module
 * nothing recorded which phones fail. Each event (a read, a photo that held no
 * badge, a camera session summary, a camera error) is stamped with the
 * device's platform, browser and in-app host, queued, and sent in batches to
 * log_scanner_telemetry. scanner_device_report() then shows which devices
 * open the camera and never read.
 *
 * Rules:
 *  - Never throws and never blocks a scan: every path is guarded.
 *  - Never sends the badge of the person scanned. The scanner's own badge is
 *    added server-side from the JWT.
 *  - Offline-tolerant: the queue is mirrored to localStorage (capped), so
 *    events from a hall with no signal go out on the next connection.
 *  - Self-disabling: a missing RPC (frontend shipped before v85) switches it
 *    off for the page's lifetime. An expired session only pauses it.
 */
import { supabase } from './supabase'

export const TELEMETRY_STORAGE_KEY = 'sdp.scanTelemetry.v1'
export const TELEMETRY_MAX_QUEUE = 200
export const TELEMETRY_BATCH = 50
export const TELEMETRY_FLUSH_AT = 20
export const TELEMETRY_FLUSH_INTERVAL_MS = 30000
/** After a failed send, record() waits this long before auto-flushing again. */
export const TELEMETRY_RETRY_BACKOFF_MS = 15000

const EVENTS = new Set(['read', 'photo_fail', 'session', 'camera_error'])
const INPUTS = new Set(['live', 'photo'])
const TEXT_FIELDS = { engine: 24, platform: 24, browser: 24, in_app: 24, user_agent: 300, lens_label: 80 }
const INT_FIELDS = ['stream_w', 'stream_h', 'ms', 'misses', 'ts']
const MAX_DETAIL_CHARS = 2000
const UA_MAX = 300

/* ─── Device classification ─────────────────────────────────────────────── */

const IN_APP_RULES = [
  ['whatsapp', /WhatsApp/i],
  ['instagram', /Instagram/i],
  ['facebook', /FBAN|FBAV|FB_IAB|FBIOS/],
  ['telegram', /Telegram/i],
  ['snapchat', /Snapchat/i],
  ['line', /\bLine\//],
]

/**
 * Name the in-app browser a page is running in, or null for a real browser.
 * In-app web views often deny the camera outright, so this is the first
 * thing to check when a phone "cannot scan".
 *
 * @param {string} [ua]
 * @returns {string|null}
 */
export function detectInAppBrowser(ua) {
  const s = String(ua || '')
  if (!s) return null
  for (const [name, re] of IN_APP_RULES) if (re.test(s)) return name
  if (/Android/.test(s) && /; wv\)/.test(s)) return 'android_webview'
  // iOS: every real browser sends "Safari/" (Chrome adds CriOS, Firefox
  // FxiOS, Edge EdgiOS); a bare WKWebView sends none of them.
  if (/iPhone|iPad|iPod/.test(s) && /AppleWebKit/.test(s) && !/Safari\/|CriOS|FxiOS|EdgiOS/.test(s)) return 'ios_webview'
  return null
}

/**
 * @param {string} [ua]
 * @returns {{platform: string, browser: string, in_app: string|null, user_agent: string}}
 */
export function deviceContext(ua) {
  const s = String(ua || '')
  const inApp = detectInAppBrowser(s)
  const platform = /iPhone|iPad|iPod/.test(s) ? 'ios'
    : /Android/.test(s) ? 'android'
      : /Windows|Macintosh|Linux|CrOS/.test(s) ? 'desktop' : 'other'
  const browser = inApp ? 'webview'
    : /SamsungBrowser/.test(s) ? 'samsung'
      : /EdgA?\/|EdgiOS/.test(s) ? 'edge'
        : /Firefox|FxiOS/.test(s) ? 'firefox'
          : /Chrome\/|CriOS/.test(s) ? 'chrome'
            : /Safari\//.test(s) ? 'safari' : 'other'
  return { platform, browser, in_app: inApp, user_agent: s.slice(0, UA_MAX) }
}

/* ─── Event shaping ─────────────────────────────────────────────────────── */

function cleanDetail(detail) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null
  try {
    const text = JSON.stringify(detail)
    return text.length <= MAX_DETAIL_CHARS ? JSON.parse(text) : null
  } catch {
    return null
  }
}

/**
 * Keep only the fields the server accepts, in the shapes it accepts.
 * Returns a new object, or null when the event is not one we log.
 *
 * @param {Record<string, unknown>|null|undefined} evt
 * @returns {Record<string, unknown>|null}
 */
export function sanitizeEvent(evt) {
  if (!evt || typeof evt !== 'object' || !EVENTS.has(evt.event)) return null
  const out = { event: evt.event }
  if (INPUTS.has(evt.input)) out.input = evt.input
  for (const [key, max] of Object.entries(TEXT_FIELDS)) {
    if (typeof evt[key] === 'string' && evt[key]) out[key] = evt[key].slice(0, max)
  }
  for (const key of INT_FIELDS) {
    const n = Number(evt[key])
    if (evt[key] != null && Number.isFinite(n) && n >= 0) out[key] = Math.round(n)
  }
  const zoom = Number(evt.zoom)
  if (evt.zoom != null && Number.isFinite(zoom) && zoom > 0 && zoom < 100) out.zoom = Math.round(zoom * 1000) / 1000
  const detail = cleanDetail(evt.detail)
  if (detail) out.detail = detail
  return out
}

/**
 * Errors that will never succeed in this page's lifetime: the RPC is not
 * deployed yet (PGRST202 / 42883 / 404). Not 42501: an expired session also
 * raises it, and the next token refresh makes the same batch succeed.
 *
 * @param {{code?: string, status?: number}|null|undefined} error
 */
export function isFatalTelemetryError(error) {
  if (!error) return false
  if (error.status === 404) return true
  return ['PGRST202', '42883'].includes(String(error.code || ''))
}

/** A batch the server answered with an error this many times is dropped. */
export const TELEMETRY_MAX_BATCH_FAILURES = 3

/* ─── Queue ─────────────────────────────────────────────────────────────── */

function readStored(storage) {
  try {
    const raw = storage?.getItem(TELEMETRY_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(e => e && EVENTS.has(e.event)).slice(-TELEMETRY_MAX_QUEUE) : []
  } catch {
    return []
  }
}

function writeStored(storage, queue) {
  try {
    if (!storage) return
    if (queue.length === 0) storage.removeItem?.(TELEMETRY_STORAGE_KEY)
    else storage.setItem(TELEMETRY_STORAGE_KEY, JSON.stringify(queue))
  } catch { /* storage full or blocked: the in-memory queue still works */ }
}

/**
 * @param {{
 *   send: (batch: object[]) => Promise<{error: unknown}>,
 *   storage?: Storage|null,
 *   now?: () => number,
 *   context?: () => object,
 *   autoFlush?: boolean,
 * }} deps
 */
export function createTelemetry({ send, storage = null, now = Date.now, context = () => ({}), autoFlush = true }) {
  let queue = readStored(storage)
  let inflight = null
  let off = false
  let lastFailAt = -Infinity
  let batchFailures = 0

  const setQueue = (next) => {
    queue = next
    writeStored(storage, queue)
  }

  async function sendBatch() {
    const batch = queue.slice(0, TELEMETRY_BATCH)
    let error
    try {
      const res = await send(batch)
      error = res?.error || null
    } catch (e) {
      error = { message: e?.message || 'send failed' }
    }
    // Remove exactly the rows sent: record() may have trimmed the queue's
    // head while the request was in flight, so a positional slice could
    // drop unsent rows.
    const sent = new Set(batch)
    if (!error) {
      batchFailures = 0
      setQueue(queue.filter(e => !sent.has(e)))
      return
    }
    lastFailAt = now()
    if (isFatalTelemetryError(error)) {
      off = true
      setQueue([])
      return
    }
    // A network failure has no code and is retried indefinitely. A batch the
    // SERVER keeps rejecting would otherwise block every later event.
    if (error.code) {
      batchFailures += 1
      if (batchFailures >= TELEMETRY_MAX_BATCH_FAILURES) {
        batchFailures = 0
        setQueue(queue.filter(e => !sent.has(e)))
      }
    }
  }

  /** Send queued events. Resolves (never rejects); one batch at a time. */
  function flush() {
    if (off || queue.length === 0) return Promise.resolve()
    if (inflight) return inflight
    inflight = sendBatch().finally(() => { inflight = null })
    return inflight
  }

  /** Queue one event. Unknown events are dropped silently. */
  function record(evt) {
    if (off) return
    let ctx
    try { ctx = context() || {} } catch { ctx = {} }
    const clean = sanitizeEvent({ ...ctx, ...evt, ts: now() })
    if (!clean) return
    setQueue([...queue, clean].slice(-TELEMETRY_MAX_QUEUE))
    // Offline, every new event would otherwise retry at once; the interval
    // and 'online' flushes still retry on their own schedule.
    if (autoFlush && queue.length >= TELEMETRY_FLUSH_AT && now() - lastFailAt >= TELEMETRY_RETRY_BACKOFF_MS) flush()
  }

  return {
    record,
    flush,
    pending: () => queue.length,
    disabled: () => off,
  }
}

/* ─── App singleton ─────────────────────────────────────────────────────── */

function safeLocalStorage() {
  try { return typeof window !== 'undefined' ? window.localStorage : null } catch { return null }
}

let cachedContext = null
function browserContext() {
  if (!cachedContext) {
    cachedContext = deviceContext(typeof navigator !== 'undefined' ? navigator.userAgent : '')
  }
  return cachedContext
}

export const scanTelemetry = createTelemetry({
  send: (batch) => supabase.rpc('log_scanner_telemetry', { p_events: batch }),
  storage: safeLocalStorage(),
  context: browserContext,
})

/**
 * Flush on a timer, when the page is hidden (the last chance before a tab is
 * killed) and when the network returns. Returns a cleanup function.
 *
 * @param {{flush: () => Promise<void>}} [telemetry]
 */
export function installTelemetryFlush(telemetry = scanTelemetry) {
  if (typeof window === 'undefined') return () => {}
  const flush = () => { telemetry.flush() }
  const onHidden = () => { if (document.visibilityState === 'hidden') flush() }
  const timer = setInterval(flush, TELEMETRY_FLUSH_INTERVAL_MS)
  document.addEventListener('visibilitychange', onHidden)
  window.addEventListener('online', flush)
  flush()
  return () => {
    clearInterval(timer)
    document.removeEventListener('visibilitychange', onHidden)
    window.removeEventListener('online', flush)
  }
}
