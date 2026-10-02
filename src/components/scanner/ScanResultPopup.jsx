import { useEffect, useRef, useState, useCallback } from 'react'
import { CheckCircle2, LogOut, AlertTriangle, Clock, XCircle, X, WifiOff } from 'lucide-react'
import { useIsMobile } from '../../hooks/useMediaQuery'

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
  // Explicit IN/OUT choice — a scan only resolves the sewadar's state and
  // shows their details; NOTHING is written until the operator taps the one
  // valid action. Shares the amber "attention" palette of `forgot`: it is a
  // question, not an error.
  choose: {
    label: 'Choose action',
    icon: Clock,
    accent: '#f59e0b',
    bg: '#fffbeb',
    border: '#fde68a',
    iconBg: '#fffbeb',
    iconColor: '#b45309',
  },
  // v44 confirm gates — RETIRED (the explicit choice above subsumes them: the
  // operator always picks the direction, so no auto-toggle ever needs a
  // 1h hold). Kept so a stale persisted popup still renders instead of
  // crashing; new code never emits these statuses.
  confirm_out: {
    label: 'Mark OUT?',
    icon: Clock,
    accent: '#f59e0b',
    bg: '#fffbeb',
    border: '#fde68a',
    iconBg: '#fffbeb',
    iconColor: '#b45309',
  },
  confirm_in: {
    label: 'Mark IN?',
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
 *                  | 'choose'   (explicit IN/OUT choice — nothing written yet)
 *                  alias `variant` is also accepted
 *  variant         alias for status
 *  action          'IN' | 'OUT' — for `choose`: the one valid direction. The
 *                  popup shows ONLY this button; the opposite direction is
 *                  never offered, so an invalid write is unrepresentable.
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
  action,
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
  // A choice/confirm gate must be answered — but backdrop/ESC closing it IS
  // "Cancel" (no entry is written), so it keeps the default dismissible
  // behaviour rather than trapping the operator.
  const isConfirm = key === 'confirm_out' || key === 'confirm_in'
  const isChoice = key === 'choose'
  const choiceAction = action === 'OUT' ? 'OUT' : 'IN'
  const canBackdropClose = dismissible !== undefined ? dismissible : !isForgot

  const overlayRef = useRef(null)
  const primaryRef = useRef(null)
  const prevFocusRef = useRef(null)
  const [visible, setVisible] = useState(false)
  const [mounted, setMounted] = useState(false)
  // Phones render the dialog as a bottom sheet (thumb-reachable actions,
  // 44px close, drag-handle affordance). Desktop keeps the centred modal.
  const isMobileScan = useIsMobile()

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

  // focus primary on open — preventScroll so a foldable / small phone never
  // jumps the page (and the camera preview) when the dialog appears.
  useEffect(() => {
    if (!mounted || !visible) return
    const id = setTimeout(() => primaryRef.current?.focus({ preventScroll: true }), 60)
    return () => clearTimeout(id)
  }, [mounted, visible])

  // restore focus on dismiss/unmount (the popup auto-dismisses, which would
  // otherwise drop focus to <body>). No scanner-region id exists in the repo,
  // so the fallback is the previously-focused element only. No timer changes.
  useEffect(() => {
    if (!mounted) return
    prevFocusRef.current = document.activeElement
    return () => {
      const prev = prevFocusRef.current
      prevFocusRef.current = null
      if (prev && document.contains(prev)) prev.focus({ preventScroll: true })
    }
  }, [mounted])

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
    if (isChoice) return choiceAction === 'OUT' ? 'Mark OUT?' : 'Mark IN?'
    if (key === 'confirm_out') return 'Already IN — mark OUT?'
    if (key === 'confirm_in') return 'Already OUT — mark IN?'
    if (key === 'in') return flag ? 'Checked In — Flagged' : 'Checked In'
    if (key === 'out') return 'Checked Out'
    if (key === 'flagged') return 'Flagged — Not deployed'
    if (key === 'queued' || key === 'offline') return 'Queued offline'
    if (key === 'error') return 'Scan failed'
    return cfg.label
  })()

  const primaryLabel = confirmLabel
    || (isForgot ? 'Close OUT then IN' : isChoice ? (choiceAction === 'OUT' ? 'Mark OUT' : 'Mark IN') : isConfirm ? 'Confirm' : 'Done')

  // The secondary button. On a choice/confirm gate "Done" would read as "yes,
  // go ahead" — the exact misread the gate exists to prevent — so it must say
  // "Cancel", which is also the honest description of what it does.
  const secondaryLabel = key === 'error' ? 'Close' : (isChoice || isConfirm) ? 'Cancel' : 'Done'

  return (
    <div
      ref={overlayRef}
      role="presentation"
      onClick={(e) => { if (e.target === e.currentTarget && canBackdropClose) onClose?.() }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 90, // --z-sheet: above the bottom tab bar (40)
        display: 'flex',
        alignItems: isMobileScan ? 'flex-end' : 'center',
        justifyContent: 'center',
        padding: isMobileScan ? 0 : '1rem',
        // Safe-area aware bottom padding: on phones with a soft keyboard /
        // gesture bar the action row must never sit under the system UI.
        // On phones it must ALSO clear the fixed 84px bottom tab bar, which is
        // painted under this sheet — without the tab offset the primary action
        // sat inside the nav bar's footprint.
        paddingBottom: isMobileScan
          ? 'calc(84px + max(1rem, env(safe-area-inset-bottom)))'
          : 'max(1rem, env(safe-area-inset-bottom))',
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
          maxWidth: isMobileScan ? '100%' : 380,
          // Foldable / small-phone focus fix: when the soft keyboard opens for
          // the OUT-time field the layout viewport shrinks but a centred fixed
          // dialog would be pushed half off-screen. Cap to the dynamic viewport
          // and scroll internally so the action buttons stay reachable.
          maxHeight: isMobileScan ? 'min(86dvh, 640px)' : 'min(92dvh, 640px)',
          overflowY: 'auto',
          WebkitOverflowScrolling: 'touch',
          overscrollBehavior: 'contain',
          background: '#fff',
          borderRadius: isMobileScan ? '16px 16px 0 0' : 16,
          border: '1px solid var(--border)',
          borderBottom: isMobileScan ? 'none' : '1px solid var(--border)',
          boxShadow: visible
            ? '0 20px 60px rgba(15,23,42,0.18), 0 1px 3px rgba(15,23,42,0.08)'
            : '0 8px 24px rgba(15,23,42,0.08)',
          overflowX: 'hidden',
          transform: visible ? 'scale(1) translateY(0)' : 'scale(0.96) translateY(8px)',
          opacity: visible ? 1 : 0,
          transition: 'transform 260ms cubic-bezier(0.16,1,0.3,1), opacity 200ms ease, box-shadow 260ms ease',
          willChange: 'transform, opacity',
        }}
      >
        {/* accent hairline */}
        <div style={{ height: 3, background: cfg.accent }} />
        {isMobileScan && (
          <div style={{ width: 40, height: 4, borderRadius: 999, background: '#cbd5e1', margin: '0.5rem auto 0' }} aria-hidden="true" />
        )}

        {/* close X — hidden for forgot unless dismissible explicitly */}
        {canBackdropClose && (
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              position: 'absolute',
              top: 12,
              right: 12,
              width: isMobileScan ? 44 : 30,
              height: isMobileScan ? 44 : 30,
              borderRadius: 999,
              border: '1px solid var(--border)',
              background: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              color: 'var(--text-muted)',
              touchAction: 'manipulation',
            }}
          >
            <X size={isMobileScan ? 18 : 14} />
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
                <h3 id="scan-popup-title" style={{ fontSize: '1.06rem', fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.2, color: 'var(--text)' }}>
                  {title}
                </h3>
                {/* status pill */}
                <span
                  className="pill"
                  style={{
                    fontSize: '0.72rem',
                    padding: '0.2rem 0.55rem',
                    background: cfg.bg,
                    color: cfg.iconColor,
                    border: `1px solid ${cfg.border}`,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                  }}
                >
                  {key === 'in' ? 'IN' : key === 'out' ? 'OUT'
                    : isChoice ? (choiceAction === 'OUT' ? 'MARK OUT' : 'MARK IN')
                    : key === 'confirm_out' ? 'CONFIRM OUT'
                    : key === 'confirm_in' ? 'CONFIRM IN'
                    : key.toUpperCase()}
                </span>
              </div>

              {/* badge */}
              {badge && (
                <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span
                    style={{
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      fontSize: '0.92rem',
                      fontWeight: 700,
                      letterSpacing: '0.02em',
                      background: 'var(--surface-2)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      padding: '0.28rem 0.65rem',
                      color: 'var(--text)',
                    }}
                  >
                    {badge}
                  </span>
                  {time && (
                    <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                      · {time}
                    </span>
                  )}
                </div>
              )}

              {/* name + centre + dept — labelled rows for glanceable reading */}
              {(name || centre || deptName) && (
                <dl style={{ margin: '10px 0 0', padding: 0, fontSize: '0.88rem', lineHeight: 1.5 }}>
                  {name && (
                    <div style={{ marginBottom: centre || deptName ? 6 : 0 }}>
                      <dt style={{ fontSize: '0.66rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>Name</dt>
                      <dd style={{ margin: 0, fontSize: '1rem', fontWeight: 800, color: 'var(--text)' }}>{name}</dd>
                    </div>
                  )}
                  {centre && (
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: deptName ? 6 : 0 }}>
                      <dt style={{ fontSize: '0.66rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', flexShrink: 0 }}>Centre</dt>
                      <dd style={{ margin: 0, fontWeight: 600, color: 'var(--text)' }}>{centre}</dd>
                    </div>
                  )}
                  {deptName && (
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                      <dt style={{ fontSize: '0.66rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', flexShrink: 0 }}>Dept</dt>
                      <dd style={{ margin: 0 }}><span className="pill pill-blue" style={{ fontSize: '0.76rem', border: '1px solid #c7d2fe' }}>{deptName}</span></dd>
                    </div>
                  )}
                  {isForgot && <div style={{ marginTop: 4 }}><span className="pill pill-amber" style={{ fontSize: '0.72rem' }}> &gt; 12h open</span></div>}
                </dl>
              )}

              {/* choice context: which session the OUT would close */}
              {isChoice && choiceAction === 'OUT' && openSince && (
                <div style={{ marginTop: 8, fontSize: '0.82rem', color: 'var(--text-sec)' }}>
                  Currently IN since <span style={{ fontFamily: 'ui-monospace, monospace', fontWeight: 700 }}>{openSince}</span>
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
                        fontSize: '0.84rem',
                        fontWeight: 700,
                        color: '#b45309',
                        background: '#fffbeb',
                        border: '1px solid #fde68a',
                        borderRadius: 8,
                        padding: '0.45rem 0.65rem',
                      }}
                    >
                      <AlertTriangle size={14} /> {flag}
                    </div>
                  )}
                  {message && !flag && (
                    <div style={{ fontSize: '0.88rem', color: key === 'error' ? '#b91c1c' : 'var(--text-sec)', lineHeight: 1.5 }}>
                      {message}
                    </div>
                  )}
                  {message && flag && (
                    <div style={{ marginTop: 6, fontSize: '0.82rem', color: 'var(--text-sec)', lineHeight: 1.45 }}>{message}</div>
                  )}
                </div>
              )}

              {/* queued hint */}
              {(key === 'queued' || key === 'offline') && !message && (
                <div style={{ marginTop: 8, fontSize: '0.82rem', color: '#b45309' }}>
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
                // 16px minimum: anything smaller makes Android Chrome / iOS
                // Safari auto-zoom the page on focus — the "focus jump" seen
                // on small phones and foldables.
                style={{ width: '100%', fontSize: 16 }}
              />
            </div>
          )}
        </div>

        {/* actions */}
        <div
          style={{
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            padding: '0.85rem 1.1rem',
            paddingBottom: isMobileScan
              // clear the bottom tab bar (84px) + safe area on phones
              ? 'calc(84px + max(0.85rem, env(safe-area-inset-bottom)))'
              : 'max(0.85rem, env(safe-area-inset-bottom))',
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
                style={{ minHeight: 44, touchAction: 'manipulation' }}
              >
                {secondaryLabel}
              </button>
              {onConfirm && (isChoice || isConfirm) && (
                <button
                  ref={primaryRef}
                  onClick={onConfirm}
                  className="btn btn-primary"
                  style={{ minHeight: 44, touchAction: 'manipulation', flex: isChoice ? 1 : undefined, justifyContent: 'center' }}
                >
                  {primaryLabel}
                </button>
              )}
            </>
          ) : (
            <>
              <button onClick={onClose} className="btn" style={{ flex: 1, justifyContent: 'center', minHeight: 44, touchAction: 'manipulation' }}>
                Cancel
              </button>
              <button
                ref={primaryRef}
                onClick={onConfirm}
                className="btn btn-primary"
                disabled={!outTime}
                style={{ flex: 1, justifyContent: 'center', minHeight: 44, touchAction: 'manipulation' }}
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
