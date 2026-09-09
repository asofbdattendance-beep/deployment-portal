import { useEffect, useRef, useState, useCallback } from 'react'
import { CheckCircle2, LogOut, AlertTriangle, Clock, XCircle, X, WifiOff } from 'lucide-react'

const VARIANT = {
  in: {
    label: 'Checked In',
    icon: CheckCircle2,
    accent: '#10b981',
    bg: '#ecfdf5',
    border: '#a7f3d0',
    iconBg: '#ecfdf5',
    iconColor: '#059669',
  },
  out: {
    label: 'Checked Out',
    icon: LogOut,
    accent: '#6366f1',
    bg: '#eef2ff',
    border: '#c7d2fe',
    iconBg: '#eef2ff',
    iconColor: '#4f46e5',
  },
  flagged: {
    label: 'Flagged',
    icon: AlertTriangle,
    accent: '#f59e0b',
    bg: '#fffbeb',
    border: '#fde68a',
    iconBg: '#fffbeb',
    iconColor: '#b45309',
  },
  queued: {
    label: 'Queued offline',
    icon: WifiOff,
    accent: '#f59e0b',
    bg: '#fffbeb',
    border: '#fde68a',
    iconBg: '#fffbeb',
    iconColor: '#b45309',
  },
  offline: {
    label: 'Queued offline',
    icon: WifiOff,
    accent: '#f59e0b',
    bg: '#fffbeb',
    border: '#fde68a',
    iconBg: '#fffbeb',
    iconColor: '#b45309',
  },
  error: {
    label: 'Scan failed',
    icon: XCircle,
    accent: '#ef4444',
    bg: '#fef2f2',
    border: '#fecaca',
    iconBg: '#fef2f2',
    iconColor: '#dc2626',
  },
  forgot: {
    label: 'Forgot OUT?',
    icon: Clock,
    accent: '#f59e0b',
    bg: '#fffbeb',
    border: '#fde68a',
    iconBg: '#fffbeb',
    iconColor: '#b45309',
  },
}

/**
 * ScanResultPopup — centered modal with backdrop-blur.
 *
 * Replaces the inline `lastScan` / `showOutPrompt` divs in
 * DeptInchargePage (160-205) and ScannerPage (64-78).
 *
 * Props
 *  open            boolean — controls visibility (with enter/exit transition)
 *  status          'in' | 'out' | 'flagged' | 'queued' | 'error' | 'forgot' | 'offline'
 *                  alias `variant` is also accepted
 *  variant         alias for status
 *  badge           string — FB/BH/VS badge number
 *  name            string — sewadar name (optional)
 *  centre          string — centre name (optional)
 *  deptName        string — department name (optional)
 *  time            string — formatted time e.g. "10:42:11 AM"
 *  message         string — subtitle / detail line (e.g. error msg)
 *  flag            string — amber flag text (e.g. "Not in my dept")
 *  openSince       string — for forgot: "2026-08-30 08:12:00"
 *  outTime         string — HH:MM controlled value for forgot time input
 *  onOutTimeChange (val:string) => void
 *  onClose         () => void — backdrop / ESC / Cancel
 *  onConfirm       () => void — primary action (Done / Confirm OUT)
 *  confirmLabel    string — overrides default primary label
 *  dismissible     boolean — if false, backdrop click is ignored (forgot)
 */
