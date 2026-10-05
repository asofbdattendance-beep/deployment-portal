// Unit tests for the manage-login actions (the pure module behind the
// manage-login Edge Function). Same convention as create-login's
// overlap.test.ts: import the pure module under Node/Vitest with a mock
// service_role client — no Deno runtime needed.

import { describe, it, expect } from 'vitest'
import {
  actionDelete,
  actionSetPassword,
  actionSignOutAll,
  actionListMeta,
  actionBulkCreate,
  actionSendInvite,
  type Ctx,
  type AdminClient,
} from './actions'

// ─── Mock service_role client ───────────────────────────────────────────────
// Simulates portal_users (in memory), auth.users (in memory), and audit_log
// (captured). deleteUser also drops portal rows with that auth_id, simulating
// the real ON DELETE CASCADE.

interface MockRow {
  id: string
  email: string
  auth_id: string | null
  is_active: boolean
  name: string
  role: string
  centre: string | null
  badge_number: string | null
  archived_at?: string | null
  created_at?: string
}

interface MockAuthUser {
  id: string
  email: string
  created_at: string
  last_sign_in_at: string | null
  email_confirmed_at: string | null
  password?: string
}

interface MockOpts {
  portalRows?: MockRow[]
  authUsers?: MockAuthUser[]
  failOnArchivedCol?: boolean // simulate the archived_at column not deployed yet
  failPortalInsert?: boolean
  inviteError?: string | null // simulate the email provider being absent
}

function makeCtx(opts: MockOpts = {}): Ctx & {
  portalRows: MockRow[]
  authUsers: MockAuthUser[]
  auditSink: any[]
  deletedAuthIds: string[]
} {
  const portalRows: MockRow[] = [...(opts.portalRows ?? [])]
  const authUsers: MockAuthUser[] = [...(opts.authUsers ?? [])]
  const auditSink: any[] = []
  const deletedAuthIds: string[] = []
  let authSeq = 0

  const admin: AdminClient = {
    from(table: string) {
      // Thenable query builder supporting the exact chains actions.ts uses:
      //   .select(cols).ilike('email', v).order(...).limit(1)  → await
      //   .insert(payload) / .update(p).eq('id', v) / .delete().eq('id', v)
      const state: { cols?: string; email?: string; id?: string } = {}
      const execSelect = () => {
        if (opts.failOnArchivedCol && (state.cols || '').includes('archived_at')) {
          return {
            data: null,
            error: { code: '42703', message: 'column "archived_at" of relation "portal_users" does not exist' },
          }
        }
        if (state.id) {
          const hit = portalRows.find((r) => r.id === state.id)
          return { data: hit ? [hit] : [], error: null }
        }
        const target = (state.email || '').toLowerCase()
        const rows = portalRows
          .filter((r) => r.email.toLowerCase() === target)
          .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
        return { data: rows.slice(0, 1), error: null }
      }
      const b: any = {
        select(cols: string) {
          state.cols = cols
          return b
        },
        ilike(col: string, val: string) {
          if (col === 'email') state.email = val
          return b
        },
        eq(col: string, val: string) {
          if (col === 'id') state.id = val
          return b
        },
        order() {
          return b
        },
        limit() {
          return b
        },
        insert(payload: any) {
          if (table === 'audit_log') {
            auditSink.push(payload)
            return Promise.resolve({ data: null, error: null })
          }
          if (opts.failPortalInsert) {
            return Promise.resolve({ data: null, error: { message: 'duplicate key value violates unique constraint' } })
          }
          const row: MockRow = {
            id: `row-${portalRows.length + 1}`,
            is_active: true,
            ...payload,
          }
          portalRows.push(row)
          return Promise.resolve({ data: row, error: null })
        },
        update(payload: any) {
          const st: { id?: string } = {}
          return {
            eq(col: string, val: string) {
              if (col === 'id') st.id = val
              const row = portalRows.find((r) => r.id === st.id)
              if (row) Object.assign(row, payload)
              return Promise.resolve({ data: row ?? null, error: null })
            },
          }
        },
        delete() {
          const st: { id?: string } = {}
          return {
            eq(col: string, val: string) {
              if (col === 'id') st.id = val
              const idx = portalRows.findIndex((r) => r.id === st.id)
              if (idx >= 0) portalRows.splice(idx, 1)
              return Promise.resolve({ data: null, error: null })
            },
          }
        },
        then(onF: any, onR: any) {
          return Promise.resolve(execSelect()).then(onF, onR)
        },
      }
      return b
    },
    auth: {
      admin: {
        listUsers: async ({ page = 1, perPage = 200 } = {}) => {
          const start = (page - 1) * perPage
          return { data: { users: authUsers.slice(start, start + perPage) }, error: null }
        },
        getUserById: async (id: string) => {
          const u = authUsers.find((x) => x.id === id)
          return u
            ? { data: { user: u }, error: null }
            : { data: null, error: { message: 'User not found' } }
        },
        deleteUser: async (id: string) => {
          const idx = authUsers.findIndex((x) => x.id === id)
          if (idx < 0) return { data: {}, error: { message: 'User not found' } }
          authUsers.splice(idx, 1)
          deletedAuthIds.push(id)
          // Simulate portal_users.auth_id ON DELETE CASCADE.
          for (let i = portalRows.length - 1; i >= 0; i--) {
            if (portalRows[i].auth_id === id) portalRows.splice(i, 1)
          }
          return { data: {}, error: null }
        },
        updateUserById: async (id: string, attrs: Record<string, unknown>) => {
          const u = authUsers.find((x) => x.id === id)
          if (!u) return { data: null, error: { message: 'User not found' } }
          if (attrs.password) u.password = String(attrs.password)
          return { data: { user: u }, error: null }
        },
        createUser: async (attrs: Record<string, unknown>) => {
          const email = String(attrs.email || '')
          if (authUsers.some((u) => u.email.toLowerCase() === email.toLowerCase())) {
            return { data: null, error: { message: 'A user with this email address has already been registered' } }
          }
          const user: MockAuthUser = {
            id: `auth-${++authSeq}`,
            email,
            created_at: '2026-10-05T00:00:00Z',
            last_sign_in_at: null,
            email_confirmed_at: attrs.email_confirm ? '2026-10-05T00:00:00Z' : null,
          }
          authUsers.push(user)
          return { data: { user }, error: null }
        },
        inviteUserByEmail: async () => {
          if (opts.inviteError) throw new Error(opts.inviteError)
          return { data: {}, error: null }
        },
      },
    },
  }

  return { admin, actor: 'Test Admin', portalRows, authUsers, auditSink, deletedAuthIds } as any
}

