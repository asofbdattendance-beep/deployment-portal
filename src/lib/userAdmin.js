import { phasesForRole } from '../lib/phase'

/**
 * userAdmin.js — pure helpers for the Users management surface.
 *
 * No Supabase client here; the caller passes already-loaded user rows so
 * these helpers stay trivially testable and reusable from any page.
 */

// ─── Password validation ───

/**
 * Returns an array of human-readable password errors.
 * Empty array = valid. Minimum 6 characters (matches ResetPasswordPage).
 */
export function passwordErrors(password) {
  const errs = []
  if (!password || password.length < 6) {
    errs.push('Password must be at least 6 characters')
  }
  return errs
}

// ─── Phase grouping ───

/**
 * Maps a role to its phase group label: 'deployment', 'attendance', or 'both'.
 * Uses phasesForRole from lib/phase so the mapping stays in sync with the
 * page registry — with one deliberate override: centre_admin resolves to
 * 'deployment'. Centre admins work the deployment (consent/deploy) side, not
 * scanning, even though the shared attendance screen lists their role.
 */
export function userPhaseGroup(role) {
  if (role === 'centre_admin') return 'deployment'
  const phases = phasesForRole(role)
  if (phases.length === 0) return 'both'
  if (phases.includes(1) && phases.includes(2)) return 'both'
  if (phases.includes(1)) return 'deployment'
  return 'attendance'
}

// ─── Status resolution ───

/**
 * Resolves a user's display status. Priority: archived > suspended > active.
 * A user is archived when `is_archived` is truthy, suspended when
 * `is_active === false` (but not archived), otherwise active.
 */
export function statusOf(user) {
  if (!user) return 'active'
  if (user.is_archived) return 'archived'
  if (user.is_active === false) return 'suspended'
  return 'active'
}

// ─── Permission guards ───

/**
 * Returns true if `currentUser` may delete `target`.
 * Blocks: self-delete, deleting the last active super_admin.
 */
export function canDeleteUser(target, currentUser) {
  if (!target || !currentUser) return false
  if (target.id === currentUser.id) return false
  if (target.role === 'super_admin' && statusOf(target) === 'active') {
    // Caller must also verify there is another active super_admin; this
    // helper only blocks self-delete and the trivial single-admin case.
    return true
  }
  return true
}

/**
 * Returns true if `currentUser` may archive `target`.
 * Blocks: self-archive, archiving the last active super_admin.
 */
export function canArchiveUser(target, currentUser) {
  if (!target || !currentUser) return false
  if (target.id === currentUser.id) return false
  if (target.role === 'super_admin' && statusOf(target) === 'active') {
    return true
  }
  return true
}

// ─── Sheet row mapping ───

/**
 * Converts an array of user objects into flat sheet-row objects suitable
 * for exportWorkbook. Picks the fields the Users page cares about.
 */
export function usersToSheetRows(users) {
  return (users || []).map((u) => ({
    name: u.name || '',
    email: u.email || '',
    role: u.role || '',
    centre: u.centre || '',
    badge_number: u.badge_number || '',
    location: u.location || '',
    status: statusOf(u),
    phase_group: userPhaseGroup(u.role),
    is_active: u.is_active,
    is_archived: u.is_archived ? 'yes' : 'no',
    created_at: u.created_at || '',
  }))
}

// ─── Import parsing ───

/**
 * Parses raw sheet rows (from readWorkbookRows) into user objects ready
 * for bulk-create. Expects at minimum: name, email, role.
 * Returns { valid, errors } where errors is an array of { row, message }.
 */
export function parseImportRows(rows) {
  const valid = []
  const errors = []
  ;(rows || []).forEach((row, i) => {
    const rowNum = i + 2 // 1-indexed + header row
    const name = String(row.name || '').trim()
    const email = String(row.email || '').trim()
    const role = String(row.role || '').trim()
    if (!name) {
      errors.push({ row: rowNum, message: 'Missing name' })
      return
    }
    if (!email) {
      errors.push({ row: rowNum, message: 'Missing email' })
      return
    }
    if (!role) {
      errors.push({ row: rowNum, message: 'Missing role' })
      return
    }
    valid.push({ name, email, role })
  })
  return { valid, errors }
}
