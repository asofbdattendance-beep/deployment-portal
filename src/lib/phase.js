import { PAGES } from './pages'

/**
 * phase.js — the two-phase portal model (majorplan §3–§4).
 *
 * Phase 1 = Deployment (pre-visit planning & consent), Phase 2 = Attendance
 * (finalize + execution & reporting). Every PAGES entry carries exactly one
 * `phase`; these helpers derive everything the shell needs (which phases a
 * role can see, the default landing phase, stored preference) so App.jsx
 * stays declarative. All functions are pure except the two localStorage
 * helpers, which never throw (SSR/jsdom-safe, persistence best-effort).
 */
export const PHASE_STORAGE_KEY = 'portal_active_phase'

/** All registry entries visible to a role, in registry order. */
export function visiblePagesForRole(role) {
  return Object.entries(PAGES).filter(([, cfg]) => (cfg.roles || []).includes(role))
}

/** Sorted list of phases a role can see: [], [1], [2] or [1, 2]. */
export function phasesForRole(role) {
  const phases = []
  for (const [, cfg] of visiblePagesForRole(role)) {
    if ((cfg.phase === 1 || cfg.phase === 2) && !phases.includes(cfg.phase)) phases.push(cfg.phase)
  }
  return phases.sort()
}

/** First phase (registry order) with a visible page; falls back to 1. */
export function defaultPhaseForRole(role) {
  return phasesForRole(role)[0] ?? 1
}

/** Stored preference wins when it is a valid, visible phase; else default. */
export function resolveActivePhase(role, stored) {
  const available = phasesForRole(role)
  const n = Number(stored)
  if ((n === 1 || n === 2) && available.includes(n)) return n
  return defaultPhaseForRole(role)
}

/** Visible pages of one phase for a role, in registry order. */
export function pagesForRolePhase(role, phase) {
  return visiblePagesForRole(role).filter(([, cfg]) => cfg.phase === phase)
}

export function readStoredPhase() {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage.getItem(PHASE_STORAGE_KEY)
  } catch { return null }
}

export function storeActivePhase(phase) {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(PHASE_STORAGE_KEY, String(phase))
  } catch { /* persistence best-effort */ }
}