const row = (over: Partial<MockRow> = {}): MockRow => ({
  id: over.id ?? 'row-1',
  email: over.email ?? 'a@b.c',
  auth_id: over.auth_id ?? 'auth-1',
  is_active: over.is_active ?? true,
  name: over.name ?? 'A Person',
  role: over.role ?? 'centre_user',
  centre: over.centre ?? 'MAIN',
  badge_number: over.badge_number ?? null,
  archived_at: over.archived_at ?? null,
  created_at: over.created_at ?? '2026-01-01T00:00:00Z',
})

const authUser = (over: Partial<MockAuthUser> = {}): MockAuthUser => ({
  id: over.id ?? 'auth-1',
  email: over.email ?? 'a@b.c',
  created_at: over.created_at ?? '2026-01-01T00:00:00Z',
  last_sign_in_at: over.last_sign_in_at ?? null,
  email_confirmed_at: over.email_confirmed_at ?? null,
})

// ─── delete ─────────────────────────────────────────────────────────────────

describe('actionDelete', () => {
  it('deletes the auth account and cascades the portal row', async () => {
    const ctx = makeCtx({ portalRows: [row()], authUsers: [authUser()] })
    const res = await actionDelete(ctx, { email: 'a@b.c' })
    expect(res.ok).toBe(true)
    expect(ctx.authUsers).toHaveLength(0)
    expect(ctx.portalRows).toHaveLength(0) // ON DELETE CASCADE simulated
    expect(res.deleted).toBe(true)
  })

  it('is case-insensitive on the email', async () => {
    const ctx = makeCtx({ portalRows: [row()], authUsers: [authUser()] })
    const res = await actionDelete(ctx, { email: 'A@B.C' })
    expect(res.ok).toBe(true)
    expect(ctx.authUsers).toHaveLength(0)
  })

  it('removes an orphan portal row directly when there is no auth account', async () => {
    const ctx = makeCtx({ portalRows: [row({ auth_id: null })], authUsers: [] })
    const res = await actionDelete(ctx, { email: 'a@b.c' })
    expect(res.ok).toBe(true)
    expect(ctx.portalRows).toHaveLength(0)
  })

  it('removes the portal row directly when the auth account is already gone', async () => {
    const ctx = makeCtx({ portalRows: [row({ auth_id: 'auth-gone' })], authUsers: [] })
    const res = await actionDelete(ctx, { email: 'a@b.c' })
    expect(res.ok).toBe(true)
    expect(ctx.portalRows).toHaveLength(0)
  })

  it('404s when no portal row owns the email', async () => {
    const ctx = makeCtx({ portalRows: [], authUsers: [] })
    const res = await actionDelete(ctx, { email: 'nobody@b.c' })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(404)
  })

  it('400s on an invalid email', async () => {
    const ctx = makeCtx()
    const res = await actionDelete(ctx, { email: 'not-an-email' })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(400)
  })

  it('is the ONE action allowed on an archived row', async () => {
    const ctx = makeCtx({
      portalRows: [row({ archived_at: '2026-02-01T00:00:00Z' })],
      authUsers: [authUser()],
    })
    const res = await actionDelete(ctx, { email: 'a@b.c' })
    expect(res.ok).toBe(true)
    expect(ctx.authUsers).toHaveLength(0)
  })

  it('writes an audit entry', async () => {
    const ctx = makeCtx({ portalRows: [row()], authUsers: [authUser()] })
    await actionDelete(ctx, { email: 'a@b.c' })
    expect(ctx.auditSink).toHaveLength(1)
    expect(ctx.auditSink[0].action).toBe('DELETE_LOGIN')
    expect(ctx.auditSink[0].acted_by).toBe('Test Admin')
  })
})

