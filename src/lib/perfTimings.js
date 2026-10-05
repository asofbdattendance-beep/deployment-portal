/**
 * perfTimings — Phase-0 latency tripwires (login / scan / viewer flows).
 *
 * Real numbers, not guesses: each flow stamps `performance.now()` at stage
 * boundaries into a capped in-memory buffer. Nothing is sent anywhere; the
 * operator pastes the dump from the console after a slow run.
 *
 * Capture procedure (2 min, on the slowest device):
 *   1. Console: `localStorage.setItem('portal_perf','1')` then reload.
 *   2. Do ONE slow login (or ONE scan while watching Live Scanners).
 *   3. Console: `window.__portalPerfDump()` → paste the output in the report.
 *   4. `localStorage.removeItem('portal_perf')` to silence the per-stage lines.
 *
 * Cost when the flag is off: one `performance.now()` + one array push per
 * stage (nanoseconds). The buffer caps at 400 entries and drops the oldest.
 */

const MAX_MARKS = 400
const FLAG_KEY = 'portal_perf'

let seq = 0
const marks = []

function flagOn() {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(FLAG_KEY) === '1'
  } catch {
    return false
  }
}

/** Start a timed run for a flow ('login' | 'scan' | 'viewer'). Returns the run id. */
export function perfStart(flow) {
  seq += 1
  // Also remembered as the flow's "current" run so a mark emitted from a
  // different module (e.g. PortalAuthContext finishing LoginPage's login)
  // can attach to the right run without prop-drilling an id.
  currentRun[flow] = seq
  return seq
}

const currentRun = {}

/** The latest run id started for a flow, or null when none exists yet. */
export function perfCurrentRun(flow) {
  return currentRun[flow] ?? null
}

/** Stamp one stage of a run. Never throws, never blocks. */
export function perfMark(flow, id, stage) {
  try {
    marks.push({ flow, id, stage, t: Math.round(performance.now()) })
    if (marks.length > MAX_MARKS) marks.splice(0, marks.length - MAX_MARKS)
    if (flagOn() && typeof console !== 'undefined' && console.info) {
      console.info(`[perf] ${flow}#${id} ${stage}`)
    }
  } catch {
    // Timing must never break the timed code.
  }
}

/**
 * Group marks by (flow, id) in time order with per-stage deltas.
 * @returns {Array<{flow:string,id:number,totalMs:number,stages:Array<{stage:string,atMs:number,deltaMs:number}>}>}
 */
export function perfSummary() {
  const runs = new Map()
  for (const m of marks) {
    const key = `${m.flow}#${m.id}`
    if (!runs.has(key)) runs.set(key, { flow: m.flow, id: m.id, raw: [] })
    runs.get(key).raw.push(m)
  }
  return [...runs.values()].map((r) => {
    const raw = r.raw.slice().sort((a, b) => a.t - b.t)
    const t0 = raw[0]?.t ?? 0
    return {
      flow: r.flow,
      id: r.id,
      totalMs: (raw[raw.length - 1]?.t ?? t0) - t0,
      stages: raw.map((m, i) => ({
        stage: m.stage,
        atMs: m.t - t0,
        deltaMs: i === 0 ? 0 : m.t - raw[i - 1].t,
      })),
    }
  })
}

/** One pasteable blob: JSON of the grouped summaries. Wired to window by main.jsx. */
export function perfDump() {
  try {
    return JSON.stringify(perfSummary(), null, 1)
  } catch {
    return '[]'
  }
}

/** Test-only: reset sequence, current runs and buffer. */
export function __perfResetForTests() {
  seq = 0
  marks.length = 0
  for (const k of Object.keys(currentRun)) delete currentRun[k]
}
