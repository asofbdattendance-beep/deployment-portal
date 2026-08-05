import { useState, useEffect } from 'react'
import { Clock, AlertTriangle } from 'lucide-react'

// Live countdown to a deadline. Rendered prominently by default (big red on
// yellow) so the remaining time is impossible to miss; pass small={true} for
// the compact pill (e.g. inside schedule list rows).
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

export default function DeadlinePill({ deadline, showCountdown = true, small = false }) {
  const now = useDeadlineCountdown(deadline)
  const r = fmtRemaining(deadline, now)
  if (!r) return null
  const title = `Deadline ${new Date(deadline).toLocaleString()}`
  if (small) {
    const warn = r.days < 1 && !r.passed
    const cls = r.passed ? 'pill-red' : warn ? 'pill-amber' : 'pill-green'
    return (
      <span className={`pill ${cls}`} style={{ fontSize: '0.72rem', whiteSpace: 'nowrap' }} title={title}>
        {warn && !r.passed ? <AlertTriangle size={11} /> : <Clock size={11} />} {showCountdown ? r.text : new Date(deadline).toLocaleString()}
      </span>
    )
  }
  return (
    <span className="deadline-countdown" title={title}>
      {r.passed ? <AlertTriangle size={18} /> : <Clock size={18} />} {showCountdown ? r.text : new Date(deadline).toLocaleString()}
    </span>
  )
}
