/**
 * Mobile helpers — pure, dependency-free, SSR-safe.
 *
 * Every function guards `typeof window/navigator` so the module imports
 * cleanly in node (unit tests) and SSR. Feature-detect, never UA-sniff:
 * a missing API degrades to the desktop-equivalent behaviour, never throws.
 */

/** The single mobile query. ≤768px wide, OR a short landscape viewport on a
 *  coarse pointer (a phone held sideways is ≥769px wide, so width alone
 *  misses it). The single source of truth — useMediaQuery imports this. */
export const MOBILE_QUERY = '(max-width: 768px), (max-height: 500px) and (pointer: coarse)'

/**
 * Ordered device tiers (upper bound, px). Keep in sync with index.css
 * "Device-tier contract" and useMediaQuery. Pure (testable in node).
 * T0 ≤359 · T1 360–413 · T2 414–480 · T3 481–640 · T4 641–768 (cards) ·
 * T5 769–1024 · T6 1025–1440 · T7 ≥1441.
 */
export const DEVICE_TIERS = [
  { name: 'tiny', maxWidth: 359 },
  { name: 'phone', maxWidth: 413 },
  { name: 'large-phone', maxWidth: 480 },
  { name: 'phablet', maxWidth: 640 },
  { name: 'tablet-portrait', maxWidth: 768 },
  { name: 'tablet-landscape', maxWidth: 1024 },
  { name: 'laptop', maxWidth: 1440 },
  { name: 'desktop', maxWidth: Infinity },
]

/** Width → tier name. Non-finite input → 'desktop' (safe default). */
export function tierForWidth(width) {
  const w = Number(width)
  if (!Number.isFinite(w)) return 'desktop'
  const hit = DEVICE_TIERS.find((t) => w <= t.maxWidth)
  return hit ? hit.name : 'desktop'
}

/** True on coarse-pointer / touch hardware. False in node/SSR. */
export function isTouchDevice() {
  if (typeof window === 'undefined') return false
  try {
    if (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) return true
  } catch { /* ignore */ }
  try {
    if ('ontouchstart' in window) return true
    if (typeof navigator !== 'undefined' && Number(navigator.maxTouchPoints || 0) > 0) return true
  } catch { /* ignore */ }
  return false
}

/** True when launched from the home screen (standalone PWA). */
export function isStandalone() {
  if (typeof window === 'undefined') return false
  try {
    if (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches) return true
  } catch { /* ignore */ }
  try {
    if (typeof navigator !== 'undefined' && navigator.standalone === true) return true
  } catch { /* ignore */ }
  return false
}

/**
 * CSS `max()` value that respects the home-indicator safe area.
 * Usage: `style={{ paddingBottom: safeBottom('0.85rem') }}`.
 * Resolves to the fallback alone where safe-area is unsupported.
 */
export function safeBottom(fallback = '0.85rem') {
  return `max(${fallback}, env(safe-area-inset-bottom))`
}

/** Same for top (notch) inset. */
export function safeTop(fallback = '0px') {
  return `max(${fallback}, env(safe-area-inset-top))`
}

/** 1234 → "1.2k". Returns '' for non-finite input. */
export function compactCount(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return ''
  if (v < 1000) return String(Math.trunc(v))
  const units = [[1e9, 'b'], [1e6, 'm'], [1e3, 'k']]
  for (const [div, suffix] of units) {
    if (v >= div) {
      const s = (v / div).toFixed(1).replace(/\.0$/, '')
      return `${s}${suffix}`
    }
  }
  return String(Math.trunc(v))
}

/** Build a File for the Web Share API. Null when File is unavailable. */
export function fileForShare(blob, filename, mime) {
  if (typeof File === 'undefined' || !blob) return null
  try {
    return new File([blob], filename, { type: mime || blob.type || 'application/octet-stream' })
  } catch {
    return null
  }
}

/** True when navigator.share can share the given files. Never throws. */
export function canShareFiles(files) {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.canShare !== 'function') return false
    if (!Array.isArray(files) || files.length === 0) return false
    return navigator.canShare({ files })
  } catch {
    return false
  }
}

/**
 * Anchor download fallback. Returns true when a download was triggered.
 * Never throws — callers treat false as "show the unavailable sheet".
 */
export function downloadBlob(blob, filename) {
  try {
    if (typeof window === 'undefined' || typeof document === 'undefined' || !blob) return false
    const url = (window.URL || URL).createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename || 'download'
    // Must be in the DOM for the click to fire on iOS Safari.
    document.body.appendChild(a)
    a.click()
    // Revoke on a tick so iOS can start reading the blob first.
    setTimeout(() => {
      try { document.body.removeChild(a) } catch { /* ignore */ }
      try { (window.URL || URL).revokeObjectURL(url) } catch { /* ignore */ }
    }, 1000)
    return true
  } catch {
    return false
  }
}

/**
 * Deliver a file on mobile: Web Share sheet first (Shares to Files /
 * Drive / WhatsApp — the only reliable "save" on iOS Safari), anchor
 * download fallback otherwise. MUST be called from a user gesture for
 * the share path; the export-sheet pattern is: build the blob on tap-1,
 * call this on the explicit Share tap (tap-2) so the gesture is fresh.
 *
 * Never throws. Returns { method: 'share' | 'download' | 'unavailable' }.
 */
export async function shareOrDownload(blob, filename, mime) {
  if (!blob) return { method: 'unavailable' }
  const name = filename || 'download'
  try {
    const file = fileForShare(blob, name, mime)
    if (file && canShareFiles([file]) && typeof navigator.share === 'function') {
      await navigator.share({ files: [file], title: name })
      return { method: 'share' }
    }
  } catch (err) {
    // AbortError = user dismissed the sheet — not a failure, not a fallback.
    if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) return { method: 'share' }
    // Any other share failure falls through to download below.
  }
  return downloadBlob(blob, name) ? { method: 'download' } : { method: 'unavailable' }
}

/**
 * Fire a haptic tick. Returns true when a vibration was requested.
 * Guarded — desktop and unsupported browsers return false silently.
 */
export function vibrate(pattern = 40) {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      return navigator.vibrate(pattern)
    }
  } catch { /* ignore */ }
  return false
}

/**
 * Keep the screen awake while scanning. Returns the WakeLockSentinel or
 * null when unsupported/denied. Callers must re-acquire on
 * visibilitychange (the lock releases when the tab hides) and release on
 * unmount via releaseWakeLock().
 */
export async function requestWakeLock() {
  try {
    if (typeof navigator !== 'undefined' && navigator.wakeLock && typeof navigator.wakeLock.request === 'function') {
      return await navigator.wakeLock.request('screen')
    }
  } catch { /* ignore */ }
  return null
}

/** Release a sentinel from requestWakeLock(). Never throws. */
export async function releaseWakeLock(sentinel) {
  try {
    if (sentinel && typeof sentinel.release === 'function') await sentinel.release()
  } catch { /* ignore */ }
}
