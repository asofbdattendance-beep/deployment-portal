// ─── create-login Edge Function (v48 user management) ─────────────────────
// One-click login creation for the portal's Users page. The browser holds
// only the anon key, which can never create auth users — so the privileged
// step lives here, next to the service_role key, and this function enforces
// its own authorization: caller must be an ACTIVE super_admin (checked with
// the service_role client, never trusted from the request body).
//
// Deploy once (see bottom), then Users → "Create login directly" just works.
//
// Request body: { email, name, role, custom_role_id?, centre?, badge_number?,
//   password?, dept_schedule_id?, dept_ids? }
//   v51: a `dept_incharge` also carries `dept_schedule_id` + `dept_ids` — the
//   DEPARTMENT grant it oversees, applied in the same privileged step (the anon
//   client cannot write it; see 5b).
//   When the superadmin sets a password it is used as-is
//   (min 6 chars); otherwise a one-time temporary password is generated.
// Success:      { ok, user_id, mode, tempPassword? }
//   mode: 'fresh' (row created) | 'overlap-completed' (an existing
//   portal_users row — the attendance overlap — was reinstated/repaired and
//   linked to a working auth account; see ./overlap.ts).
// Errors:       { error } with 400/401/403/404/409 status.
//   409 is reserved for: a genuinely finished active login, a cross-person
//   email, or an active login under a different email for the same badge.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { preflightOverlap } from './overlap.ts'

const ROLES = ['centre_user', 'centre_admin', 'aso', 'super_admin', 'dept_incharge', 'scanner', 'vss_operator']
const CENTRE_ROLES = ['centre_user', 'centre_admin']
const BADGE_ROLES = ['dept_incharge', 'scanner']

// CORS: must cover every header the browser may send (supabase-js sends
// authorization + apikey + x-client-info on every call; content-type with a
// body). Missing entries — or a non-2xx OPTIONS answer — surface in the
// browser as a CORS preflight failure, which is what a missing/crashed
// deployment also looks like. Keep this list in sync with the client SDK.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-retry-count, traceparent, tracestate, baggage',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

function tempPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%'
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('')
}

// Locate the auth account that already owns an email (the adopt path).
// supabase-js has no getUserByEmail, so page through the admin list — the
// portal's user count is small; cap the scan to bound the work.
async function findAuthByEmail(admin, email) {
  const target = String(email || '').trim().toLowerCase()
  for (let page = 1; page <= 40; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) return null
    const users = data?.users || []
    const hit = users.find((u) => String(u.email || '').trim().toLowerCase() === target)
    if (hit) return hit
    if (users.length < 200) break
  }
  return null
}