// ─── set_password ───────────────────────────────────────────────────────────

describe('actionSetPassword', () => {
  it('sets the password via updateUserById and audits without plaintext', async () => {
    const ctx = makeCtx({ portalRows: [row()], authUsers: [authUser()] })
    const res = await actionSetPassword(ctx, { email: 'a@b.c', password: 'secret123' })
    expect(res.ok).toBe(true)
    expect(ctx.authUsers[0].password).toBe('secret123')
    expect(ctx.auditSink).toHaveLength(1)
    expect(ctx.auditSink[0].action).toBe('SET_PASSWORD')
    expect(JSON.stringify(ctx.auditSink)).not.toContain('secret123')
  })

  it('rejects passwords shorter than 6 characters', async () => {
    const ctx = makeCtx({ portalRows: [row()], authUsers: [authUser()] })
    const res = await actionSetPassword(ctx, { email: 'a@b.c', password: '12345' })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(400)
    expect(ctx.authUsers[0].password).toBeUndefined()
  })

  it('refuses an archived row with a clear message', async () => {
    const ctx = makeCtx({
      portalRows: [row({ archived_at: '2026-02-01T00:00:00Z' })],
      authUsers: [authUser()],
    })
    const res = await actionSetPassword(ctx, { email: 'a@b.c', password: 'secret123' })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(409)
    expect(String(res.error)).toMatch(/archived/i)
  })

  it('404s when no portal row owns the email', async () => {
    const ctx = makeCtx()
    const res = await actionSetPassword(ctx, { email: 'nobody@b.c', password: 'secret123' })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(404)
  })

  it('409s when the portal row has no auth account', async () => {
    const ctx = makeCtx({ portalRows: [row({ auth_id: null })], authUsers: [] })
    const res = await actionSetPassword(ctx, { email: 'a@b.c', password: 'secret123' })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(409)
  })
})

// ─── list_meta ──────────────────────────────────────────────────────────────

