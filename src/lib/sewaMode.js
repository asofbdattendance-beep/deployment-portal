/**
 * Sewa mode — Previsit vs Bhati Visit. Pure helpers only (no fetch, no
 * side effects), mirroring the DB rule in sql/v60_visit_window.sql:
 *
 *   a scan dated inside the schedule's visit window = Bhati Visit;
 *   any other date = Previsit sewa. A schedule with no usable window
 *   reads as previsit-only.
 *
 * The mode is a VIEW lens, never a write label: scanning writes the
 * same session row in both modes and the date classifies it. A manual
 * override therefore changes only what the operator is LOOKING at.
 */

export const SEWA_MODE_VISIT = 'visit'
export const SEWA_MODE_PREVISIT = 'previsit'

/** Roles that get the Previsit / Bhati Visit switch (product decision).
 *  Centre roles and vss_operator keep the visit-only view they have today:
 *  the previsit RPCs fail closed for them anyway. */
export const PREVISIT_ROLES = ['dept_incharge', 'scanner', 'aso', 'super_admin']

/**
 * Whether a role may use the sewa-mode switch at all.
 * @param {string} role portal_users.role
 * @returns {boolean}
 */
export function canUsePrevisitMode(role) {
  return PREVISIT_ROLES.includes(role)
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Coerce anything date-ish (DB 'YYYY-MM-DD', ISO datetime) to a plain
 * 'YYYY-MM-DD' string. Anything else → '' (never throws).
 * @param {*} value
 * @returns {string}
 */
export function toISODate(value) {
  if (typeof value !== 'string') return ''
  const s = value.slice(0, 10)
  return ISO_DATE.test(s) ? s : ''
}

/**
 * The visit window off a schedule row (App.jsx now selects both columns).
 * @param {object} schedule deployment_schedules row
 * @returns {{start: string, end: string}} '' when unset
 */
export function scheduleWindow(schedule) {
  return {
    start: toISODate(schedule?.visit_start_date),
    end: toISODate(schedule?.visit_end_date),
  }
}

/**
 * Expand an inclusive window to its ordered date list. Empty for any
 * unusable window (missing side, end < start). Capped so a pathological
 * range can never build a monster array.
 * @param {string} start 'YYYY-MM-DD'
 * @param {string} end 'YYYY-MM-DD'
 * @param {number} maxDays safety ceiling (default 31)
 * @returns {string[]}
 */
export function expandDateRange(start, end, maxDays = 31) {
  const s = toISODate(start)
  const e = toISODate(end)
  if (!s || !e || e < s) return []
  const out = []
  // String-level day increment in UTC: no timezone can shift the date.
  let cur = `${s}T00:00:00Z`
  for (let i = 0; i < maxDays; i += 1) {
    const d = new Date(cur)
    if (Number.isNaN(d.getTime())) return []
    const iso = d.toISOString().slice(0, 10)
    out.push(iso)
    if (iso >= e) return out
    cur = new Date(d.getTime() + 86400000).toISOString()
  }
  return out
}

/**
 * Which sewa a date belongs to for a window. No usable window (or no
 * readable today) ⇒ previsit — the mode fails toward the previsit view,
 * matching is_visit_date's NULL-window ⇒ FALSE.
 * @param {string} start 'YYYY-MM-DD'
 * @param {string} end 'YYYY-MM-DD'
 * @param {string} today 'YYYY-MM-DD' (caller's "today", IST)
 * @returns {'visit'|'previsit'}
 */
export function resolveSewaMode(start, end, today) {
  const s = toISODate(start)
  const e = toISODate(end)
  const t = toISODate(today)
  if (!s || !e || e < s || !t) return SEWA_MODE_PREVISIT
  if (t < s || t > e) return SEWA_MODE_PREVISIT
  return SEWA_MODE_VISIT
}

/**
 * Test logins are the demo accounts: they keep the manual sewa-mode toggle
 * (auto never takes the view back) while every real login is calendar-auto
 * with no switch. Any login whose email contains "test" (case-insensitive)
 * is a test login. No database change — the profile already carries the
 * email via get_portal_profile. Missing email fails closed (no toggle):
 * every real login is created with an email address. Plain substring match
 * errs toward test, which is the harmless direction here — the toggle is
 * view-only and still role-gated to previsit-capable roles.
 * @param {object} profile portal_users row (or null)
 * @returns {boolean}
 */
export function isTestLogin(profile) {
  const email = String(profile?.email || '').toLowerCase()
  return email.length === 0 || email.includes('test')
}

/**
 * Pin a visit-page date inside the schedule's window. Bhati Visit shows
 * ONLY visit-days data: with a usable window any date outside it snaps to
 * the nearest edge (before-start ⇒ start, after-end ⇒ end). Empty (the
 * Anomalies "whole visit" sweep) and windowless schedules pass through
 * untouched — '' must stay '' so p_date = null keeps working.
 * @param {string} dateStr 'YYYY-MM-DD' (or '')
 * @param {{start: string, end: string}} win scheduleWindow() output
 * @returns {string} clamped date
 */
export function clampDateToWindow(dateStr, win) {
  if (!dateStr) return dateStr
  const s = toISODate(win?.start)
  const e = toISODate(win?.end)
  if (!s || !e || e < s) return dateStr
  const d = toISODate(dateStr)
  if (!d) return dateStr
  if (d < s) return s
  if (d > e) return e
  return d
}
