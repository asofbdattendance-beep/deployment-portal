#!/usr/bin/env node
// ============================================================
// rebuild_test_logins.mjs — ONE-COMMAND repair for the 500
// ------------------------------------------------------------
// WHY THIS EXISTS
//   Hand-inserting rows into auth.users is what caused the 500. GoTrue
//   expects values in columns a manual INSERT cannot know about, and
//   hand-written patches keep chasing them one at a time. This script
//   removes the hand-inserted users and lets GOTRUE write them itself,
//   so the result cannot inherit any of that.
//
//   DELETE-then-CREATE, not update: updateUserById only writes the fields
//   you pass, so it would leave the unknown NULLs in place. A fresh
//   create guarantees a GoTrue-native row.
//
//   Default is safe: it touches ONLY test.%@portal.test accounts.
//
// ── USAGE ────────────────────────────────────────────────────
//   export SUPABASE_URL="https://wgavvihuwwwoqpbqntgp.supabase.co"
//   export SUPABASE_SERVICE_ROLE_KEY="sb_secret_..."   # Dashboard → API
//   export TEST_USER_PASSWORD='Test@123'
//   node scripts/rebuild_test_logins.mjs
//
//   Flags:
//     --include-admin   also (re)create a super_admin test login
//     --keep-existing   skip the DELETE step, only ensure + relink
//
// ── SECURITY ─────────────────────────────────────────────────
//   · service_role key is read from the environment ONLY. Never commit
//     it, never pass it as an argument, never put it in .env (VITE_
//     prefixed vars are bundled into the client).
//   · No default password. A committed credential outlives the account.
// ============================================================

import { createClient } from '@supabase/supabase-js'

