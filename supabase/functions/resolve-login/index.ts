// ─── resolve-login Edge Function (v72/v73 dual login) ────────────────────────
// Badge → email resolution for dual login (email OR badge). READ-ONLY: never
// writes to portal_users — it only READS the existing email for a badge so
// LoginPage can call the unchanged signIn(email, password). Existing ASO /
// super_admin / deployment users are untouched; passwords unchanged.
//
// Request body: { badge }
// Success:      { email }
// Errors:       { error } with 400 (bad input) / 404 (generic, no hint) /
//               429 (rate-limited, with Retry-After) / 500 (misconfigured).
//
// Throttle: v73 check_login_rate(ip, 'badge:<norm>', 10, 900). If the RPC is
// missing (v73 not applied yet) the lookup still proceeds — rate limiting is
// defense-in-depth, login availability wins.
//
// Deploy (you run — never auto-deployed):
//   supabase functions deploy resolve-login --no-verify-jwt
// "Enforce JWT verification" stays OFF like create-login/manage-login: the
// caller is pre-auth by definition, so there is no JWT to verify. The gateway
// JWT gate would also reject the browser's credential-less OPTIONS preflight.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { isEmailIdentifier, normalizeBadge, escapeLike, pickBadgeEmail } from './helpers.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-retry-count, traceparent, tracestate, baggage',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', ...extraHeaders },
  })
}

function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) {
    const first = fwd.split(',')[0].trim()
    if (first) return first.slice(0, 64)
  }
  const cf = req.headers.get('cf-connecting-ip')
  if (cf && cf.trim()) return cf.trim().slice(0, 64)
  return 'unknown'
}

const ROW_COLS = 'email, badge_number, auth_id, is_active, archived_at, created_at'
const ROW_COLS_FALLBACK = 'email, badge_number, auth_id, is_active, created_at'

async function handler(req: Request) {
  if (req.method === 'OPTIONS') return json({ ok: true })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  try {
    const url = Deno.env.get('SUPABASE_URL')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!url || !serviceKey) return json({ error: 'Server misconfigured' }, 500)

    const body = await req.json().catch(() => ({}))
    const badge = normalizeBadge((body as { badge?: unknown }).badge)
    if (!badge) return json({ error: 'Enter a badge number' }, 400)
    if (isEmailIdentifier(badge)) return json({ error: 'Use email sign-in for email addresses' }, 400)
    if (badge.length > 64) return json({ error: 'Enter a badge number' }, 400)

    const admin = createClient(url, serviceKey)
    const ip = clientIp(req)

    // 1. Throttle (v73). Missing RPC (v73 not applied) → proceed unthrottled.
    try {
      const { data: allowed, error: rlErr } = await admin.rpc('check_login_rate', {
        p_ip: ip,
        p_identity: `badge:${badge.toLowerCase()}`,
        p_max: 10,
        p_window_secs: 900,
      })
      if (!rlErr && allowed === false) {
        return json({ error: 'Too many attempts — try again in 15 minutes' }, 429, {
          'Retry-After': '900',
        })
      }
    } catch {
      // fail open: login availability wins over throttling
    }

    // 2. Lookup (service_role reads past RLS; index idx_portal_users_badge_norm
    //    covers the predicate shape via the ilike + JS exact-match below).
    let rows: Array<Record<string, unknown>> | null = null
    {
      const res = await admin
        .from('portal_users')
        .select(ROW_COLS)
        .ilike('badge_number', escapeLike(badge))
    if (res.error && ((res.error as { code?: string }).code === '42703' || /archived_at/.test(res.error.message || ''))) {
        const fb = await admin.from('portal_users').select(ROW_COLS_FALLBACK).ilike('badge_number', escapeLike(badge))
        if (fb.error) return json({ error: 'No account found for that badge number' }, 404)
        rows = (fb.data || []) as Array<Record<string, unknown>>
      } else if (res.error) {
        return json({ error: 'No account found for that badge number' }, 404)
      } else {
        rows = (res.data || []) as Array<Record<string, unknown>>
      }
    }

    const email = pickBadgeEmail(
      (rows || []) as Array<{ email?: string | null; badge_number?: string | null; auth_id?: string | null; is_active?: boolean | null; archived_at?: string | null; created_at?: string | null }>,
      badge,
    )
    if (!email) return json({ error: 'No account found for that badge number' }, 404)
    return json({ email })
  } catch {
    return json({ error: 'No account found for that badge number' }, 404)
  }
}

// @ts-ignore Deno runtime global
Deno.serve(handler)
