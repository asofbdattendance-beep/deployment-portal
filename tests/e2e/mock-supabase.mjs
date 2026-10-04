#!/usr/bin/env node
/**
 * Mock Supabase backend for the T2 Playwright rig (Phase D).
 *
 * Serves just enough of the Supabase surface for the scanner flow:
 *   POST /auth/v1/token?grant_type=password  → session + user (any credentials)
 *   GET  /auth/v1/user                       → user (Authorization ignored)
 *   GET  /rest/v1/<table>                    → canned rows (query params ignored)
 *   POST /rest/v1/rpc/<fn>                   → get_portal_profile / get_scan_state
 *                                             / scan_in / scan_out
 *   GET  POST /__test/...                    → rig control (reset, seed, calls)
 *
 * Realtime (/realtime/v1/websocket) is deliberately unhandled: the upgrade
 * socket is destroyed, the client retries quietly in the background, and no
 * spec may depend on realtime delivery. State lives in memory; POST
 * /__test/reset wipes calls + seeds between specs.
 *
 * Nothing here touches a real project. Not a migration — never apply anywhere.
 */
import http from 'node:http'

const PORT = 54321

const USER = { id: 'user-scanner-1', email: 'scanner@example.com' }
const PROFILE = {
  id: 'user-scanner-1',
  email: 'scanner@example.com',
  role: 'scanner',
  centre: 'DELHI',
  badge_number: 'SC01',
  name: 'Scanner One',
}

const TABLES = {
  deployment_schedules: [
    { id: 'sched-1', name: 'October 2026 Visit', status: 'open', deadline: null },
  ],
  deployments: [],
  deployment_departments: [{ id: 'dept-1', name: 'MEDICAL' }],
  dp_attendance_sessions: [],
}

const state = {
  calls: [], // { rpc, params, at }
  seed: {}, // rpcName -> 'error' | 'hang' | { data, error }
  profileOverride: null, // { role, centre, ... } merged over PROFILE by seed
}

// ── opt-in rig variation ─────────────────────────────────────────────
// Print/PDF specs need (a) a role that owns the Reports tab — `scanner`
// has none, so the tab never renders — and (b) a schedule with a visit
// window, or `resolveSewaMode` reports PREVISIT and the app renders
// PrevisitView instead of ReportsPage. Both are driven from the
// environment so they are OFF by default: CI never sets them and every
// existing spec keeps its current behaviour byte-for-byte.
if (process.env.MOCK_ROLE) PROFILE.role = process.env.MOCK_ROLE
if (process.env.MOCK_VISIT_WINDOW) {
  const [start, end] = process.env.MOCK_VISIT_WINDOW.split('/')
  Object.assign(TABLES.deployment_schedules[0], {
    visit_start_date: start,
    visit_end_date: end,
  })
}

function json(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  })
  res.end(body)
}

