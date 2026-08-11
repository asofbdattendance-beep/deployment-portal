import { useState, useEffect } from 'react'
import { Check, AlertTriangle } from 'lucide-react'

// Live countdown to a deadline. Rendered as a box-style timer — one box each
// for Days / Hours / Minutes / Seconds with zero-padded red numbers and a
// green "active" check badge; pass small={true} for the compact version (e.g.
// inside schedule list rows).
export function useDeadlineCountdown(deadline) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!deadline) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [deadline])
  return now
}

export function fmtRemaining(deadline, now = Date.now()) {
  if (!deadline) return null
  const diff = new Date(deadline).getTime() - now
  const passed = diff <= 0
  const ms = Math.abs(diff)
  const days = Math.floor(ms / 86400000)
  const hours = Math.floor((ms % 86400000) / 3600000)
  const mins = Math.floor((ms % 3600000) / 60000)
  const secs = Math.floor((ms % 60000) / 1000)
  return { passed, days, hours, mins, secs, text: passed ? 'Deadline passed' : `${days}d ${hours}h ${mins}m ${secs}s remaining` }
}

// zero-pad a countdown value to 2 digits (e.g. 4 → "04")
const pad2 = n => String(n).padStart(2, '0')

// One box of the box-style countdown
function CountdownBox({ value, label }) {
  return (
    <div className="deadline-box">
      <div className="deadline-box-value">{pad2(value)}</div>
      <div className="deadline-box-label">{label}</div>
    </div>
  )
}

// Four-box countdown group with a green "active" check badge on the corner
// and an optional heading line rendered above the boxes.
function CountdownBoxes({ r, small = false, badge = true, title, label }) {
  return (
    <span
      className={`deadline-boxes${small ? ' deadline-boxes-small' : ''}`}
      title={title}
      role="timer"
      aria-label={`${r.days} days, ${r.hours} hours, ${r.mins} minutes, ${r.secs} seconds remaining`}
    >
      {badge && (
        <span className="deadline-badge" title="Countdown active">
          <Check size={small ? 9 : 11} strokeWidth={3.5} aria-hidden="true" />
        </span>
      )}
      {label && <span className="deadline-boxes-label">{label}</span>}
      <span className="deadline-boxes-row">
        <CountdownBox value={r.days} label="Days" />
        <CountdownBox value={r.hours} label="Hours" />
        <CountdownBox value={r.mins} label="Minutes" />
        <CountdownBox value={r.secs} label="Seconds" />
      </span>
    </span>
  )
}

export default function DeadlinePill({ deadline, showCountdown = true, small = false }) {
  const now = useDeadlineCountdown(deadline)
  const r = fmtRemaining(deadline, now)
  if (!r) return null
  const title = `Deadline ${new Date(deadline).toLocaleString()}`
  if (!showCountdown) {
    return <span className="deadline-date" title={title}>{new Date(deadline).toLocaleString()}</span>
  }
  if (r.passed) {
    return (
      <span className="pill pill-red" style={{ fontSize: '0.78rem', whiteSpace: 'nowrap' }} title={title}>
        <AlertTriangle size={13} /> Deadline passed
      </span>
    )
  }
  return <CountdownBoxes r={r} small={small} title={title} label={small ? undefined : 'Deployment Submission Window Closes In'} />
}

// Self-contained amber warning shown only when a deadline is < 1 day away.
// The 1-second tick lives HERE so pages don't re-render their whole table
// every second (that was a real perf issue on large consent tables).
export function DeadlineWarning({ deadline }) {
  const now = useDeadlineCountdown(deadline)
  const r = fmtRemaining(deadline, now)
  if (!r || r.passed || r.days >= 1) return null
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '0.75rem', fontSize: '0.85rem', color: '#92400e', marginBottom: '1rem', flexWrap: 'wrap' }}>
      <AlertTriangle size={16} style={{ color: '#b45309', flexShrink: 0 }} />
      <span>
        Deadline is soon — <strong>finish consent &amp; deployment before it closes.</strong>
      </span>
      <div style={{ marginLeft: 'auto' }}>
        <CountdownBoxes r={r} badge={false} />
      </div>
    </div>
  )
}