// Trim whitespace/quotes people accidentally paste. A key with a stray
// newline or a pair of quotes is a very common cause of an opaque failure.
const clean = (v) => String(v || '').trim().replace(/^["']|["']$/g, '').trim()

const URL = clean(process.env.SUPABASE_URL)
const SERVICE_ROLE = clean(process.env.SUPABASE_SERVICE_ROLE_KEY)
const PASSWORD = process.env.TEST_USER_PASSWORD

if (!URL)      { console.error('✗ SUPABASE_URL is not set'); process.exit(1) }
if (!SERVICE_ROLE) { console.error('✗ SUPABASE_SERVICE_ROLE_KEY is not set (Dashboard → Project Settings → API Keys)'); process.exit(1) }
if (!PASSWORD) { console.error('✗ TEST_USER_PASSWORD is not set — there is deliberately no default'); process.exit(1) }
if (PASSWORD.length < 8) { console.error('✗ TEST_USER_PASSWORD must be at least 8 characters'); process.exit(1) }

/**
 * Supabase-js errors frequently carry an empty `.message`, so printing
 * `e.message` yields "listUsers: {}" and hides the real cause. Always
 * surface status/code/message plus the raw object.
 */
function describeError(e) {
  if (!e) return 'unknown error'
  const parts = []
  if (e.status) parts.push(`HTTP ${e.status}`)
  if (e.code) parts.push(`code=${e.code}`)
  const msg = e.message && String(e.message).trim()
  if (msg) parts.push(`message=${msg}`)
  const extra = []
  for (const k of ['hint', 'details', 'error_description', 'error']) {
    const v = e[k]
    if (typeof v === 'string' && v.trim()) extra.push(`${k}=${v.trim()}`)
  }
  let out = parts.join(' ') || '(no message — the server returned an empty error body)'
  if (extra.length) out += ` | ${extra.join(' | ')}`
  if (!parts.length && !extra.length) {
    try {
      const s = JSON.stringify(e)
      if (s && s !== '{}') out += ` raw=${s.slice(0, 400)}`
    } catch { /* circular */ }
  }
  return out
}

/**
 * Identify WHICH key was pasted. This turns the most common cause of an
 * auth failure ("I used the anon key") into an explicit message instead
 * of an opaque server error.
 */
function describeKey(key) {
  if (key.startsWith('sb_secret_')) return { kind: 'new secret key (sb_secret_)', ok: true }
  if (key.startsWith('sb_publishable_')) {
    return { kind: 'PUBLISHABLE key (sb_publishable_)', ok: false,
             fix: 'That is the PUBLIC key. The Admin API needs the secret/service_role key — Dashboard → Project Settings → API Keys → Secret.' }
  }
  if (key.startsWith('eyJ')) {
    // legacy JWT: decode the payload to confirm the role
    try {
      const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8'))
      const role = payload.role
      if (role === 'service_role') return { kind: 'legacy service_role JWT', ok: true }
      return { kind: `legacy JWT but role="${role}"`, ok: false,
               fix: 'This is the wrong key. Use the service_role key (Dashboard → Project Settings → API Keys).' }
    } catch {
      return { kind: 'legacy-looking JWT (could not decode)', ok: false,
               fix: 'Key looks malformed. Re-copy the service_role key from the Dashboard.' }
    }
  }
  return { kind: 'unrecognised key format', ok: false,
           fix: 'Expected a key starting with eyJ (legacy JWT) or sb_secret_ (new). Check you copied the whole key with no extra characters.' }
}

const includeAdmin = process.argv.includes('--include-admin')
const keepExisting = process.argv.includes('--keep-existing')

// SECTOR-15-A is a real root CENTRE (parent_centre IS NULL) with two SC_SPs,
// DHATIR and GREATER FARIDABAD — so a centre_user there should see 3 centres.
const CENTRE = 'SECTOR-15-A'
// Synthetic, deliberately not a real FB/BH/VS sewadar badge.
const SCANNER_BADGE = 'SC-TEST-01'

// Narrow on purpose: this same pattern guards the DELETE below, so it must
// match ONLY our own test accounts — not anything else on the domain.
const TEST_EMAIL_RE = /^test\.[a-z0-9._-]+@portal\.test$/i
const isTestEmail = (e) => TEST_EMAIL_RE.test(String(e || '').trim())

const USERS = [
  ...(includeAdmin ? [{ email: 'test.superadmin@portal.test', name: 'Test Super Admin', role: 'super_admin', badge: null }] : []),
  { email: 'test.aso@portal.test',          name: 'Test ASO',          role: 'aso',           badge: null },
  { email: 'test.operator@portal.test',     name: 'Test VSS Operator', role: 'vss_operator',  badge: null },
  { email: 'test.centre.admin@portal.test', name: 'Test Centre Admin', role: 'centre_admin',  badge: null },
  { email: 'test.centre.user@portal.test',  name: 'Test Centre User',  role: 'centre_user',   badge: null },
  { email: 'test.scanner@portal.test',      name: 'Test Scanner',      role: 'scanner',       badge: SCANNER_BADGE },
  // badge is filled in at runtime from a real deployed sewadar
  { email: 'test.incharge@portal.test',     name: 'Test Dept Incharge', role: 'dept_incharge', badge: null },
]

// service_role bypasses RLS — required to read/write auth + portal rows.
const supabase = createClient(URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const ok = (m) => console.log(`  ✓ ${m}`)
const bad = (m) => console.log(`  ✗ ${m}`)

/**
 * Key preflight WITHOUT GoTrue.
 *
 * listUsers may itself be the thing that is 500ing, so validating the key
 * through it would conflate "bad key" with "broken auth rows". A PostgREST
 * read of a public table proves the key is accepted by the API without
 * touching GoTrue at all.
 */
async function preflightKey() {
  const info = describeKey(SERVICE_ROLE)
  console.log(`  key: ${info.kind}`)
  if (!info.ok) {
    bad(info.fix)
    throw new Error(`refusing to continue with a non-admin key (${info.kind})`)
  }
  const { data, error } = await supabase.from('dp_centres').select('name').limit(1)
  if (error) throw new Error(`key rejected by the API: ${describeError(error)}`)
  ok(`key accepted by the API (PostgREST reachable, ${data?.length ?? 0} row(s) sampled)`)
}

/**
 * Pre-clean WITHOUT GoTrue.
 *
 * WHY: listUsers (GET /auth/v1/admin/users) enumerates and marshals EVERY
 * user, so if any hand-inserted row is malformed it 500s — and then we
 * could never use the Admin API to remove that row. Deadlock.
 *
 * The auth_ids are already mirrored in public.portal_users, and PostgREST
 * reads the public schema perfectly well. So: read the ids there, then
 * delete each user individually (DELETE ... WHERE id = $1), which touches
 * one row and never enumerates.
 *
 * NOTE ON CASCADE DIRECTION (verified, and a trap): portal_users.auth_id
 * is `REFERENCES auth.users(id) ON DELETE CASCADE`, which cascades the
 * OTHER way — deleting an auth.users row removes the portal_users rows
 * pointing at it. Deleting the portal_users row does NOT delete the auth
 * user. So the ids must be captured BEFORE any portal_users delete.
 */
async function preClean() {
  const { data: rows, error } = await supabase
    .from('portal_users').select('auth_id,email,role').like('email', 'test.%@portal.test')
  if (error) throw new Error(`reading portal_users: ${describeError(error)}`)

  const ids = [...new Set((rows || []).map((r) => r.auth_id).filter(Boolean))]
  if (!ids.length) {
    ok('no test portal_users rows to clean')
    return
  }
  console.log(`  found ${ids.length} test auth user(s) to remove`)

  for (const id of ids) {
    const { error: dErr } = await supabase.auth.admin.deleteUser(id)
    if (dErr) {
      bad(`deleteUser ${id.slice(0, 8)}…: ${describeError(dErr)}`)
      console.log('\n  ⚠️  GoTrue refused the delete, so the malformed row is still there.')
      console.log('     Run sql/purge_test_auth_users.sql in the Supabase SQL Editor,')
      console.log('     then run this script again.\n')
      throw new Error('pre-clean failed — nothing further was attempted')
    }
    ok(`deleted auth user ${id.slice(0, 8)}…`)
  }
}

/** Walk listUsers pages, return every auth user. */
async function allAuthUsers() {
  const out = []
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw new Error(`listUsers: ${describeError(error)}`)
    out.push(...(data?.users || []))
    if (!data?.users?.length || data.users.length < 200) break
  }
  return out
}

/**
 * Find a real deployed sewadar to act as, so dept_incharge's badge is a
 * badge that genuinely exists. trg_check_incharge_selection enforces that
 * the badge is deployed to the department in an OPEN schedule, and it is
 * SECURITY DEFINER — but service_role still yields a NULL portal role,
 * and `IF NULL` is false, so the "Only ASO" branch does not block us.
 */
async function findInchargeTarget() {
  const { data: scheds, error: e1 } = await supabase
    .from('deployment_schedules').select('id,name,status').eq('status', 'open').limit(20)
  if (e1) return { err: `deployment_schedules: ${describeError(e1)}` }
  if (!scheds?.length) return { none: true }

  for (const s of scheds) {
    const { data: deps, error: e2 } = await supabase
      .from('deployments')
      .select('badge_number,centre,sewadar_name,department_id,deployed_department_id')
      .eq('schedule_id', s.id)
    if (e2) return { err: `deployments: ${describeError(e2)}` }
    const d = (deps || []).find((r) => r.deployed_department_id || r.department_id)
    if (d) return { target: { schedule: s, badge: d.badge_number, centre: d.centre, dept: d.deployed_department_id || d.department_id } }
  }
  return { none: true }
}

async function main() {
  console.log(`\nRebuilding test logins on ${URL.replace(/\/\/.*@/, '//')}`)
  console.log(`mode: ${keepExisting ? 'keep existing auth users' : 'DELETE then recreate'}\n`)

  // ---- 0a. Validate the key WITHOUT GoTrue (listUsers may be what's broken)
  await preflightKey()

  // ---- 0. CENTRE must exist, else every row silently has a bad centre
  const { data: centreRow, error: cErr } = await supabase
    .from('dp_centres').select('name,parent_centre').eq('name', CENTRE).maybeSingle()
  if (cErr) throw new Error(`dp_centres: ${describeError(cErr)}`)
  if (!centreRow) throw new Error(`centre "${CENTRE}" not found in dp_centres — edit CENTRE in this script`)
  ok(`centre ${CENTRE} exists (parent_centre=${centreRow.parent_centre ?? 'NULL → root CENTRE'})`)

  // ---- 1. Resolve the dept_incharge badge from real data
  let incharge = null
  const probe = await findInchargeTarget()
  if (probe.err) bad(probe.err)
  else if (probe.none) {
    bad('no OPEN schedule with a deployed sewadar found → dept_incharge will be skipped')
    console.log('     finish a deployment on the Schedule Maker, then re-run')
  } else {
    incharge = probe.target
    ok(`incharge target found: badge=${incharge.badge} centre=${incharge.centre}`)
  }

  // ---- 2. PRE-CLEAN the malformed auth rows BEFORE any GoTrue listing.
  //         This must come first: listUsers marshals every user, so a bad
  //         row 500s the whole call and we could never delete it that way.
  //         auth_ids come from public.portal_users (PostgREST, not GoTrue).
  if (!keepExisting) {
    await preClean()
  } else {
    ok('--keep-existing: not removing any auth users')
  }

  // ---- 2b. Remove leftover portal rows and selections. Capture-first note:
  //          portal_users.auth_id is ON DELETE CASCADE but that cascades the
  //          OTHER way (auth -> portal), so deleting here does NOT touch
  //          auth.users. Safe to do now that preClean has run.
  await supabase.from('department_incharge_selections')
    .delete().in('selected_by', ['create_test_users_direct', 'provision_test_logins', 'rebuild_test_logins'])
  const { error: delErr } = await supabase.from('portal_users').delete().like('email', 'test.%@portal.test')
  if (delErr) bad(`clearing portal_users: ${describeError(delErr)}`)
  else ok('cleared leftover test portal_users rows')

  // ---- 3. NOW verify GoTrue can enumerate (should be healthy post-clean)
  let lastErr = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 })
    if (!error) { ok(`GoTrue healthy — admin API enumerated ${data?.users?.length ?? 0}+ user(s)`); lastErr = null; break }
    lastErr = error
    if (attempt < 3) {
      process.stderr.write(`    attempt ${attempt} failed (${describeError(error)}) — retrying…\n`)
      await new Promise((r) => setTimeout(r, 800 * attempt))
    }
  }
  if (lastErr) {
    bad(`GoTrue still failing after pre-clean: ${describeError(lastErr)}`)
    console.log('\n  ⚠️  The bad rows are gone but auth.admin is still 500ing.')
    console.log('     Check Dashboard → Authentication → Logs for the server error.\n')
    throw new Error('auth.admin unavailable — no users were created')
  }

  // ---- 4. Create through GoTrue — this is what actually fixes the login 500
  const created = {}
  for (const u of USERS) {
    if (u.role === 'dept_incharge' && !incharge) continue
    const badge = u.role === 'dept_incharge' ? incharge.badge : u.badge
    const centre = u.role === 'dept_incharge' ? incharge.centre : CENTRE
    const meta = { name: u.name, role: u.role, centre, badge_number: badge }
    const { data, error } = await supabase.auth.admin.createUser({
      email: u.email, password: PASSWORD, email_confirm: true, user_metadata: meta,
    })
    if (error) { bad(`create ${u.email}: ${describeError(error)}`); continue }
    created[u.email] = { id: data.user.id, badge, centre, role: u.role, name: u.name }
    ok(`created ${u.role.padEnd(13)} ${u.email}`)
  }

  // ---- 5. Link portal_users by auth_id (the lookup you originally asked for)
  const rows = Object.values(created).map((r) => ({
    auth_id: r.id, name: r.name, email: Object.keys(created).find((k) => created[k].id === r.id),
    badge_number: r.badge, centre: r.centre, role: r.role, permissions: {}, is_active: true,
  }))
  const { error: upErr } = await supabase.from('portal_users').upsert(rows, { onConflict: 'auth_id' })
  if (upErr) bad(`portal_users upsert: ${describeError(upErr)}`)
  else ok(`portal_users linked (${rows.length} rows)`)

  // ---- 6. Wire the incharge selection so get_my_dept_ids() resolves
  if (incharge && created['test.incharge@portal.test']) {
    const { error: selErr } = await supabase.from('department_incharge_selections').upsert(
      {
        schedule_id: incharge.schedule.id, centre: incharge.centre,
        department_id: incharge.dept, badge_number: incharge.badge,
        rank: 1, is_from_pool: false, selected_by: 'rebuild_test_logins',
      },
      { onConflict: 'schedule_id,centre,department_id,badge_number', ignoreDuplicates: true }
    )
    if (selErr) bad(`incharge selection: ${describeError(selErr)}`)
    else ok(`incharge selection wired (dept ${incharge.dept})`)
  }

  // ---- 7. Verify: the columns GoTrue reads must be non-NULL now
  const { data: check, error: chkErr } = await supabase
    .from('portal_users').select('email,role,centre,badge_number,is_active,auth_id').like('email', '%@portal.test').order('role')
  if (chkErr) { bad(`verify: ${describeError(chkErr)}`); return }

  console.log('\nPortal rows:')
  for (const r of check || []) {
    console.log(`  ${r.role.padEnd(13)} ${r.email.padEnd(30)} centre=${r.centre} badge=${r.badge_number ?? '—'} auth=${r.auth_id ? 'linked' : 'MISSING'}`)
  }
  console.log(`\nSign in at the portal with password: ${PASSWORD}`)
  console.log('Then run: sql/verify_test_logins.sql   (checks 1-5 must PASS)')
  if (!includeAdmin) console.log('Note: no super_admin test login (add --include-admin if you need one)')
}

main().catch((e) => { console.error(`\n✗ FAILED: ${describeError(e)}`); process.exit(1) })