describe('actionListMeta', () => {
  it('returns admin user lookup meta plus portal identity', async () => {
    const ctx = makeCtx({
      portalRows: [row({ name: 'A Person', role: 'centre_admin', is_active: false })],
      authUsers: [authUser({ created_at: '2026-10-01T00:00:00Z', last_sign_in_at: '2026-10-04T10:00:00Z', email_confirmed_at: '2026-10-01T08:00:00Z' })],
    })
    const res = await actionListMeta(ctx, { email: 'a@b.c' })
    expect(res.ok).toBe(true)
    expect(res.name).toBe('A Person')
    expect(res.role).toBe('centre_admin')
    expect(res.is_active).toBe(false)
    expect(res.created_at).toBe('2026-10-01T00:00:00Z')
    expect(res.last_sign_in_at).toBe('2026-10-04T10:00:00Z')
    expect(res.email_confirmed_at).toBe('2026-10-01T08:00:00Z')
  })

  it('refuses an archived row', async () => {
    const ctx = makeCtx({
      portalRows: [row({ archived_at: '2026-02-01T00:00:00Z' })],
      authUsers: [authUser()],
    })
    const res = await actionListMeta(ctx, { email: 'a@b.c' })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(409)
    expect(String(res.error)).toMatch(/archived/i)
  })

  it('404s when the auth account is missing', async () => {
    const ctx = makeCtx({ portalRows: [row({ auth_id: 'auth-gone' })], authUsers: [] })
    const res = await actionListMeta(ctx, { email: 'a@b.c' })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(404)
  })
})

// ─── bulk_create ────────────────────────────────────────────────────────────

describe('actionBulkCreate', () => {
  it('creates the auth account and the portal row, returning user_id', async () => {
    const ctx = makeCtx()
    const res = await actionBulkCreate(ctx, {
      users: [{ email: 'new@b.c', name: 'New Person', role: 'centre_user', centre: 'MAIN' }],
    })
    expect(res.ok).toBe(true)
    expect(res.created).toBe(1)
    const r = res.results[0]
    expect(r.status).toBe('created')
    expect(r.email).toBe('new@b.c')
    expect(r.user_id).toBe('auth-1')
    expect(ctx.authUsers).toHaveLength(1)
    expect(ctx.portalRows).toHaveLength(1)
    expect(ctx.portalRows[0].auth_id).toBe('auth-1')
    expect(ctx.portalRows[0].is_active).toBe(true)
  })

  it('generates a one-time tempPassword when none is provided', async () => {
    const ctx = makeCtx()
    const res = await actionBulkCreate(ctx, {
      users: [{ email: 'new@b.c', name: 'New Person', role: 'centre_user', centre: 'MAIN' }],
    })
    const r = res.results[0]
    expect(r.status).toBe('created')
    expect(typeof r.tempPassword).toBe('string')
    expect(r.tempPassword.length).toBeGreaterThanOrEqual(6)
  })

  it('NEVER overwrites: an existing email is a per-row error, createUser not called again', async () => {
    const ctx = makeCtx({ portalRows: [row({ email: 'a@b.c' })], authUsers: [authUser()] })
    const res = await actionBulkCreate(ctx, {
      users: [{ email: 'a@b.c', name: 'Other', role: 'centre_user', centre: 'MAIN' }],
    })
    expect(res.ok).toBe(true) // the batch itself succeeds
    expect(res.created).toBe(0)
    const r = res.results[0]
    expect(r.status).toBe('error')
    expect(String(r.error)).toMatch(/already exists/i)
    expect(ctx.authUsers).toHaveLength(1) // untouched
    expect(ctx.portalRows).toHaveLength(1) // untouched
  })

  it('rejects roles outside the whitelist', async () => {
    const ctx = makeCtx()
    const res = await actionBulkCreate(ctx, {
      users: [{ email: 'x@b.c', name: 'X', role: 'root_hacker' }],
    })
    expect(res.results[0].status).toBe('error')
    expect(String(res.results[0].error)).toMatch(/valid role/i)
    expect(ctx.authUsers).toHaveLength(0)
  })

  it('rejects short per-row passwords', async () => {
    const ctx = makeCtx()
    const res = await actionBulkCreate(ctx, {
      users: [{ email: 'x@b.c', name: 'X', role: 'centre_user', centre: 'MAIN', password: '123' }],
    })
    expect(res.results[0].status).toBe('error')
    expect(String(res.results[0].error)).toMatch(/at least 6/i)
  })

  it('isolates per-row failures: one bad row does not fail the batch', async () => {
    const ctx = makeCtx({ portalRows: [row({ email: 'a@b.c' })], authUsers: [authUser()] })
    const res = await actionBulkCreate(ctx, {
      users: [
        { email: 'a@b.c', name: 'Dup', role: 'centre_user', centre: 'MAIN' }, // exists → error
        { email: 'bad-email', name: 'Bad', role: 'centre_user', centre: 'MAIN' }, // invalid → error
        { email: 'ok@b.c', name: 'Ok', role: 'centre_user', centre: 'MAIN' }, // fine
      ],
    })
    expect(res.ok).toBe(true)
    expect(res.total).toBe(3)
    expect(res.created).toBe(1)
    expect(res.results[0].status).toBe('error')
    expect(res.results[1].status).toBe('error')
    expect(res.results[2].status).toBe('created')
  })

  it('400s on an empty batch', async () => {
    const ctx = makeCtx()
    const res = await actionBulkCreate(ctx, { users: [] })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(400)
  })

  it('caps the batch size (DoS guard)', async () => {
    const ctx = makeCtx()
    const users = Array.from({ length: 101 }, (_, i) => ({ email: `u${i}@b.c`, name: 'U', role: 'centre_user', centre: 'MAIN' }))
    const res = await actionBulkCreate(ctx, { users })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(400)
    expect(ctx.authUsers).toHaveLength(0)
  })

  it('rolls back the auth account when the portal insert fails', async () => {
    const ctx = makeCtx({ failPortalInsert: true })
    const res = await actionBulkCreate(ctx, {
      users: [{ email: 'new@b.c', name: 'New', role: 'centre_user', centre: 'MAIN' }],
    })
    expect(res.results[0].status).toBe('error')
    expect(ctx.authUsers).toHaveLength(0) // rolled back
    expect(ctx.deletedAuthIds).toHaveLength(1)
    expect(ctx.portalRows).toHaveLength(0)
  })

  it('never logs plaintext: audit carries no password', async () => {
    const ctx = makeCtx()
    await actionBulkCreate(ctx, {
      users: [{ email: 'new@b.c', name: 'New', role: 'centre_user', centre: 'MAIN', password: 'plain123' }],
    })
    expect(ctx.auditSink).toHaveLength(1)
    expect(ctx.auditSink[0].action).toBe('BULK_CREATE')
    expect(JSON.stringify(ctx.auditSink)).not.toContain('plain123')
  })
})