// NOTE on auth: this function runs with "Enforce JWT verification" OFF (see
// deploy notes) because the gateway's JWT gate rejects the browser's
// credential-less OPTIONS preflight. That loses nothing: the handler below
// verifies the caller itself (getUser + ACTIVE super_admin lookup) which is
// strictly stronger than the gateway's signed-in check.
async function handler(req) {
  if (req.method === 'OPTIONS') return json({ ok: true })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  try {
    const url = Deno.env.get('SUPABASE_URL')
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!url || !anonKey || !serviceKey) return json({ error: 'Server misconfigured' }, 500)

    // 1. Who is calling? Verify the JWT ourselves — never trust a role claim
    //    from the body (user_metadata is user-editable).
    const caller = createClient(url, anonKey, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    })
    const { data: { user } } = await caller.auth.getUser()
    if (!user) return json({ error: 'Not signed in' }, 401)

    const admin = createClient(url, serviceKey)
    const { data: me } = await admin
      .from('portal_users')
      .select('name, role, is_active')
      .eq('auth_id', user.id)
      .maybeSingle()
    if (!me || me.role !== 'super_admin' || me.is_active === false) {
      return json({ error: 'Super admin only' }, 403)
    }

    // 2. Validate the request (same rules as invitationErrors + claim).
    const body = await req.json().catch(() => ({}))
    const email = String(body.email || '').trim()
    const name = String(body.name || '').trim()
    const role = String(body.role || '')
    const centre = role === 'dept_incharge' ? null : (String(body.centre || '').trim() || null)
    const badge = String(body.badge_number || '').trim() || null
    const customId = body.custom_role_id || null
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Enter a valid email address' }, 400)
    if (!name) return json({ error: 'Enter the person’s name' }, 400)
    if (!ROLES.includes(role)) return json({ error: 'Pick a valid role' }, 400)
    if (CENTRE_ROLES.includes(role) && !centre) return json({ error: 'Pick a centre for this role' }, 400)
    if (BADGE_ROLES.includes(role) && !badge) return json({ error: 'Enter a badge number for this role' }, 400)
    if (customId) {
      const { data: custom } = await admin.from('custom_roles').select('base_role').eq('id', customId).maybeSingle()
      if (!custom) return json({ error: 'Custom role no longer exists' }, 400)
      if (custom.base_role !== role) return json({ error: 'Custom role belongs to a different base role' }, 400)
    }

    // 3. OVERLAP-AWARE preflight (the attendance-overlap fix): pull every
    //    portal_users row that matches the typed email OR the badge, then let
    //    the pure decision module choose fresh / resume / conflict (see
    //    ./overlap.ts). The old code refused ANY same-email row — that is
    //    exactly what made existing sewadars un-creatable.
    const deptSchedule = String(body.dept_schedule_id || '').trim() || null
    const deptIds = Array.isArray(body.dept_ids) ? body.dept_ids.filter(Boolean) : []
    if (role === 'dept_incharge') {
      // Validate BEFORE any write — no rollback needed for these.
      if (!deptSchedule) return json({ error: 'Pick the schedule this department applies to' }, 400)
      if (deptIds.length === 0) return json({ error: 'Pick at least one department for this role' }, 400)
    }
    const ROW_COLS = 'id, email, badge_number, auth_id, is_active, name, role, centre, custom_role_id, created_at, archived_at'
    const [emailRows, badgeRows] = await Promise.all([
      admin.from('portal_users').select(ROW_COLS).ilike('email', email).order('created_at', { ascending: true }),
      badge
        ? admin.from('portal_users').select(ROW_COLS).eq('badge_number', badge).order('created_at', { ascending: true })
        : Promise.resolve({ data: [] }),
    ])
    const rows = [...(emailRows.data || [])]
    for (const r of badgeRows.data || []) {
      if (!rows.some((x) => x.id === r.id)) rows.push(r)
    }
    const plan = preflightOverlap({ rows, email, badge })
    if (plan.kind === 'conflict') return json({ error: plan.message }, 409)
    const resumeRow = plan.kind === 'resume' ? plan.row : null

    // 4. Auth account: create fresh, or ADOPT the one that already owns this
    //    email (orphan from the attendance system / a prior half-create) and
    //    apply the password the admin is setting right now — that is the
    //    point of this action.
    const adminPassword = String(body.password || '')
    if (adminPassword && adminPassword.length < 6) {
      return json({ error: 'Password must be at least 6 characters' }, 400)
    }
    const password = adminPassword || tempPassword()
    const generated = !adminPassword
    let authId = null
    let createdAuth = false
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name },
    })
    if (created?.user) {
      authId = created.user.id
      createdAuth = true
    } else {
      const msg = String(createErr?.message || '')
      if (!/already (been )?registered|already exists/i.test(msg)) {
        return json({ error: msg || 'Could not create auth account' }, 400)
      }
      const existingAuth = await findAuthByEmail(admin, email)
      if (!existingAuth) {
        return json({
          error: 'An auth account already exists for this email but cannot be read — open it from the Users page instead',
        }, 409)
      }
      authId = existingAuth.id
      const { error: updErr } = await admin.auth.admin.updateUserById(authId, {
        password,
        email_confirm: true,
        user_metadata: { name },
      })
      if (updErr) {
        return json({ error: updErr.message || 'Could not update the existing auth account' }, 400)
      }
    }

    // 5. Attach the portal identity: UPDATE an existing overlapping row
    //    (reinstate + relink — this is the fix), INSERT a fresh one otherwise.
    //    `role` is always a base value, so every RLS policy and trigger
    //    behaves exactly as for any other login.
    const rowPayload = {
      auth_id: authId,
      email,
      name,
      role,
      custom_role_id: customId,
      centre,
      badge_number: badge,
      is_active: true,
    }
    // A failed step restores the PREVIOUS row state on resume (never deletes
    // a pre-existing record) and only ever deletes an auth account WE
    // created in this call — a hard constraint: never destroy adopted data.
    const undoRow = async () => {
      if (resumeRow) {
        await admin.from('portal_users').update({
          auth_id: resumeRow.auth_id, email: resumeRow.email, name: resumeRow.name,
          role: resumeRow.role, custom_role_id: resumeRow.custom_role_id,
          centre: resumeRow.centre, badge_number: resumeRow.badge_number,
          is_active: resumeRow.is_active,
        }).eq('id', resumeRow.id).catch(() => {})
      } else {
        await admin.from('portal_users').delete().eq('auth_id', authId).catch(() => {})
      }
    }
    const undoAuth = async () => {
      if (createdAuth) await admin.auth.admin.deleteUser(authId).catch(() => {})
    }
    const { error: rowErr } = resumeRow
      ? await admin.from('portal_users').update(rowPayload).eq('id', resumeRow.id)
      : await admin.from('portal_users').insert(rowPayload)
    if (rowErr) {
      // Roll back — a half-created login is worse than none.
      await undoRow()
      await undoAuth()
      return json({ error: rowErr.message }, 400)
    }

    // 5b. v51 department grant. A dept_incharge is scoped by DEPARTMENT for a
    // schedule (across every centre), so the grant is part of provisioning, not
    // a later edit. It must be written HERE: the anon client cannot insert
    // `department_incharge_assignments` (its RLS allows aso/super_admin only),
    // and this function already holds the service role. A failure rolls the
    // whole login back — a dept_incharge with no department would come up with
    // an empty dashboard and an empty scan list. (Presence of deptSchedule /
    // deptIds was validated in step 3, before any write.)
    if (role === 'dept_incharge') {
      const { error: assignErr } = await admin.from('department_incharge_assignments').upsert(
        deptIds.map((department_id) => ({
          schedule_id: deptSchedule,
          department_id,
          badge_number: badge,
          assigned_by: 'create-login',
        })),
        { onConflict: 'schedule_id,department_id,badge_number' }
      )
      if (assignErr) {
        await admin.from('department_incharge_assignments').delete().eq('schedule_id', deptSchedule).eq('badge_number', badge).catch(() => {})
        await undoRow()
        await undoAuth()
        return json({ error: assignErr.message }, 400)
      }
    }

    // 6. Audit (best-effort).
    await admin.from('audit_log').insert({
      action: 'CREATE_LOGIN',
      table_name: 'portal_users',
      record_id: null,
      schedule_id: null,
      payload: { email, role, centre, departments: deptIds.length, via: 'edge-function', mode: resumeRow ? 'overlap-completed' : 'fresh' },
      acted_by: me.name || null,
    }).then(() => {}, () => {})

    return json({
      ok: true,
      user_id: authId,
      mode: resumeRow ? 'overlap-completed' : 'fresh',
      ...(generated ? { tempPassword: password } : {}),
    })
  } catch (e) {
    return json({ error: e?.message || 'Unexpected error' }, 500)
  }
}

