// ─── Overlap decision matrix for create-login ─────────────────────────────
// Attendance-system sewadars frequently ALREADY exist in portal_users (or
// own an auth account) — the "overlapping user" case. Provisioning must
// COMPLETE/repair that record (reinstate, attach the auth account, transfer
// the row to the typed email) instead of refusing with a 409. The only
// genuine conflicts are:
//   • a FINISHED active login (row linked to a live auth) → "edit instead"
//   • a cross-person email (typed email belongs to a different badge)
//   • an active login under a DIFFERENT email for the same badge
//
// Pure module — no imports, no I/O. Imported by index.ts with a `.ts`
// extension (Deno requirement) and unit-tested by ./overlap.test.ts under
// Node/Vitest.

export type PortalRow = {
  id: string
  email?: string | null
  badge_number?: string | null
  auth_id?: string | null
  is_active?: boolean | null
  name?: string | null
  role?: string | null
  centre?: string | null
  custom_role_id?: string | null
  created_at?: string | null
}

export type OverlapPlan =
  | { kind: 'fresh' }
  | { kind: 'resume'; row: PortalRow }
  | { kind: 'conflict'; message: string }

const norm = (v: unknown) => String(v ?? '').trim().toLowerCase()

// Email match wins over badge match; oldest row wins within each bucket
// (deterministic for dirty duplicate data).
export function pickRow(
  rows: PortalRow[],
  email: string,
  badge?: string | null,
): PortalRow | null {
  const wantEmail = norm(email)
  const wantBadge = badge ? String(badge).trim() : ''
  const byCreated = (a: PortalRow, z: PortalRow) =>
    String(a.created_at || '').localeCompare(String(z.created_at || ''))
  const byEmail = rows
    .filter((r) => norm(r.email) === wantEmail)
    .sort(byCreated)
  if (byEmail.length) return byEmail[0]
  if (wantBadge) {
    const byBadge = rows
      .filter((r) => String(r.badge_number || '').trim() === wantBadge)
      .sort(byCreated)
    if (byBadge.length) return byBadge[0]
  }
  return null
}

export function preflightOverlap(opts: {
  rows: PortalRow[]
  email: string
  badge?: string | null
}): OverlapPlan {
  const { rows, email, badge } = opts
  const picked = pickRow(rows, email, badge)
  if (!picked) return { kind: 'fresh' }

  const emailMatches = norm(picked.email) === norm(email)
  const rowBadge = String(picked.badge_number || '').trim()
  const wantBadge = badge ? String(badge).trim() : ''

  if (emailMatches) {
    // The typed email points at a row issued to a different badge — a
    // different person. Never move it.
    if (rowBadge && wantBadge && rowBadge !== wantBadge) {
      return {
        kind: 'conflict',
        message: `That email belongs to badge ${rowBadge} — edit that login instead`,
      }
    }
    // Fully finished login (linked + active): the old refuse is still right —
    // the client's Edit/Reinstate flow handles it.
    if (picked.is_active !== false && picked.auth_id) {
      return {
        kind: 'conflict',
        message: 'A login already exists for this email — edit or reinstate it instead',
      }
    }
    // Inactive, or half-created (no auth link): complete it.
    return { kind: 'resume', row: picked }
  }

  // Badge-only match: the row carries another email. An ACTIVE linked login
  // under that email stays authoritative (never silently transfer a working
  // identity); anything else (blank email, inactive, unlinked) is an overlap
  // to complete under the typed email.
  if (
    norm(picked.email) &&
    picked.is_active !== false &&
    picked.auth_id
  ) {
    return {
      kind: 'conflict',
      message: `Badge ${picked.badge_number} already has an active login under a different email — edit it from the Users page instead`,
    }
  }
  return { kind: 'resume', row: picked }
}