// ─── send_invite ────────────────────────────────────────────────────────────

describe('actionSendInvite', () => {
  it('sends the invite when the email provider is configured', async () => {
    const ctx = makeCtx({ portalRows: [row()], authUsers: [authUser()] })
    const res = await actionSendInvite(ctx, { email: 'a@b.c' })
    expect(res.ok).toBe(true)
    expect(res.invited).toBe(true)
    expect(ctx.auditSink).toHaveLength(1)
    expect(ctx.auditSink[0].action).toBe('SEND_INVITE')
  })

  it('falls back gracefully when the email provider is not configured', async () => {
    const ctx = makeCtx({
      portalRows: [row()],
      authUsers: [authUser()],
      inviteError: 'Email provider is not configured',
    })
    const res = await actionSendInvite(ctx, { email: 'a@b.c' })
    expect(res.ok).toBe(true) // not a hard failure
    expect(res.invited).toBe(false)
    expect(String(res.message)).toMatch(/email provider is not configured/i)
  })

  it('refuses an archived row', async () => {
    const ctx = makeCtx({
      portalRows: [row({ archived_at: '2026-02-01T00:00:00Z' })],
      authUsers: [authUser()],
    })
    const res = await actionSendInvite(ctx, { email: 'a@b.c' })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(409)
    expect(String(res.error)).toMatch(/archived/i)
  })

  it('404s when no portal row owns the email', async () => {
    const ctx = makeCtx()
    const res = await actionSendInvite(ctx, { email: 'nobody@b.c' })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(404)
  })
})

// ─── archived_at column absent (not deployed yet) ────────────────────────────

