// ─── manage-login actions (pure, dependency-injected) ──────────────────────
// The five super_admin login-management actions behind the manage-login Edge
// Function. Every action takes a Ctx (service_role client + actor name for
// audit) and plain params, and returns an ActionResult — no Deno APIs, no
// Response objects — so the same module runs under Deno (deployed) and under
// Node/Vitest (unit-tested; see ./actions.test.ts).
//
// Security invariants:
//   - NEVER overwrite: bulk_create only calls admin.createUser; an existing
//     email is a per-row error, never an update or adopt.
//   - NEVER log plaintext: passwords travel only inside per-row results and
//     the updateUserById call — never into audit_log, error messages, or
//     list_meta output.
//   - Overlap safety: every action except delete refuses when the portal row's
//     archived_at is not null (delete is the one sanctioned way to clear an
//     archived login).
//   - The archived_at column is not deployed everywhere yet — fetchPortalRow
//     tolerates its absence (PostgREST error 42703) and treats rows as not
//     archived until the column exists.

export interface PortalRow {
  id: string
  email: string | null
  auth_id: string | null
  is_active: boolean
  name: string
  role: string
  centre: string | null
  badge_number: string | null
  archived_at: string | null
}

// Structural type: satisfied by the supabase-js service_role client in the
// deployed function and by the mock in actions.test.ts.
export interface AdminClient {
  from(table: string): any
  auth: {
    admin: {
      listUsers(opts?: { page?: number; perPage?: number }): Promise<any>
      getUserById(id: string): Promise<any>
      deleteUser(id: string): Promise<any>
      updateUserById(id: string, attrs: Record<string, unknown>): Promise<any>
      createUser(attrs: Record<string, unknown>): Promise<any>
      inviteUserByEmail(email: string): Promise<any>
    }
  }
}

export interface Ctx {
  admin: AdminClient
  actor: string | null
}

export interface ActionResult {
  ok: boolean
  status?: number
  error?: string
  [key: string]: unknown
}

// Same role whitelist as create-login — role is always a base value so every
// RLS policy and trigger behaves identically.
export const ROLES = ['centre_user', 'centre_admin', 'aso', 'super_admin', 'dept_incharge', 'scanner', 'vss_operator']
const CENTRE_ROLES = ['centre_user', 'centre_admin']
const BADGE_ROLES = ['dept_incharge', 'scanner']

const MAX_BULK = 100 // DoS cap on a single privileged request
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ROW_COLS = 'id, email, auth_id, is_active, name, role, centre, badge_number, archived_at'
const ROW_COLS_NO_ARCHIVED = 'id, email, auth_id, is_active, name, role, centre, badge_number'

function err(status: number, message: string): ActionResult {
  return { ok: false, status, error: message }
}

function normalizeEmail(email: unknown): string | null {
  const trimmed = String(email || '').trim()
  return EMAIL_RE.test(trimmed) ? trimmed.toLowerCase() : null
}

function tempPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%'
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('')
}

// Overlap safety: refuse any modification of an archived login. delete is the
// one exception (it is how an archived login gets cleared) — see actionDelete.
function archivedGuard(row: PortalRow): ActionResult | null {
  if (row && row.archived_at != null) {
    return err(409, 'This login is archived and cannot be modified — archived logins can only be deleted')
  }
  return null
}

type FetchResult = { row: PortalRow | null } | { fetchError: { status: number; message: string } }

// Fetch the portal row that owns an email (case-insensitive, oldest first —
// portal_users has no unique email index). Tolerates the archived_at column
// not being deployed yet: PostgREST answers 42703, we retry without the
// column and treat the row as not archived.
async function fetchPortalRow(admin: AdminClient, email: string): Promise<FetchResult> {
  const tryQuery = (cols: string) =>
    admin.from('portal_users').select(cols).ilike('email', email).order('created_at', { ascending: true }).limit(1)
  const { data, error } = await tryQuery(ROW_COLS)
  if (error && (error.code === '42703' || /archived_at/.test(error.message || ''))) {
    const { data: d2, error: e2 } = await tryQuery(ROW_COLS_NO_ARCHIVED)
    if (e2) return { fetchError: { status: 500, message: e2.message || 'Could not read the login' } }
    const row = Array.isArray(d2) && d2.length > 0 ? { ...d2[0], archived_at: null } : null
    return { row }
  }
  if (error) return { fetchError: { status: 500, message: error.message || 'Could not read the login' } }
  const row = Array.isArray(data) && data.length > 0 ? data[0] : null
  return { row }
}

