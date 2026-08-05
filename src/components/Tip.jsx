import { useRef, useState } from 'react'

// Smart hover tooltip. Renders a fixed-position bubble that is clamped to
// stay inside the viewport (so it never gets clipped on the left/right edge
// or overlapped by other table objects). Themed to match the app (white
// card + indigo/danger accent).
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
    const estW = Math.min(300, vw - 16)
    const estH = 64
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
    hideTimer.current = setTimeout(() => setPos(null), 120)
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
      {pos && (
        <div
          className={`tooltip ${tone === 'danger' ? 'tooltip-danger' : ''}`}
          style={{ left: pos.left, top: pos.top }}
          role="tooltip"
        >
          {label}
        </div>
      )}
    </span>
  )
}
