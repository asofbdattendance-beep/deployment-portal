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

/** All registry entries visible to a role or user profile, in registry order. */
export function visiblePagesForRole(roleOrProfile, maybeIsCentreManager = false) {
  let role = roleOrProfile
  let isCentreManager = Boolean(maybeIsCentreManager)
  if (roleOrProfile && typeof roleOrProfile === 'object') {
    role = roleOrProfile.role
    isCentreManager = Boolean(roleOrProfile.is_centre_manager)
  }
  return Object.entries(PAGES).filter(([key, cfg]) => {
    if (key === 'attendance' && isCentreManager) return true
    return (cfg.roles || []).includes(role)
  })
}

/** Sorted list of phases a role can see: [], [1], [2] or [1, 2]. */
export function phasesForRole(roleOrProfile, maybeIsCentreManager = false) {
  const phases = []
  for (const [, cfg] of visiblePagesForRole(roleOrProfile, maybeIsCentreManager)) {
    if ((cfg.phase === 1 || cfg.phase === 2) && !phases.includes(cfg.phase)) phases.push(cfg.phase)
  }
  return phases.sort()
}

/** First phase (registry order) with a visible page; falls back to 1. */
export function defaultPhaseForRole(roleOrProfile, maybeIsCentreManager = false) {
  return phasesForRole(roleOrProfile, maybeIsCentreManager)[0] ?? 1
}

/** Stored preference wins when it is a valid, visible phase; else default. */
export function resolveActivePhase(roleOrProfile, stored, maybeIsCentreManager = false) {
  const available = phasesForRole(roleOrProfile, maybeIsCentreManager)
  const n = Number(stored)
  if ((n === 1 || n === 2) && available.includes(n)) return n
  return defaultPhaseForRole(roleOrProfile, maybeIsCentreManager)
}

/** Visible pages of one phase for a role, in registry order. */
export function pagesForRolePhase(roleOrProfile, phase, maybeIsCentreManager = false) {
  return visiblePagesForRole(roleOrProfile, maybeIsCentreManager).filter(([, cfg]) => cfg.phase === phase)
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
