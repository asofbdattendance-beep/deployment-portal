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
//   password? } — when the superadmin sets a password it is used as-is
//   (min 8 chars); otherwise a one-time temporary password is generated.
// Success:      { ok, user_id, tempPassword? } (present only when generated)
// Errors:       { error } with 400/401/403/404/409 status.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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
    const centre = String(body.centre || '').trim() || null
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

    // 3. Refuse duplicates before creating anything (avoid orphan auth rows).
    const { data: existing } = await admin
      .from('portal_users')
      .select('id, is_active')
      .ilike('email', email)
      .limit(1)
      .maybeSingle()
    if (existing) {
      return json({ error: 'A login already exists for this email — edit or reinstate it instead' }, 409)
    }

    // 4. Create the auth account (email pre-confirmed). An admin-set
    //    password is used as-is; otherwise a one-time temporary password is
    //    generated and returned ONCE for the UI to display.
    const adminPassword = String(body.password || '')
    if (adminPassword && adminPassword.length < 8) {
      return json({ error: 'Password needs at least 8 characters' }, 400)
    }
    const password = adminPassword || tempPassword()
    const generated = !adminPassword
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name },
    })
    if (createErr || !created?.user) {
      const msg = String(createErr?.message || '')
      if (/already (been )?registered|already exists/i.test(msg)) {
        return json({ error: 'An auth account already exists for this email — link it from the Users page instead' }, 409)
      }
      return json({ error: msg || 'Could not create auth account' }, 400)
    }

    // 5. Attach the portal identity. `role` is always a base value, so every
    //    RLS policy and trigger behaves exactly as for any other login.
    const { error: rowErr } = await admin.from('portal_users').insert({
      auth_id: created.user.id,
      email,
      name,
      role,
      custom_role_id: customId,
      centre,
      badge_number: badge,
      is_active: true,
    })
    if (rowErr) {
      // Roll back the orphan auth account — a half-created login is worse
      // than none (it could be claimed by nobody and confuse audits).
      await admin.auth.admin.deleteUser(created.user.id).catch(() => {})
      return json({ error: rowErr.message }, 400)
    }

    // 6. Audit (best-effort).
    await admin.from('audit_log').insert({
      action: 'CREATE_LOGIN',
      table_name: 'portal_users',
      record_id: null,
      schedule_id: null,
      payload: { email, role, centre, via: 'edge-function' },
      acted_by: me.name || null,
    }).then(() => {}, () => {})

    return json({ ok: true, user_id: created.user.id, ...(generated ? { tempPassword: password } : {}) })
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
