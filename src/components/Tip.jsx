import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// Smart hover tooltip. Rendered through a PORTAL to document.body with a
// fixed-position bubble that is clamped to stay inside the viewport — so it
// is never clipped by table wrappers, accordion overflow or overlapped by the
// next row (e.g. two adjacent inactive VSS sewadars). Themed to match the app
// (white card + indigo/danger accent).
export default function Tip({ label, tone = 'default', children }) {
  const ref = useRef(null)
  const hideTimer = useRef(null)
  const [pos, setPos] = useState(null)

  const show = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    const el = ref.current
    if (!el || !label) return
    const r = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    // estimate height from the label length so long reasons flip correctly
    const estW = Math.min(300, vw - 16)
    const estH = Math.min(48 + Math.ceil(String(label).length / 42) * 16, 160)
    // prefer appearing at the anchor's left edge, rightward (badge col is
    // leftmost), but keep fully on-screen
    const left = Math.max(8, Math.min(r.left, vw - estW - 8))
    // prefer below the anchor, flip above when there's no room
    let top = r.bottom + 8
    if (top + estH > vh - 8) top = Math.max(8, r.top - estH - 8)
    setPos({ left, top })
  }

  const hide = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setPos(null), 200)
  }

  return (
    <span
      ref={ref}
      className="tip-host"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      tabIndex={0}
    >
      {children}
      {pos && createPortal(
        <div
          className={`tooltip ${tone === 'danger' ? 'tooltip-danger' : ''}`}
          style={{ left: pos.left, top: pos.top }}
          role="tooltip"
        >
          {label}
        </div>,
        document.body
      )}
    </span>
  )
}