// Resolve the target portal row from EITHER a portal_users id (what the
// Users page holds and the hook sends as user_id) or an email address.
// user_id wins when both are given. Keeps the email-path behaviour and
// status codes identical so existing callers are unaffected.
type ResolveResult = { row: PortalRow | null; email: string } | { fetchError: { status: number; message: string } }

async function resolveRow(admin: AdminClient, params: Record<string, unknown>): Promise<ResolveResult> {
  const userId = String((params as any)?.user_id || '').trim()
  if (userId) {
    const tryById = (cols: string) =>
      admin.from('portal_users').select(cols).eq('id', userId).limit(1)
    const { data, error } = await tryById(ROW_COLS)
    if (error && ((error as any).code === '42703' || /archived_at/.test(error.message || ''))) {
      const { data: d2, error: e2 } = await tryById(ROW_COLS_NO_ARCHIVED)
      if (e2) return { fetchError: { status: 500, message: e2.message || 'Could not read the login' } }
      const r = Array.isArray(d2) && d2.length > 0 ? { ...d2[0], archived_at: null } : null
      if (!r) return { row: null, email: '' }
      return { row: r, email: String(r.email || '') }
    }
    if (error) return { fetchError: { status: 500, message: error.message || 'Could not read the login' } }
    const r = Array.isArray(data) && data.length > 0 ? data[0] : null
    if (!r) return { row: null, email: '' }
    return { row: r, email: String(r.email || '') }
  }
  const email = normalizeEmail((params as any)?.email)
  if (!email) return { fetchError: { status: 400, message: 'Enter a valid email address' } }
  const { row, fetchError } = await fetchPortalRow(admin, email)
  if (fetchError) return { fetchError }
  if (!row) return { row: null, email }
  return { row, email }
}

// Best-effort audit, same shape as create-login. Never throws, never carries
// plaintext secrets.
async function audit(ctx: Ctx, action: string, payload: Record<string, unknown>) {
  await ctx.admin.from('audit_log').insert({
    action,
    table_name: 'portal_users',
    record_id: null,
    schedule_id: null,
    payload,
    acted_by: ctx.actor,
  }).then(() => {}, () => {})
}

// ─── delete ─────────────────────────────────────────────────────────────────
// Remove a login: admin.auth.admin.deleteUser, and the portal row goes with it
// (portal_users.auth_id is ON DELETE CASCADE). delete is the ONE action allowed
// on an archived row — it is how an archived login gets cleared.
export async function actionDelete(ctx: Ctx, params: Record<string, unknown>): Promise<ActionResult> {
  const resolved = await resolveRow(ctx.admin, params)
  if ('fetchError' in resolved) return err(resolved.fetchError.status, resolved.fetchError.message)
  const { row, email } = resolved
  if (!row) return err(404, email ? 'No login found for this email' : 'No login found')

  if (row.auth_id) {
    const { error } = await ctx.admin.auth.admin.deleteUser(row.auth_id)
    if (error && /not found|could not find/i.test(error.message || '')) {
      // The auth account is already gone, so the cascade never fired —
      // remove the orphaned portal row directly.
      const { error: delErr } = await ctx.admin.from('portal_users').delete().eq('id', row.id)
      if (delErr) return err(400, delErr.message)
      await audit(ctx, 'DELETE_LOGIN', { email, via: 'edge-function', orphan: true })
      return { ok: true, deleted: true, note: 'auth account was already gone; portal row removed directly' }
    }
    if (error) return err(400, `Could not delete the auth account: ${error.message}`)
    // auth user gone → portal row cascades via auth_id ON DELETE CASCADE.
    await audit(ctx, 'DELETE_LOGIN', { email, via: 'edge-function' })
    return { ok: true, deleted: true, note: 'auth account deleted; portal row removed via ON DELETE CASCADE' }
  }

  // Orphan portal row (no auth account) — remove it directly.
  const { error } = await ctx.admin.from('portal_users').delete().eq('id', row.id)
  if (error) return err(400, error.message)
  await audit(ctx, 'DELETE_LOGIN', { email, via: 'edge-function', orphan: true })
  return { ok: true, deleted: true, note: 'orphan portal row removed directly' }
}

