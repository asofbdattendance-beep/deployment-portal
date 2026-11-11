/**
 * PhotoCapture — "Take photo" fallback for phones whose live camera cannot
 * read a badge.
 *
 * The button opens the phone's own camera app through a file input with
 * `capture`. That app focuses properly (macro lens included) and returns a
 * full-resolution photo, which photoDecode reads. It also works where live
 * video is blocked (in-app browsers, denied getUserMedia), as long as the
 * browser allows file inputs.
 *
 * Camera hand-off: the live stream must let go of the camera BEFORE the
 * camera app opens (Android refuses a second camera client; iOS mutes the
 * stream and can return it dead). `onBeforeOpen` releases it; `onAfterClose`
 * takes it back once the photo is read or the operator cancels.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera } from 'lucide-react'
import { loadZxingCpp } from './zxingCppEngine'
import {
  createNativePhotoDetector,
  decodeBadgePhoto,
  loadPhotoBitmap,
  readBitmapFrame,
} from './photoDecode'
import { playScanBeep, vibrate } from '../../lib/mobile'

// Some browsers fire window focus before the file input's change event when
// the camera app returns; wait this long before treating it as a cancel.
const CANCEL_GRACE_MS = 1500
// If the page never loses focus within this long after the tap, no picker
// opened (WebViews without file-chooser support, blocked pickers): give the
// live camera straight back instead of leaving a dead preview.
const NO_PICKER_MS = 2500
const MESSAGE_MS = 5000

const MESSAGES = {
  none: 'No badge found in the photo. Fill the frame with the badge, hold it flat and try again.',
  multiple: 'More than one badge in the photo. Photograph one badge at a time.',
  unreadable_image: 'Could not open that photo. Please try again.',
  no_engine: 'The scanner is still loading. Try again in a moment.',
  declined: 'Finish the open scan result first, then try again.',
  dup: 'That badge was scanned just now.',
}

let zxingPromise = null
/** One shared zxing-cpp load for photos; a failed load is retried next time. */
function getZxing() {
  if (!zxingPromise) {
    zxingPromise = loadZxingCpp().then((fn) => {
      if (!fn) zxingPromise = null
      return fn
    })
  }
  return zxingPromise
}

/**
 * Read one photo file. Never throws.
 *
 * @param {File} file
 * @returns {Promise<import('./photoDecode').PhotoResult>}
 */
async function readPhoto(file) {
  let bitmap
  try {
    bitmap = await loadPhotoBitmap(file)
  } catch {
    return { status: 'unreadable_image', badge: null, badges: [] }
  }
  try {
    // The software decoder loads only if the native one cannot settle the
    // photo: an uncached first load must not delay a read native can make now.
    const nativeDetect = await createNativePhotoDetector()
    return await decodeBadgePhoto(bitmap, { readFrame: readBitmapFrame, nativeDetect, loadZxing: getZxing })
  } catch {
    return { status: 'none', badge: null, badges: [] }
  } finally {
    try { bitmap.close?.() } catch { /* already released */ }
  }
}

/**
 * @param {{
 *   onResult: (result: import('./photoDecode').PhotoResult & {ms: number}) => ('accepted'|'declined'|'dup'|void),
 *   onBeforeOpen?: () => void,
 *   onAfterClose?: () => void,
 *   highlight?: boolean,
 *   variant?: 'overlay'|'block',
 *   primary?: boolean,
 * }} props — `primary` styles the block button as the main action (when
 *   the live camera cannot work, e.g. inside an in-app browser).
 */