function cors(req, res) {
  res.setHeader('access-control-allow-origin', '*')
  // Echo whatever the client preflights (supabase-js sends apikey,
  // authorization, content-type, x-client-info AND x-supabase-api-version).
  // A static list rots the moment the client adds a header — see L-24's
  // first failure, which was exactly that.
  const requested = req.headers['access-control-request-headers']
  res.setHeader(
    'access-control-allow-headers',
    requested ||
      'apikey, authorization, content-type, x-client-info, x-supabase-api-version, prefer, range, range-unit',
  )
  res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS')
  res.setHeader('access-control-expose-headers', 'content-range')
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function rpcResult(name, params) {
  state.calls.push({ rpc: name, params, at: Date.now() })
  const seed = state.seed[name]
  if (seed === 'hang') return new Promise(() => {}) // never settles
  // NOTE: PostgREST returns the function's value directly as the body;
  // supabase-js maps HTTP 4xx + { message, code } to `error`.
  if (seed === 'error') return { __status: 400, __body: { message: 'seeded error', code: 'SEED' } }
  // Per-badge failures: { scan_in_error_for: { BADGE: { message, code } } }.
  // Lets one queued row poison while its neighbours drain (or drop).
  const perBadge = state.seed[`${name}_error_for`]
  const failure = perBadge && params && perBadge[params.p_badge]
  if (failure) return { __status: 400, __body: failure }
  // A seed object is the success body — unless it carries __status/__body,
  // which simulate an exact server failure (poison rows, stale open_ids).
  // A seed holding ONLY *_error_for control keys falls through to the
  // default behaviour below so unlisted badges still succeed.
  const onlyControl = seed && typeof seed === 'object'
    && Object.keys(seed).length > 0
    && Object.keys(seed).every((k) => k.endsWith('_error_for'))
  if (seed && typeof seed === 'object' && !onlyControl) {
    if (typeof seed.__status === 'number') return { __status: seed.__status, __body: seed.__body ?? null }
    return { __status: 200, __body: seed }
  }
  switch (name) {
    case 'get_portal_profile':
      return { __status: 200, __body: { ...PROFILE, ...(state.profileOverride || {}) } }
    case 'get_scan_state':
      return { __status: 200, __body: { open: null, last_out: null } }
    case 'scan_in':
      return {
        __status: 200,
        __body: {
          ok: true,
          sewadar_name: 'RAM',
          sewadar_centre: 'DELHI',
          dept_name: 'MEDICAL',
        },
      }
    case 'scan_out':
      return {
        __status: 200,
        __body: {
          ok: true,
          sewadar_name: 'RAM',
          sewadar_centre: 'DELHI',
          dept_name: 'MEDICAL',
        },
      }
    default:
      return { __status: 200, __body: null }
  }
}

const server = http.createServer(async (req, res) => {
  cors(req, res)
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  const url = new URL(req.url, `http://${req.headers.host}`)
  const { pathname, searchParams } = url

  // ── rig control ──
  if (pathname === '/__test/reset' && req.method === 'POST') {
    state.calls = []
    state.seed = {}
    state.profileOverride = null
    json(res, 200, { ok: true })
    return
  }
  if (pathname === '/__test/seed' && req.method === 'POST') {
    const body = await readBody(req)
    // Merge: specs layer seeds (an old open session AND a poison badge).
    // Reset wipes everything between specs.
    state.seed = { ...state.seed, ...(body?.rpc || {}) }
    // Role override: a spec that needs a multi-tab role (e.g. dept_incharge
    // for the navigate-away sync proof) seeds { profile: { role, ... } }.
    // USER/session identity is untouched, so the queue owner still matches.
    if (body?.profile && typeof body.profile === 'object') {
      state.profileOverride = body.profile
    }
    json(res, 200, { ok: true })
    return
  }
  if (pathname === '/__test/calls' && req.method === 'GET') {
    json(res, 200, state.calls)
    return
  }

  // ── auth ──
  if (pathname === '/auth/v1/token' && req.method === 'POST') {
    await readBody(req)
    json(res, 200, {
      access_token: 'e2e-access-token',
      token_type: 'bearer',
      expires_in: 3600,
      refresh_token: 'e2e-refresh-token',
      user: USER,
    })
    return
  }
  if (pathname === '/auth/v1/user' && req.method === 'GET') {
    json(res, 200, USER)
    return
  }
  if (pathname === '/auth/v1/logout') {
    json(res, 204, {})
    return
  }

  // ── RPC ──
  const rpcMatch = pathname.match(/^\/rest\/v1\/rpc\/([A-Za-z0-9_]+)$/)
  if (rpcMatch && req.method === 'POST') {
    const params = await readBody(req)
    const out = await rpcResult(rpcMatch[1], params)
    json(res, out.__status, out.__body)
    return
  }

  // ── REST tables ──
  const restMatch = pathname.match(/^\/rest\/v1\/([A-Za-z0-9_]+)$/)
  if (restMatch && req.method === 'GET') {
    const rows = TABLES[restMatch[1]] ?? []
    void searchParams
    json(res, 200, rows, { 'content-range': `*/${rows.length}` })
    return
  }

  json(res, 404, { message: `mock: no route ${req.method} ${pathname}` })
})

server.on('upgrade', (req, socket) => {
  // No realtime in the rig: drop the upgrade, the client retries quietly.
  socket.destroy()
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-supabase] listening on http://127.0.0.1:${PORT}`)
})
