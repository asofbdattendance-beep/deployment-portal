// src/lib/jitter.js
// Small helpers to keep many clients from firing in lockstep.
export function jitter(ms, factor = 0.2) {
  if (ms <= 0) return 0
  const delta = ms * factor * (Math.random() * 2 - 1)
  return Math.max(0, Math.round(ms + delta))
}

// Drop-in replacement for setInterval with jittered delay and a clear() fn.
export function jitteredInterval(fn, ms, factor = 0.2) {
  let timer = null
  let stopped = false
  const schedule = () => {
    if (stopped) return
    timer = setTimeout(() => {
      if (stopped) return
      try { fn() } catch { /* swallow — caller's own error handling */ }
      schedule()
    }, jitter(ms, factor))
  }
  schedule()
  return () => { stopped = true; if (timer) clearTimeout(timer) }
}
