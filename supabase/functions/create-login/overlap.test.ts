// Overlap decision matrix for create-login (the "FB5990GA0001" report):
// a sewadar can ALREADY exist in portal_users (attendance overlap) or own an
// auth account — provisioning must COMPLETE the login, not refuse it. The
// only genuine 409s are a finished active login and a cross-person email.
//
// Pure module: imported by supabase/functions/create-login/index.ts (Deno,
// `.ts` extension there) and unit-tested here under Node/Vitest.

import { describe, it, expect } from 'vitest'
import { preflightOverlap, pickRow, type PortalRow } from './overlap'

const row = (over: Partial<PortalRow> = {}): PortalRow => ({
  id: over.id ?? 'row-1',
  email: over.email ?? null,
  badge_number: over.badge_number ?? null,
  auth_id: over.auth_id ?? null,
  is_active: over.is_active ?? true,
  created_at: over.created_at ?? '2026-01-01T00:00:00Z',
  archived_at: over.archived_at ?? null,
})

describe('pickRow', () => {
  it('prefers the email match over a badge match', () => {
    const byBadge = row({ id: 'b', badge_number: 'FB1', email: 'old@x.org', auth_id: 'a1' })
    const byEmail = row({ id: 'e', email: 'new@x.org', badge_number: 'FB1' })
    expect(pickRow([byBadge, byEmail], 'new@x.org', 'FB1')?.id).toBe('e')
  })

  it('matches email case-insensitively', () => {
    const r = row({ email: 'Person@Example.COM' })
    expect(pickRow([r], 'person@example.com', null)?.id).toBe('row-1')
  })

  it('picks the oldest row when several match', () => {
    const newer = row({ id: 'new', email: 'a@b.c', created_at: '2026-02-01T00:00:00Z' })
    const older = row({ id: 'old', email: 'a@b.c', created_at: '2025-12-01T00:00:00Z' })
    expect(pickRow([newer, older], 'a@b.c', null)?.id).toBe('old')
  })

  it('returns null when nothing matches', () => {
    expect(pickRow([row({ badge_number: 'OTHER' })], 'a@b.c', 'FB1')).toBeNull()
  })
})

describe('preflightOverlap', () => {
  it('is fresh when no row matches', () => {
    expect(preflightOverlap({ rows: [], email: 'a@b.c', badge: 'FB1' })).toEqual({ kind: 'fresh' })
  })

  it('resumes an INACTIVE same-email row (the reported overlap) — reinstates + completes', () => {
    const r = row({ email: 'a@b.c', badge_number: 'FB1', is_active: false, auth_id: 'stale' })
    const plan = preflightOverlap({ rows: [r], email: 'A@B.C', badge: 'FB1' })
    expect(plan.kind).toBe('resume')
    if (plan.kind === 'resume') expect(plan.row.id).toBe('row-1')
  })

  it('resumes a same-email row with NO auth link (half-created)', () => {
    const r = row({ email: 'a@b.c', auth_id: null, is_active: true })
    expect(preflightOverlap({ rows: [r], email: 'a@b.c', badge: null }).kind).toBe('resume')
  })

  it('conflicts on a FINISHED active same-email login (edit instead)', () => {
    const r = row({ email: 'a@b.c', badge_number: 'FB1', auth_id: 'a-live', is_active: true })
    const plan = preflightOverlap({ rows: [r], email: 'a@b.c', badge: 'FB1' })
    expect(plan.kind).toBe('conflict')
    if (plan.kind === 'conflict') expect(plan.message).toMatch(/already exists/i)
  })

  it('conflicts when the typed email belongs to a DIFFERENT badge (cross-person)', () => {
    const r = row({ email: 'a@b.c', badge_number: 'OTHER', is_active: false })
    const plan = preflightOverlap({ rows: [r], email: 'a@b.c', badge: 'FB1' })
    expect(plan.kind).toBe('conflict')
    if (plan.kind === 'conflict') expect(plan.message).toMatch(/badge/i)
  })

  it('resumes a badge-overlap row that has no email yet', () => {
    const r = row({ email: null, badge_number: 'FB1', auth_id: null })
    expect(preflightOverlap({ rows: [r], email: 'a@b.c', badge: 'FB1' }).kind).toBe('resume')
  })

  it('resumes a badge-overlap row whose email differs but is inactive', () => {
    const r = row({ email: 'old@x.org', badge_number: 'FB1', is_active: false, auth_id: 'a1' })
    expect(preflightOverlap({ rows: [r], email: 'new@x.org', badge: 'FB1' }).kind).toBe('resume')
  })

  it('conflicts when the badge row already has a LIVE ACTIVE login under another email', () => {
    const r = row({ email: 'old@x.org', badge_number: 'FB1', is_active: true, auth_id: 'a-live' })
    const plan = preflightOverlap({ rows: [r], email: 'new@x.org', badge: 'FB1' })
    expect(plan.kind).toBe('conflict')
    if (plan.kind === 'conflict') expect(plan.message).toMatch(/different email|edit/i)
  })

  it('ignores rows matching neither the email nor the badge', () => {
    const r = row({ email: 'z@z.z', badge_number: 'NOPE' })
    expect(preflightOverlap({ rows: [r], email: 'a@b.c', badge: 'FB1' }).kind).toBe('fresh')
  })

  it('conflicts on an ARCHIVED same-email row — restore it, never resume it', () => {
    const r = row({ email: 'a@b.c', badge_number: 'FB1', is_active: false, archived_at: '2026-03-01T00:00:00Z' })
    const plan = preflightOverlap({ rows: [r], email: 'a@b.c', badge: 'FB1' })
    expect(plan.kind).toBe('conflict')
    if (plan.kind === 'conflict') expect(plan.message).toMatch(/archived — restore it/)
  })

  it('conflicts on an archived row even with a LIVE auth link (archived wins over every other rule)', () => {
    const r = row({ email: 'a@b.c', badge_number: 'FB1', is_active: true, auth_id: 'a-live', archived_at: '2026-03-01T00:00:00Z' })
    const plan = preflightOverlap({ rows: [r], email: 'a@b.c', badge: 'FB1' })
    expect(plan.kind).toBe('conflict')
    if (plan.kind === 'conflict') expect(plan.message).toMatch(/archived — restore it/)
  })

  it('conflicts on an archived badge-only match (different email)', () => {
    const r = row({ email: 'old@x.org', badge_number: 'FB1', is_active: true, auth_id: 'a-live', archived_at: '2026-03-01T00:00:00Z' })
    const plan = preflightOverlap({ rows: [r], email: 'new@x.org', badge: 'FB1' })
    expect(plan.kind).toBe('conflict')
    if (plan.kind === 'conflict') expect(plan.message).toMatch(/archived — restore it/)
  })

  it('still resumes a live row when archived_at is null (v69 no-regression)', () => {
    const r = row({ email: 'a@b.c', badge_number: 'FB1', is_active: false, auth_id: 'stale', archived_at: null })
    expect(preflightOverlap({ rows: [r], email: 'a@b.c', badge: 'FB1' }).kind).toBe('resume')
  })
})
