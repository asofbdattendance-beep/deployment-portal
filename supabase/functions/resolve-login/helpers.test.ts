// resolve-login helpers: badge→email resolution never touches existing rows.
// Pure module: imported by ./index.ts (Deno, `.ts` extension there) and
// unit-tested here under Node/Vitest.

import { describe, it, expect } from 'vitest'
import { isEmailIdentifier, normalizeBadge, escapeLike, pickBadgeEmail, type BadgeRow } from './helpers'

const row = (over: Partial<BadgeRow> = {}): BadgeRow => ({
  email: over.email ?? null,
  badge_number: over.badge_number ?? null,
  auth_id: over.auth_id ?? null,
  is_active: over.is_active ?? true,
  archived_at: over.archived_at ?? null,
  created_at: over.created_at ?? '2026-01-01T00:00:00Z',
})

describe('isEmailIdentifier', () => {
  it('treats anything with @ as email (existing signIn path)', () => {
    expect(isEmailIdentifier('aso@x.org')).toBe(true)
  })

  it('treats a badge as non-email (resolve-login path)', () => {
    expect(isEmailIdentifier('FB5990GA0001')).toBe(false)
    expect(isEmailIdentifier('  FB1  ')).toBe(false)
    expect(isEmailIdentifier('')).toBe(false)
  })
})

describe('normalizeBadge', () => {
  it('trims whitespace, keeps case for display', () => {
    expect(normalizeBadge('  FB1  ')).toBe('FB1')
  })
})

describe('escapeLike', () => {
  it('escapes LIKE wildcards so ilike matches literally', () => {
    expect(escapeLike('FB%1_2\\3')).toBe('FB\\%1\\_2\\\\3')
  })
})

describe('pickBadgeEmail', () => {
  it('resolves an exact badge to its email (case-insensitive, trimmed)', () => {
    const r = row({ badge_number: 'FB1', email: 'a@x.org' })
    expect(pickBadgeEmail([r], '  fb1 ')).toBe('a@x.org')
  })

  it('picks the oldest active row on duplicates (never errors)', () => {
    const newer = row({ badge_number: 'FB1', email: 'new@x.org', created_at: '2026-02-01T00:00:00Z' })
    const older = row({ badge_number: 'FB1', email: 'old@x.org', created_at: '2026-01-01T00:00:00Z' })
    expect(pickBadgeEmail([newer, older], 'FB1')).toBe('old@x.org')
  })

  it('skips inactive, archived, and blank-email rows', () => {
    const inactive = row({ badge_number: 'FB1', email: 'i@x.org', is_active: false })
    const archived = row({ badge_number: 'FB1', email: 'a@x.org', archived_at: '2026-03-01T00:00:00Z' })
    const noEmail = row({ badge_number: 'FB1', email: '  ' })
    expect(pickBadgeEmail([inactive, archived, noEmail], 'FB1')).toBeNull()
  })

  it('returns null for unknown badges and blank input', () => {
    expect(pickBadgeEmail([row({ badge_number: 'FB1', email: 'a@x.org' })], 'ZZ9')).toBeNull()
    expect(pickBadgeEmail([], 'FB1')).toBeNull()
    expect(pickBadgeEmail([row()], '')).toBeNull()
  })
})