export default function ScanResultPopup({
  open,
  status,
  variant,
  badge,
  name,
  centre,
  deptName,
  time,
  message,
  flag,
  openSince,
  outTime,
  onOutTimeChange,
  onClose,
  onConfirm,
  confirmLabel,
  dismissible,
}) {
  const key = (variant || status || 'in').toLowerCase()
  const cfg = VARIANT[key] || VARIANT.in
  const Icon = cfg.icon

  // allow explicit dismissible override; forgot defaults to non-dismissible via backdrop
  const isForgot = key === 'forgot'
  const canBackdropClose = dismissible !== undefined ? dismissible : !isForgot

  const overlayRef = useRef(null)
  const primaryRef = useRef(null)
  const [visible, setVisible] = useState(false)
  const [mounted, setMounted] = useState(false)

  // mount / unmount with exit transition
  useEffect(() => {
    if (open) {
      setMounted(true)
      // next frame -> visible for transition
      requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)))
    } else {
      setVisible(false)
      const t = setTimeout(() => setMounted(false), 200)
      return () => clearTimeout(t)
    }
  }, [open])

  // focus primary on open
  useEffect(() => {
    if (!mounted || !visible) return
    const id = setTimeout(() => primaryRef.current?.focus(), 60)
    return () => clearTimeout(id)
  }, [mounted, visible])

  // ESC + focus trap
  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') {
      if (canBackdropClose) onClose?.()
      return
    }
    if (e.key === 'Tab' && mounted) {
      const root = overlayRef.current
      if (!root) return
      const focusable = root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
  }, [mounted, onClose, canBackdropClose])

  useEffect(() => {
    if (!mounted) return
    document.addEventListener('keydown', handleKeyDown)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = prevOverflow
    }
  }, [mounted, handleKeyDown])

  if (!mounted) return null

  const title = (() => {
    if (isForgot) return 'Forgot OUT?'
    if (key === 'in') return flag ? 'Checked In — Flagged' : 'Checked In'
    if (key === 'out') return 'Checked Out'
    if (key === 'flagged') return 'Flagged — Not deployed'
    if (key === 'queued' || key === 'offline') return 'Queued offline'
    if (key === 'error') return 'Scan failed'
    return cfg.label
  })()

  const primaryLabel = confirmLabel || (isForgot ? 'Close OUT then IN' : 'Done')

  return (
    <div
      ref={overlayRef}
      role="presentation"
      onClick={(e) => { if (e.target === e.currentTarget && canBackdropClose) onClose?.() }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
        background: visible ? 'rgba(15,23,42,0.48)' : 'rgba(15,23,42,0)',
        backdropFilter: visible ? 'blur(8px)' : 'blur(0px)',
        WebkitBackdropFilter: visible ? 'blur(8px)' : 'blur(0px)',
        opacity: visible ? 1 : 0,
        transition: 'opacity 220ms cubic-bezier(0.16,1,0.3,1), background 220ms cubic-bezier(0.16,1,0.3,1), backdrop-filter 220ms cubic-bezier(0.16,1,0.3,1)',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="scan-popup-title"
        aria-describedby={message || flag ? 'scan-popup-desc' : undefined}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 380,
          background: '#fff',
          borderRadius: 16,
          border: '1px solid var(--border)',
          boxShadow: visible
            ? '0 20px 60px rgba(15,23,42,0.18), 0 1px 3px rgba(15,23,42,0.08)'
            : '0 8px 24px rgba(15,23,42,0.08)',
          overflow: 'hidden',
          transform: visible ? 'scale(1) translateY(0)' : 'scale(0.96) translateY(8px)',
          opacity: visible ? 1 : 0,
          transition: 'transform 260ms cubic-bezier(0.16,1,0.3,1), opacity 200ms ease, box-shadow 260ms ease',
          willChange: 'transform, opacity',
        }}
      >
        {/* accent hairline */}
        <div style={{ height: 3, background: cfg.accent }} />

        {/* close X — hidden for forgot unless dismissible explicitly */}
        {canBackdropClose && (
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              position: 'absolute',
              top: 12,
              right: 12,
              width: 30,
              height: 30,
              borderRadius: 999,
              border: '1px solid var(--border)',
              background: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              color: 'var(--text-muted)',
            }}
          >
            <X size={14} />
          </button>
        )}

        <div style={{ padding: '1.35rem 1.35rem 1.1rem' }}>
          {/* icon + title */}
          <div style={{ display: 'flex', gap: '0.85rem', alignItems: 'flex-start' }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 999,
                background: cfg.iconBg,
                border: `1px solid ${cfg.border}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                color: cfg.iconColor,
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.8)',
              }}
            >
              <Icon size={22} strokeWidth={2} />
            </div>
            <div style={{ flex: 1, minWidth: 0, paddingRight: canBackdropClose ? 28 : 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <h3 id="scan-popup-title" style={{ fontSize: '1rem', fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.2, color: 'var(--text)' }}>
                  {title}
                </h3>
                {/* status pill */}
                <span
                  className="pill"
                  style={{
                    fontSize: '0.62rem',
                    padding: '0.15rem 0.5rem',
                    background: cfg.bg,
                    color: cfg.iconColor,
                    border: `1px solid ${cfg.border}`,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                  }}
                >
                  {key === 'in' ? 'IN' : key === 'out' ? 'OUT' : key.toUpperCase()}
                </span>
              </div>

              {/* badge */}
              {badge && (
                <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span
                    style={{
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      fontSize: '0.82rem',
                      fontWeight: 700,
                      letterSpacing: '0.02em',
                      background: 'var(--surface-2)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      padding: '0.2rem 0.55rem',
                      color: 'var(--text)',
                    }}
                  >
                    {badge}
                  </span>
                  {time && (
                    <span style={{ fontSize: '0.76rem', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                      · {time}
                    </span>
                  )}
                </div>
              )}

              {/* name + centre + dept */}
              {(name || centre || deptName) && (
                <div style={{ marginTop: 8, fontSize: '0.84rem', lineHeight: 1.45 }}>
                  {name && <div style={{ fontWeight: 700, color: 'var(--text)' }}>{name}</div>}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                    {centre && <span className="pill pill-gray" style={{ fontSize: '0.7rem' }}>{centre}</span>}
                    {deptName && <span className="pill pill-blue" style={{ fontSize: '0.68rem', border: '1px solid #c7d2fe' }}>{deptName}</span>}
                    {isForgot && <span className="pill pill-amber" style={{ fontSize: '0.66rem' }}> &gt; 12h open</span>}
                  </div>
                </div>
              )}

              {/* message / flag */}
              {(message || flag) && (
                <div id="scan-popup-desc" style={{ marginTop: 10 }}>
                  {flag && (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        fontSize: '0.78rem',
                        fontWeight: 700,
                        color: '#b45309',
                        background: '#fffbeb',
                        border: '1px solid #fde68a',
                        borderRadius: 8,
                        padding: '0.4rem 0.6rem',
                      }}
                    >
                      <AlertTriangle size={13} /> {flag}
                    </div>
                  )}
                  {message && !flag && (
                    <div style={{ fontSize: '0.82rem', color: key === 'error' ? '#b91c1c' : 'var(--text-sec)', lineHeight: 1.45 }}>
                      {message}
                    </div>
                  )}
                  {message && flag && (
                    <div style={{ marginTop: 6, fontSize: '0.78rem', color: 'var(--text-sec)', lineHeight: 1.4 }}>{message}</div>
                  )}
                </div>
              )}

              {/* queued hint */}
              {(key === 'queued' || key === 'offline') && !message && (
                <div style={{ marginTop: 8, fontSize: '0.76rem', color: '#b45309' }}>
                  Jammer / offline — will sync when online.
                </div>
              )}
            </div>
          </div>

          {/* Forgot OUT — open since + time input */}
          {isForgot && (
            <div style={{ marginTop: 14, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 12, padding: '0.85rem' }}>
              <div style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text)', marginBottom: 6 }}>
                Open since <span style={{ fontFamily: 'ui-monospace, monospace', fontWeight: 700 }}>{openSince || '—'}</span>
              </div>
              <div style={{ fontSize: '0.74rem', color: 'var(--text-sec)', marginBottom: 8 }}>
                Enter the actual OUT time — we&apos;ll close the open session then mark a fresh IN.
              </div>
              <label htmlFor="scan-forgot-time" style={{ display: 'block', fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-sec)', marginBottom: 4 }}>
                OUT time (IST)
              </label>
              <input
                id="scan-forgot-time"
                type="time"
                value={outTime || ''}
                onChange={(e) => onOutTimeChange?.(e.target.value)}
                className="input"
                style={{ width: '100%', fontSize: '0.9rem' }}
              />
            </div>
          )}
        </div>

        {/* actions */}
        <div
          style={{
            display: 'flex',
            gap: 8,
            padding: '0.85rem 1.1rem',
            background: 'var(--surface-2)',
            borderTop: '1px solid var(--border)',
            justifyContent: 'flex-end',
          }}
        >
          {!isForgot ? (
            <>
              <button
                onClick={onClose}
                className="btn"
                style={{ flex: isForgot ? 1 : undefined }}
              >
                {key === 'error' ? 'Close' : 'Done'}
              </button>
              {onConfirm && key !== 'error' && key !== 'in' && key !== 'out' && (
                <button ref={primaryRef} onClick={onConfirm} className="btn btn-primary">
                  {primaryLabel}
                </button>
              )}
              {(key === 'in' || key === 'out') && (
                <button ref={primaryRef} onClick={onConfirm || onClose} className="btn btn-primary">
                  {primaryLabel}
                </button>
              )}
            </>
          ) : (
            <>
              <button onClick={onClose} className="btn" style={{ flex: 1, justifyContent: 'center' }}>
                Cancel
              </button>
              <button
                ref={primaryRef}
                onClick={onConfirm}
                className="btn btn-primary"
                disabled={!outTime}
                style={{ flex: 1, justifyContent: 'center' }}
              >
                {primaryLabel}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