// ─── set_password ────────────────────────────────────────────────────────────
export async function actionSetPassword(ctx: Ctx, params: Record<string, unknown>): Promise<ActionResult> {
  const password = String(params?.password ?? '')
  if (password.length < 6) return err(400, 'Password must be at least 6 characters')
  const resolved = await resolveRow(ctx.admin, params)
  if ('fetchError' in resolved) return err(resolved.fetchError.status, resolved.fetchError.message)
  const { row, email } = resolved
  if (!row) return err(404, email ? 'No login found for this email' : 'No login found')
  const archived = archivedGuard(row)
  if (archived) return archived
  if (!row.auth_id) return err(409, 'This login has no auth account — set a password once the auth account exists')
  const { data: authUser, error: lookupErr } = await ctx.admin.auth.admin.getUserById(row.auth_id)
  if (lookupErr || !authUser?.user) return err(409, 'This login has no auth account — set a password once the auth account exists')
  const { error } = await ctx_auth_admin_update(ctx, row.auth_id, password)
  if (error) return err(400, error)
  await audit(ctx, 'SET_PASSWORD', { email, via: 'edge-function' })
  return { ok: true }
}

// Indirection so the mock and the real client share one call shape.
async function ctx_auth_admin_update(ctx: Ctx, authId: string, password: string) {
  const { error } = await ctx.admin.auth.admin.updateUserById(authId, { password })
  return { error: error?.message || null }
}

// ─── list_meta ──────────────────────────────────────────────────────────────
// Admin user lookup: last sign-in / created / email-confirmed, plus the
// portal identity fields.
export async function actionListMeta(ctx: Ctx, params: Record<string, unknown>): Promise<ActionResult> {
  const resolved = await resolveRow(ctx.admin, params)
  if ('fetchError' in resolved) return err(resolved.fetchError.status, resolved.fetchError.message)
  const { row, email } = resolved
  if (!row) return err(404, email ? 'No login found for this email' : 'No login found')
  const archived = archivedGuard(row)
  if (archived) return archived
  if (!row.auth_id) return err(409, 'This login has no auth account')
  const { data, error } = await ctx.admin.auth.admin.getUserById(row.auth_id)
  if (error || !data?.user) return err(404, 'Auth account not found for this login')
  const u = data.user
  return {
    ok: true,
    email: row.email,
    name: row.name,
    role: row.role,
    is_active: row.is_active,
    created_at: u.created_at ?? null,
    last_sign_in_at: u.last_sign_in_at ?? null,
    email_confirmed_at: u.email_confirmed_at ?? null,
  }
}

// ─── sign_out_all ───────────────────────────────────────────────────────────
// "Sign out on every device": stamps force_logout_at. Any JWT issued before
// the stamp fails the iat guard in get_portal_user_role/centre/profile (v70)
// so existing sessions die; the next sign-in mints a fresh token that passes.
export async function actionSignOutAll(ctx: Ctx, params: Record<string, unknown>): Promise<ActionResult> {
  const resolved = await resolveRow(ctx.admin, params)
  if ('fetchError' in resolved) return err(resolved.fetchError.status, resolved.fetchError.message)
  const { row, email } = resolved
  if (!row) return err(404, email ? 'No login found for this email' : 'No login found')
  const archived = archivedGuard(row)
  if (archived) return archived
  if (!row.auth_id) return err(409, 'This login has no auth account')
  const { data, error: lookupErr } = await ctx.admin.auth.admin.getUserById(row.auth_id)
  if (lookupErr || !data?.user) return err(404, 'Auth account not found for this login')
  const { error } = await ctx.admin.from('portal_users').update({ force_logout_at: new Date().toISOString() }).eq('id', row.id)
  if (error) {
    if ((error as any).code === '42703' || /force_logout_at/.test(error.message || '')) {
      return err(409, 'Sign-out-everywhere needs migration v70 — run it first, then retry')
    }
    return err(400, error.message)
  }
  await audit(ctx, 'SIGN_OUT_ALL', { email, via: 'edge-function' })
  return { ok: true }
}

// ─── bulk_create ────────────────────────────────────────────────────────────
// Loop admin.createUser + portal row insert. Per-row result:
//   { email, status: 'created' | 'error', user_id?, tempPassword?, error? }
// Never overwrites: an existing email is a per-row error, never an update.
export async function actionBulkCreate(ctx: Ctx, params: Record<string, unknown>): Promise<ActionResult> {
  const users = Array.isArray(params?.users) ? params.users : []
  if (users.length === 0) return err(400, 'Provide at least one user to create')
  if (users.length > MAX_BULK) return err(400, `Too many users at once — max ${MAX_BULK} per request`)
  const results: ActionResult[] = []
  for (const raw of users) {
    results.push(await bulkCreateOne(ctx, raw))
  }
  const created = results.filter((r) => r.status === 'created').length
  await audit(ctx, 'BULK_CREATE', { total: users.length, created, via: 'edge-function' })
  return { ok: true, total: users.length, created, results }
}

