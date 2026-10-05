// ─── resolve-login helpers (pure, no I/O — unit-tested under Node/Vitest) ───
// Badge login resolves badge → email WITHOUT touching any existing row.
// Email path never calls the edge function (LoginPage branches on '@').

export function isEmailIdentifier(v: unknown): boolean {
  return String(v ?? '').trim().includes('@')
}

export function normalizeBadge(v: unknown): string {
  return String(v ?? '').trim()
}

// Escape PostgREST LIKE wildcards (%, _, \) so ilike() matches literally.
export function escapeLike(v: string): string {
  return String(v ?? '').replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

// Deterministic pick mirroring create-login/overlap.ts: oldest active row
// with a non-blank email wins; archived/inactive/blank-email rows lose.
export type BadgeRow = {
  email?: string | null
  badge_number?: string | null
  auth_id?: string | null
  is_active?: boolean | null
  archived_at?: string | null
  created_at?: string | null
}

export function pickBadgeEmail(rows: BadgeRow[], badge: string): string | null {
  const want = String(badge || '').trim().toLowerCase()
  if (!want) return null
  const exact = (rows || []).filter(
    (r) => String(r.badge_number || '').trim().toLowerCase() === want,
  )
  const eligible = exact.filter(
    (r) =>
      r.is_active !== false &&
      (r as { archived_at?: unknown }).archived_at == null &&
      String(r.email || '').trim() !== '',
  )
  if (eligible.length === 0) return null
  eligible.sort((a, z) => String(a.created_at || '').localeCompare(String(z.created_at || '')))
  return String(eligible[0].email).trim()
}
