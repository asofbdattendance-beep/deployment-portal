import { Lock, Unlock, Loader2 } from 'lucide-react'

// A labelled global on/off switch (e.g. the ASO master control for a
// whole deployment population). Uses the existing .toggle styles.
export default function MasterSwitch({ label, open, onToggle, busy = false, disabled = false }) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.5rem',
        padding: '0.4rem 0.75rem',
        borderRadius: 10,
        border: open ? '1px solid #bbf7d0' : '1px solid #fecaca',
        background: open ? '#f0fdf4' : '#fef2f2',
      }}
    >
      <button
        role="switch"
        aria-checked={open}
        aria-label={label}
        className="toggle"
        disabled={busy || disabled}
        onClick={onToggle}
        title={open ? `Click to close ${label}` : `Click to open ${label}`}
      >
        <span className="toggle-knob" />
      </button>
      <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
        <span style={{ fontSize: '0.72rem', fontWeight: 700, color: open ? '#047857' : '#b91c1c' }}>
          {busy ? <Loader2 size={12} style={{ verticalAlign: '-2px', animation: 'spin 0.6s linear infinite' }} /> : open ? <Unlock size={12} style={{ verticalAlign: '-2px' }} /> : <Lock size={12} style={{ verticalAlign: '-2px' }} />}
          {' '}{open ? 'Open' : 'Closed'}
        </span>
        <span style={{ fontSize: '0.66rem', color: '#64748b', fontWeight: 500 }}>{label}</span>
      </div>
    </div>
  )
}