async function bulkCreateOne(ctx: Ctx, raw: unknown): Promise<ActionResult> {
  const email = normalizeEmail((raw as any)?.email)
  const base: Record<string, unknown> = { email }
  if (!email) return { ...base, status: 'error', error: 'Enter a valid email address' }
  const r = raw as Record<string, unknown>
  const name = String(r?.name || '').trim()
  const role = String(r?.role || '')
  const centre = String(r?.centre || '').trim() || null
  const badge = String(r?.badge_number || '').trim() || null
  const location = String((r as any)?.location || '').trim() || null
  if (!name) return { ...base, status: 'error', error: 'Enter the person’s name' }
  if (!ROLES.includes(role)) return { ...base, status: 'error', error: 'Pick a valid role' }
  if (CENTRE_ROLES.includes(role) && !centre) return { ...base, status: 'error', error: 'Pick a centre for this role' }
  if (BADGE_ROLES.includes(role) && !badge) return { ...base, status: 'error', error: 'Enter a badge number for this role' }

  // NEVER overwrite: an existing email is a per-row error, never an update.
  const { row, fetchError } = await fetchPortalRow(ctx.admin, email)
  if (fetchError) return { ...base, status: 'error', error: fetchError.message }
  if (row) return { ...base, status: 'error', error: 'A login already exists for this email' }

  // Password: admin-provided (min 6) or a generated one-time temp. The
  // plaintext is NEVER logged — it travels only in this per-row result.
  let password = String(r?.password || '')
  let generatedPassword: string | null = null
  if (!password) {
    password = tempPassword()
    generatedPassword = password
  } else if (password.length < 6) {
    return { ...base, status: 'error', error: 'Password must be at least 6 characters' }
  }

  const { data: created, error: createErr } = await ctx.admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name },
  })
  const authId = created?.user?.id
  if (!authId) {
    return { ...base, status: 'error', error: createErr?.message || 'Could not create the auth account' }
  }

  const { error: rowErr } = await ctx.admin.from('portal_users').insert({
    auth_id: authId,
    email,
    name,
    role,
    centre,
    badge_number: badge,
    location,
    is_active: true,
  })
  if (rowErr) {
    // Roll back — a half-created login is worse than none. Only ever delete
    // an auth account WE created in this call.
    await ctx.admin.auth.admin.deleteUser(authId).catch(() => {})
    return { ...base, status: 'error', error: rowErr.message || 'Could not create the portal login' }
  }
  return {
    ...base,
    status: 'created',
    user_id: authId,
    ...(generatedPassword ? { tempPassword: generatedPassword } : {}),
  }
}

// ─── send_invite ────────────────────────────────────────────────────────────
// inviteUserByEmail sends via the project's email provider. The provider's
// enablement is project config, not an env var — the only way to detect it is
// to attempt the invite. When the provider is absent we return a graceful
// fallback message (ok: true, invited: false) instead of failing the request.
export async function actionSendInvite(ctx: Ctx, params: Record<string, unknown>): Promise<ActionResult> {
  const email = normalizeEmail(params?.email)
  if (!email) return err(400, 'Enter a valid email address')
  const { row, fetchError } = await fetchPortalRow(ctx.admin, email)
  if (fetchError) return err(fetchError.status, fetchError.message)
  if (!row) return err(404, 'No login found for this email')
  const archived = archivedGuard(row)
  if (archived) return archived
  if (!row.auth_id) return err(409, 'This login has no auth account to invite')
  const { data, error: lookupErr } = await ctx.admin.auth.admin.getUserById(row.auth_id)
  if (lookupErr || !data?.user) return err(404, 'Auth account not found for this login')
  try {
    await ctx.admin.auth.admin.inviteUserByEmail(email)
  } catch (e) {
    const msg = String(e?.message || '')
    if (/provider|not configured|not enabled|smtp|email.*disabled/i.test(msg)) {
      return {
        ok: true,
        invited: false,
        message: 'Email provider is not configured on this project, so no invite email was sent. Share the password with the person over a trusted channel instead.',
      }
    }
    return err(400, msg || 'Could not send the invite')
  }
  await audit(ctx, 'SEND_INVITE', { email, via: 'edge-function' })
  return { ok: true, invited: true }
}
