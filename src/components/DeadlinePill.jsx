import { useState, useEffect } from 'react'
import { Clock, AlertTriangle } from 'lucide-react'

// Live countdown to a deadline; turns red and warns when < 24h remain.
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

export default function DeadlinePill({ deadline, showCountdown = true }) {
  const now = useDeadlineCountdown(deadline)
  const r = fmtRemaining(deadline, now)
  if (!r) return null
  const warn = r.days < 1 && !r.passed
  const cls = r.passed ? 'pill-red' : warn ? 'pill-amber' : 'pill-green'
  return (
    <span className={`pill ${cls}`} style={{ fontSize: '0.72rem' }} title={`Deadline ${new Date(deadline).toLocaleString()}`}>
      {warn && !r.passed ? <AlertTriangle size={11} /> : <Clock size={11} />} {showCountdown ? r.text : new Date(deadline).toLocaleString()}
    </span>
  )
}
