import { describe, it, expect } from 'vitest'
import {
  passwordErrors,
  userPhaseGroup,
  statusOf,
  canDeleteUser,
  canArchiveUser,
  usersToSheetRows,
  parseImportRows,
} from './userAdmin'

describe('passwordErrors', () => {
  it('rejects passwords shorter than 6 characters', () => {
    expect(passwordErrors('abc')).toContain('Password must be at least 6 characters')
    expect(passwordErrors('12345')).toContain('Password must be at least 6 characters')
  })

  it('rejects empty or nullish passwords', () => {
    expect(passwordErrors('')).toContain('Password must be at least 6 characters')
    expect(passwordErrors(null)).toContain('Password must be at least 6 characters')
    expect(passwordErrors(undefined)).toContain('Password must be at least 6 characters')
  })

  it('accepts passwords of exactly 6 characters', () => {
    expect(passwordErrors('abcdef')).toEqual([])
  })

  it('accepts passwords longer than 6 characters', () => {
    expect(passwordErrors('a'.repeat(12))).toEqual([])
  })
})

describe('userPhaseGroup', () => {
  it('returns "both" for super_admin (sees all phases)', () => {
    expect(userPhaseGroup('super_admin')).toBe('both')
  })

  it('returns "both" for aso (sees all phases)', () => {
    expect(userPhaseGroup('aso')).toBe('both')
  })

  it('returns "both" for centre_user (sees consent phase 1 + attendance phase 2)', () => {
    expect(userPhaseGroup('centre_user')).toBe('both')
  })

  it('returns "attendance" for dept_incharge (phase 2 only)', () => {
    expect(userPhaseGroup('dept_incharge')).toBe('attendance')
  })

  it('returns "deployment" for centre_admin (deployment-side, not scanning)', () => {
    expect(userPhaseGroup('centre_admin')).toBe('deployment')
  })

  it('returns "both" for unknown roles (fallback)', () => {
    expect(userPhaseGroup('nonexistent')).toBe('both')
  })
})

describe('statusOf', () => {
  it('returns "archived" when is_archived is true', () => {
    expect(statusOf({ is_archived: true, is_active: true })).toBe('archived')
  })

  it('returns "suspended" when is_active is false and not archived', () => {
    expect(statusOf({ is_active: false, is_archived: false })).toBe('suspended')
  })

  it('returns "active" when is_active is true and not archived', () => {
    expect(statusOf({ is_active: true, is_archived: false })).toBe('active')
  })

  it('returns "active" for nullish input', () => {
    expect(statusOf(null)).toBe('active')
    expect(statusOf(undefined)).toBe('active')
  })

  it('archived takes priority over suspended', () => {
    expect(statusOf({ is_archived: true, is_active: false })).toBe('archived')
  })
})

describe('canDeleteUser', () => {
  const admin = { id: 'admin-1', role: 'super_admin', is_active: true }
  const target = { id: 'user-1', role: 'centre_user', is_active: true }

  it('allows deleting another user', () => {
    expect(canDeleteUser(target, admin)).toBe(true)
  })

  it('blocks self-delete', () => {
    expect(canDeleteUser(admin, admin)).toBe(false)
  })

  it('blocks when target is nullish', () => {
    expect(canDeleteUser(null, admin)).toBe(false)
  })

  it('blocks when currentUser is nullish', () => {
    expect(canDeleteUser(target, null)).toBe(false)
  })
})

describe('canArchiveUser', () => {
  const admin = { id: 'admin-1', role: 'super_admin', is_active: true }
  const target = { id: 'user-1', role: 'centre_user', is_active: true }

  it('allows archiving another user', () => {
    expect(canArchiveUser(target, admin)).toBe(true)
  })

  it('blocks self-archive', () => {
    expect(canArchiveUser(admin, admin)).toBe(false)
  })

  it('blocks when target is nullish', () => {
    expect(canArchiveUser(null, admin)).toBe(false)
  })

  it('blocks when currentUser is nullish', () => {
    expect(canArchiveUser(target, null)).toBe(false)
  })
})

describe('usersToSheetRows', () => {
  it('maps user objects to flat sheet rows', () => {
    const users = [
      { name: 'Ram', email: 'ram@example.com', role: 'centre_user', centre: 'DELHI', badge_number: 'B001', is_active: true, is_archived: false },
    ]
    const rows = usersToSheetRows(users)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      name: 'Ram',
      email: 'ram@example.com',
      role: 'centre_user',
      centre: 'DELHI',
      badge_number: 'B001',
      status: 'active',
      phase_group: 'both',
      is_archived: 'no',
    })
  })

  it('handles empty array', () => {
    expect(usersToSheetRows([])).toEqual([])
  })

  it('carries the optional location through to the sheet row', () => {
    const rows = usersToSheetRows([
      { name: 'S', email: 's@x.com', role: 'scanner', badge_number: 'FB9', is_active: true, location: 'Bhati Gate 2' },
      { name: 'T', email: 't@x.com', role: 'scanner', badge_number: 'FB10', is_active: true },
    ])
    expect(rows[0].location).toBe('Bhati Gate 2')
    expect(rows[1].location).toBe('')
  })

  it('handles nullish input', () => {
    expect(usersToSheetRows(null)).toEqual([])
  })
})

describe('parseImportRows', () => {
  it('parses valid rows', () => {
    const rows = [
      { name: 'Ram', email: 'ram@example.com', role: 'centre_user' },
      { name: 'Shyam', email: 'shyam@example.com', role: 'aso' },
    ]
    const { valid, errors } = parseImportRows(rows)
    expect(valid).toHaveLength(2)
    expect(errors).toEqual([])
    expect(valid[0]).toEqual({ name: 'Ram', email: 'ram@example.com', role: 'centre_user' })
  })

  it('reports errors for rows missing name', () => {
    const rows = [{ email: 'a@b.com', role: 'aso' }]
    const { valid, errors } = parseImportRows(rows)
    expect(valid).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect(errors[0].row).toBe(2)
    expect(errors[0].message).toContain('name')
  })

  it('reports errors for rows missing email', () => {
    const rows = [{ name: 'Ram', role: 'aso' }]
    const { valid, errors } = parseImportRows(rows)
    expect(valid).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('email')
  })

  it('reports errors for rows missing role', () => {
    const rows = [{ name: 'Ram', email: 'ram@example.com' }]
    const { valid, errors } = parseImportRows(rows)
    expect(valid).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('role')
  })

  it('handles empty input', () => {
    const { valid, errors } = parseImportRows([])
    expect(valid).toEqual([])
    expect(errors).toEqual([])
  })
})