export default function PhotoCapture({ onResult, onBeforeOpen, onAfterClose, highlight = false, variant = 'overlay', primary = false }) {
  const inputRef = useRef(null)
  const pendingRef = useRef(false)
  const readingRef = useRef(false)
  const graceTimerRef = useRef(null)
  const pickerTimerRef = useRef(null)
  const messageTimerRef = useRef(null)
  const mountedRef = useRef(true)
  const [reading, setReading] = useState(false)
  const [message, setMessage] = useState(null)

  const callbacksRef = useRef({ onResult, onBeforeOpen, onAfterClose })
  callbacksRef.current = { onResult, onBeforeOpen, onAfterClose }

  const showMessage = useCallback((text) => {
    if (messageTimerRef.current) clearTimeout(messageTimerRef.current)
    setMessage(text)
    messageTimerRef.current = setTimeout(() => {
      messageTimerRef.current = null
      if (mountedRef.current) setMessage(null)
    }, MESSAGE_MS)
  }, [])

  /** End the capture flow once: give the live camera back. */
  const finish = useCallback(() => {
    if (graceTimerRef.current) { clearTimeout(graceTimerRef.current); graceTimerRef.current = null }
    if (pickerTimerRef.current) { clearTimeout(pickerTimerRef.current); pickerTimerRef.current = null }
    if (!pendingRef.current) return
    pendingRef.current = false
    callbacksRef.current.onAfterClose?.()
  }, [])

  const onWindowFocus = useCallback(() => {
    if (graceTimerRef.current) clearTimeout(graceTimerRef.current)
    graceTimerRef.current = setTimeout(() => {
      graceTimerRef.current = null
      // A chosen file means its change event is still on the way.
      if (inputRef.current?.files?.length) return
      if (pendingRef.current && !readingRef.current) finish()
    }, CANCEL_GRACE_MS)
  }, [finish])

  /** The picker really opened: the no-picker safety net is not needed. */
  const onPickerShown = useCallback(() => {
    if (pickerTimerRef.current) { clearTimeout(pickerTimerRef.current); pickerTimerRef.current = null }
  }, [])

  const open = useCallback(() => {
    const input = inputRef.current
    if (!input || readingRef.current) return
    // A previous attempt that never resolved (no event at all) must not
    // leave the button dead: close it out and start again.
    if (pendingRef.current) finish()
    pendingRef.current = true
    setMessage(null)
    callbacksRef.current.onBeforeOpen?.()
    input.value = ''
    window.addEventListener('focus', onWindowFocus, { once: true })
    window.addEventListener('blur', onPickerShown, { once: true })
    pickerTimerRef.current = setTimeout(() => {
      pickerTimerRef.current = null
      if (document.visibilityState === 'hidden' || !document.hasFocus?.()) return
      if (pendingRef.current && !readingRef.current && !input.files?.length) finish()
    }, NO_PICKER_MS)
    // Must run inside the tap's handler: browsers only open a file picker
    // from a user gesture.
    input.click()
  }, [onWindowFocus, onPickerShown, finish])

  const handleChange = useCallback(async (e) => {
    const file = e.target.files?.[0]
    if (!file) { finish(); return }
    readingRef.current = true
    setReading(true)
    const started = performance.now()
    const result = await readPhoto(file)
    const ms = Math.round(performance.now() - started)
    readingRef.current = false
    if (!mountedRef.current) return
    setReading(false)

    let outcome = result.status
    try {
      const accepted = callbacksRef.current.onResult({ ...result, ms })
      if (result.status === 'ok' && accepted && accepted !== 'accepted') outcome = accepted
    } catch { /* the page's handler failing must not strand the camera */ }

    if (outcome !== 'ok') {
      vibrate([30, 40, 30])
      playScanBeep('error')
      showMessage(MESSAGES[outcome] || MESSAGES.none)
    }
    finish()
  }, [finish, showMessage])

  // `cancel` fires when the picker or camera app closes with no photo
  // (Chrome 113+, Safari 16.4+). Older browsers rely on the focus fallback.
  useEffect(() => {
    const input = inputRef.current
    if (!input) return undefined
    const onCancel = () => finish()
    input.addEventListener('cancel', onCancel)
    return () => input.removeEventListener('cancel', onCancel)
  }, [finish])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      window.removeEventListener('focus', onWindowFocus)
      window.removeEventListener('blur', onPickerShown)
      if (messageTimerRef.current) clearTimeout(messageTimerRef.current)
      // Unmounted mid-flow (e.g. Retry swapped the error screen for the live
      // view): the scanner must still learn the camera app is done.
      finish()
    }
  }, [onWindowFocus, onPickerShown, finish])

  const input = (
    <input
      ref={inputRef}
      type="file"
      accept="image/*"
      capture="environment"
      onChange={handleChange}
      tabIndex={-1}
      aria-hidden="true"
      data-testid="photo-input"
      style={{ display: 'none' }}
    />
  )

  if (variant === 'block') {
    return (
      <div style={{ display: 'grid', gap: '0.5rem', justifyItems: 'center' }}>
        {input}
        <button
          type="button"
          onClick={open}
          disabled={reading}
          className={primary ? 'btn btn-primary' : 'btn btn-ghost'}
          style={{ minHeight: 44, minWidth: 44, touchAction: 'manipulation' }}
        >
          <Camera size={14} aria-hidden="true" /> {reading ? 'Reading photo…' : 'Take a photo of the badge'}
        </button>
        <div role="status" style={{ fontSize: '0.8rem', color: '#b91c1c', maxWidth: '32ch', minHeight: message ? undefined : 0 }}>{message}</div>
      </div>
    )
  }

  // Bar variant: sits UNDER the viewfinder, outside it, so it never covers
  // the aiming box or guidance pills and never shifts the guide box (which is
  // laid out as a percentage of the viewfinder to mirror the decode ROI).
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
      marginTop: 6, padding: '6px 6px 6px 12px', borderRadius: 10,
      background: message ? '#fef2f2' : highlight ? '#ecfdf5' : '#f1f5f9',
      border: `1px solid ${message ? '#fecaca' : highlight ? '#a7f3d0' : '#e2e8f0'}`,
    }}>
      {input}
      <span role="status" style={{
        fontSize: '0.8rem', fontWeight: 600, minWidth: 0,
        color: message ? '#b91c1c' : highlight ? '#047857' : '#475569',
      }}>
        {reading ? 'Reading photo…' : message || (highlight ? 'Not reading? Take a photo instead.' : 'Camera not reading? Use a photo.')}
      </span>
      <button
        type="button"
        onClick={open}
        disabled={reading}
        aria-label="Take a photo of the badge"
        title="Take a photo of the badge"
        className={highlight ? 'btn btn-success' : 'btn btn-ghost'}
        data-highlight={highlight ? 'true' : undefined}
        style={{ flexShrink: 0, minHeight: 44, minWidth: 44, touchAction: 'manipulation' }}
      >
        <Camera size={15} aria-hidden="true" />
        <span>{reading ? 'Reading…' : 'Photo'}</span>
      </button>
    </div>
  )
}