export default { fetch: handler }

// ─── Deploy (run once, by you — the harness never deploys) ───────────────
// 1. Dashboard → Edge Functions → create-login (or New Function with this
//    exact slug) → paste this file → Deploy.
// 2. CRITICAL — select the function → Settings → turn OFF "Enforce JWT
//    verification", then redeploy. The gateway's JWT gate rejects the
//    browser's credential-less OPTIONS preflight, which surfaces as exactly
//    this CORS error. Auth is NOT lost: the handler verifies the caller is
//    an ACTIVE super_admin itself (step 1 of the code), which is strictly
//    stronger than the gateway's signed-in check.
//    CLI equivalent: supabase/functions/create-login gets
//      [functions.create-login]
//      verify_jwt = false
//    in supabase/config.toml, then: supabase functions deploy create-login
// 3. Verify preflight yourself (expect HTTP 200 + access-control headers):
//      curl -s -o /dev/null -w "%{http_code}\n" -X OPTIONS \
//        -H "Origin: https://localhost:5174" \
//        -H "Access-Control-Request-Method: POST" \
//        https://<ref>.supabase.co/functions/v1/create-login
// 4. Then: Users page → Create login. If it still fails, open the function's
//    Logs in the dashboard — a boot/import crash logs there, and every crash
//    also looks like CORS from the browser (no headers on a 500).
