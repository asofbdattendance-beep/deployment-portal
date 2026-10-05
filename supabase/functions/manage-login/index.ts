// ─── manage-login Edge Function ─────────────────────────────────────────────
// Super_admin login management for the portal's Users page: delete,
// set_password, list_meta, bulk_create, send_invite. Same self-auth pattern
// as create-login: the browser holds only the anon key, which can never touch
// the auth admin API — so the privileged calls live here, next to the
// service_role key, and this function enforces its own authorization: caller
// must be an ACTIVE super_admin (checked with the service_role client, never
// trusted from the request body).
//
// Request body: { action, ...action-specific fields }. Targeted actions take
// EITHER { user_id } (a portal_users id — what the Users page holds) or
// { email }; user_id wins when both are given. Aliases delete_user/load_meta
// exist because that is what the shipped hook sends.
//   delete:       { user_id } or { email }
//                 → admin.auth.admin.deleteUser; the portal row cascades
//                    (portal_users.auth_id is ON DELETE CASCADE).
//   set_password: { user_id|email, password }   → min 6 chars.
//   sign_out_all: { user_id } or { email }     → stamps force_logout_at (v70);
//                    kills every existing session via the JWT iat guard.
//   list_meta:    { user_id } or { email }     → last sign-in / created / email-confirmed.
//   bulk_create:  { users: [{ email, name, role, centre?, badge_number?,
//                     password? }] }    → per-row { email, status, error }.
//                                         Never overwrites: createUser only;
//                                         an existing email is a per-row error.
//   send_invite:  { email }             → inviteUserByEmail; graceful fallback
//                                         message when the email provider is
//                                         not configured.
// Overlap safety: every action except delete refuses when the portal row's
// archived_at is not null.
// Success: { ok: true, ... }  Errors: { error } with 400/401/403/404/409.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  actionDelete,
  actionSetPassword,
  actionSignOutAll,
  actionListMeta,
  actionBulkCreate,
  actionSendInvite,
  type ActionResult,
  type Ctx,
} from './actions.ts'

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

const ACTIONS: Record<string, (ctx: Ctx, params: any) => Promise<ActionResult>> = {
  delete: actionDelete,
  delete_user: actionDelete,
  set_password: actionSetPassword,
  sign_out_all: actionSignOutAll,
  list_meta: actionListMeta,
  load_meta: actionListMeta,
  bulk_create: actionBulkCreate,
  send_invite: actionSendInvite,
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

    // 2. Dispatch the requested action (validated inside each action).
    const body = await req.json().catch(() => ({}))
    const action = ACTIONS[String(body.action || '')]
    if (!action) {
      return json({ error: `Unknown action — expected one of: ${Object.keys(ACTIONS).join(', ')}` }, 400)
    }
    const result = await action({ admin, actor: me.name || null }, body)
    if (!result.ok) return json({ error: result.error }, result.status || 400)
    const { status, ...payload } = result
    return json(payload)
  } catch (e) {
    return json({ error: e?.message || 'Unexpected error' }, 500)
  }
}

export default { fetch: handler }

// ─── Deploy (run once, by you — the harness never deploys) ───────────────
// 1. Dashboard → Edge Functions → manage-login (or New Function with this
//    exact slug) → paste this file → Deploy.
// 2. CRITICAL — select the function → Settings → turn OFF "Enforce JWT
//    verification", then redeploy. The gateway's JWT gate rejects the
//    browser's credential-less OPTIONS preflight, which surfaces as exactly
//    this CORS error. Auth is NOT lost: the handler verifies the caller is
//    an ACTIVE super_admin itself (step 1 of the code), which is strictly
//    stronger than the gateway's signed-in check.
//    CLI equivalent: supabase/functions/manage-login gets
//      [functions.manage-login]
//      verify_jwt = false
//    in supabase/config.toml, then: supabase functions deploy manage-login
// 3. Verify preflight yourself (expect HTTP 200 + access-control headers):
//      curl -s -o /dev/null -w "%{http_code}\n" -X OPTIONS \
//        -H "Origin: https://localhost:5174" \
//        -H "Access-Control-Request-Method: POST" \
//        https://<ref>.supabase.co/functions/v1/manage-login
// 4. Then: Users page → manage-login actions. If it still fails, open the
//    function's Logs in the dashboard — a boot/import crash logs there, and
//    every crash also looks like CORS from the browser (no headers on a 500).