describe('fetchPortalRow archived_at fallback', () => {
  it('treats rows as not archived when the column query fails with 42703', async () => {
    const ctx = makeCtx({
      portalRows: [row({ archived_at: undefined })],
      authUsers: [authUser()],
      failOnArchivedCol: true,
    })
    const res = await actionSetPassword(ctx, { email: 'a@b.c', password: 'secret123' })
    expect(res.ok).toBe(true)
  })

  it('still enforces the guard once the column exists', async () => {
    const ctx = makeCtx({
      portalRows: [row({ archived_at: '2026-02-01T00:00:00Z' })],
      authUsers: [authUser()],
      failOnArchivedCol: false,
    })
    const res = await actionListMeta(ctx, { email: 'a@b.c' })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(409)
  })
})

// ─── user_id resolution (what the Users page hook sends) ────────────────────

describe('resolveRow by user_id', () => {
  it('deletes by portal row id without an email', async () => {
    const ctx = makeCtx({ portalRows: [row({ id: 'row-9' })], authUsers: [authUser()] })
    const res = await actionDelete(ctx, { user_id: 'row-9' })
    expect(res.ok).toBe(true)
    expect(ctx.portalRows).toHaveLength(0)
    expect(ctx.authUsers).toHaveLength(0)
  })

  it('sets a password by portal row id', async () => {
    const ctx = makeCtx({ portalRows: [row({ id: 'row-9' })], authUsers: [authUser()] })
    const res = await actionSetPassword(ctx, { user_id: 'row-9', password: 'secret123' })
    expect(res.ok).toBe(true)
    expect(ctx.authUsers[0].password).toBe('secret123')
  })

  it('loads meta by portal row id', async () => {
    const ctx = makeCtx({ portalRows: [row({ id: 'row-9' })], authUsers: [authUser()] })
    const res = await actionListMeta(ctx, { user_id: 'row-9' })
    expect(res.ok).toBe(true)
    expect((res as any).email).toBe('a@b.c')
  })

  it('404s on an unknown user_id', async () => {
    const ctx = makeCtx({ portalRows: [row()], authUsers: [authUser()] })
    const res = await actionDelete(ctx, { user_id: 'row-missing' })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(404)
  })

  it('400s when neither user_id nor a valid email is given', async () => {
    const ctx = makeCtx({ portalRows: [row()], authUsers: [authUser()] })
    const res = await actionDelete(ctx, { email: 'not-an-email' })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(400)
  })
})

// ─── sign_out_all ────────────────────────────────────────────────────────────

describe('actionSignOutAll', () => {
  it('stamps force_logout_at by user_id and audits', async () => {
    const ctx = makeCtx({ portalRows: [row({ id: 'row-9' })], authUsers: [authUser()] })
    const res = await actionSignOutAll(ctx, { user_id: 'row-9' })
    expect(res.ok).toBe(true)
    expect((ctx.portalRows[0] as any).force_logout_at).toBeTruthy()
    expect(ctx.auditSink[0].action).toBe('SIGN_OUT_ALL')
  })

  it('works by email too', async () => {
    const ctx = makeCtx({ portalRows: [row()], authUsers: [authUser()] })
    const res = await actionSignOutAll(ctx, { email: 'a@b.c' })
    expect(res.ok).toBe(true)
    expect((ctx.portalRows[0] as any).force_logout_at).toBeTruthy()
  })

  it('refuses an archived row', async () => {
    const ctx = makeCtx({
      portalRows: [row({ archived_at: '2026-02-01T00:00:00Z' })],
      authUsers: [authUser()],
    })
    const res = await actionSignOutAll(ctx, { user_id: 'row-1' })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(409)
  })

  it('409s when the login has no auth account', async () => {
    const orphan = row()
    orphan.auth_id = null
    const ctx = makeCtx({ portalRows: [orphan], authUsers: [] })
    const res = await actionSignOutAll(ctx, { user_id: 'row-1' })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(409)
  })

  it('404s when the auth account is already gone', async () => {
    const ctx = makeCtx({ portalRows: [row({ auth_id: 'auth-gone' })], authUsers: [] })
    const res = await actionSignOutAll(ctx, { user_id: 'row-1' })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(404)
  })
})
