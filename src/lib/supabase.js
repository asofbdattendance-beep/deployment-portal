import { createClient } from '@supabase/supabase-js'
import {
  getParentCentres,
  getRootCentre,
  getSubtreeCentres,
  notElderlyFilter,
  eligibleBadgeStatusFilter,
  badgeStatusEligible,
  isAssoDepartment,
  canCentreDeploy,
  shouldHideFromConsent,
} from './logic'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables. Check your .env file.')
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: true, autoRefreshToken: true },
  realtime: { params: { eventsPerSecond: 10 } }
})

export const ROLES = {
  CENTRE_USER: 'centre_user',
  CENTRE_ADMIN: 'centre_admin',
  ASO: 'aso',
  SUPER_ADMIN: 'super_admin',
  DEPT_INCHARGE: 'dept_incharge',
  SCANNER: 'scanner',
  VSS_OPERATOR: 'vss_operator',
}

export const ROLE_LABELS = {
  centre_user: 'Centre User',
  centre_admin: 'Centre Admin',
  aso: 'ASO',
  super_admin: 'ASO',
  dept_incharge: 'Dept Incharge',
  scanner: 'Scanner',
  vss_operator: 'VSS Operator',
}

export const ROLE_COLORS = {
  centre_user: '#6366f1',
  centre_admin: '#8b5cf6',
  aso: '#f59e0b',
  super_admin: '#ef4444',
  dept_incharge: '#0ea5e9',
  scanner: '#10b981',
  vss_operator: '#0d9488',
}

export async function getMyDeptIds(scheduleId) {
  if (!scheduleId) return []
  const { data } = await supabase.rpc('get_my_dept_ids', { p_schedule: scheduleId })
  return data || []
}

// ── Pagination helper (v22) ────────────────────────────────
// Supabase / PostgREST caps single-query rows at 1000 (max-rows). Any table
// that can exceed 1000 (3597+ sewadars live) must be fetched via ranged
// pagination, otherwise rows beyond 1000 are silently dropped.
// `applyFilters` receives the query builder and may chain .eq/.in/.or/.order
// — the helper appends .range() and loops until a short page is returned.
// Keep `fetchAll` / `fetchAllFrom` as aliases for ergonomics at call sites.
export async function fetchAllRows(table, selectColumns = '*', applyFilters = null) {
  const pageSize = 1000
  let from = 0
  let all = []
  while (true) {
    let q = supabase.from(table).select(selectColumns)
    if (typeof applyFilters === 'function') {
      const maybe = applyFilters(q)
      if (maybe) q = maybe
    }
    q = q.range(from, from + pageSize - 1)
    const { data, error } = await q
    if (error) throw error
    all.push(...(data || []))
    if (!data || data.length < pageSize) break
    from += pageSize
  }
  return all
}
export const fetchAll = fetchAllRows
export const fetchAllFrom = fetchAllRows
export const fetchPaginated = fetchAllRows

// ASO-dept sewadars (home department = AREA SECRETARY OFFICE) are deployed by
// the super_admin and never consume a centre's deployment quota (v35 — mirrored
// DB-side in get_dept_quota_remaining + the batch re-checks). Deployment rows
// live in one shared table and carry no home-department column, so a page that
// only holds ONE population's sewadar rows locally (Consent & Deploy = regular
// sewadars, VSS = vss_sewadars) can't tell an ASO-dept deployment of the OTHER
// population apart from a normal one — its savedAllCounts would count those
// rows and inflate the quota bars / block eligible bulk assignments ("Quota
// full"). This helper returns the full `${centre}|${badge_number}` key set for
// ASO-dept sewadars across BOTH populations, so any page can exclude their
// deployment rows regardless of which list it loaded.
export async function fetchAsoDeptKeys(centres) {
  if (!centres || !centres.length) return new Set()
  const keys = new Set()
  for (const table of ['dp_sewadars', 'vss_sewadars']) {
    const rows = await fetchAllRows(table, 'centre, badge_number, department', (q) => q.in('centre', centres))
    ;(rows || []).forEach(r => {
      if (isAssoDepartment(r.department)) keys.add(`${r.centre}|${r.badge_number}`)
    })
  }
  return keys
}

// ── DB-side count helper (v22.1) ───────────────────────────────────
// Returns exact count via PostgREST head:true — NO rows are downloaded.
// Use for pure-count stats (headers, badges, quota totals) where the rows
// themselves are NOT needed for display. For table/matrix rows that ARE
// displayed, keep fetchAllRows + client counting (no extra download beyond
// the table). Example:
//   const total = await getCount('deployments', q => q.eq('schedule_id', sid))
export async function getCount(table, applyFilters = null) {
  let q = supabase.from(table).select('*', { count: 'exact', head: true })
  if (typeof applyFilters === 'function') {
    const maybe = applyFilters(q)
    if (maybe) q = maybe
  }
  const { count, error } = await q
  if (error) throw error
  return count ?? 0
}

// ── Grouped-count helper (v22.1) ──────────────────────────────────
// Grouped counts (per-centre / per-department tallies) are best served by
// a DB RPC (e.g. get_deployment_matrix_counts) that aggregates server-side.
// This helper is a placeholder that documents the intent: for now it returns
// null so callers fall back to client aggregation; once the RPC migration
// ships, callers can prefer RPC with fallback (see DeploymentMatrixReport).
// Signature: getGroupedCounts(table, groupColumns, selectExtra, applyFilters)
export async function getGroupedCounts(
  _table,
  _groupColumns,
  _selectExtra = null,
  _applyFilters = null,
) {
  // Intentionally not implemented client-side — grouped counts without an
  // RPC would still download all rows. Callers should attempt
  // supabase.rpc('get_deployment_matrix_counts', ...) first and fall back
  // to fetchAllRows + JS grouping only if the RPC is missing.
  return null
}

export async function fetchCentres() {
  // 40 rows today — still paginated via fetchAllRows so a future import never hits the 1000 cap silently
  return fetchAllRows('dp_centres', 'id, name, parent_centre', (q) => q.order('name'))
}

export async function fetchPortalSettings() {
  const { data, error } = await supabase.from('portal_settings').select('*').eq('id', 1).maybeSingle()
  if (error) throw error
  return {
    sewadar_deployment_open: data?.sewadar_deployment_open !== false,
    vss_deployment_open: data?.vss_deployment_open === true,
    vss_creation_open: data?.vss_creation_open === true,
    updated_by: data?.updated_by || null,
    updated_at: data?.updated_at || null,
  }
}

export async function setPortalSetting(key, value, updatedBy = null) {
  const { error } = await supabase
    .from('portal_settings')
    .update({
      [key]: value,
      updated_at: new Date().toISOString(),
      ...(updatedBy ? { updated_by: updatedBy } : {}),
    })
    .eq('id', 1)
  if (error) throw error
}

export async function fetchSubtreeCentres(centreName) {
  const centres = await fetchCentres()
  return { centres, subtree: getSubtreeCentres(centres, centreName) }
}

// ── Control Panel overrides (v21) ────────────────────────────
// Presence of a centre_overrides row OPENS deployment writing for its
// scope (centre '*' = all; department_id null = all departments).
export async function fetchCentreOverrides(scheduleId) {
  if (!scheduleId) return []
  return fetchAllRows(
    'centre_overrides',
    'id, schedule_id, centre, department_id, undeployed_only, note, created_by, created_at',
    (q) => q.eq('schedule_id', scheduleId),
  )
}

// Upsert-by-hand: Postgres treats NULL department_id values as distinct in
// UNIQUE indexes, so ON CONFLICT can't infer "all departments" rows —
// we remove the existing override for this EXACT scope (centre + department +
// undeployed_only flag) before inserting, so a centre can hold BOTH a normal
// and an undeployed-only override at once.
export async function setCentreOverride({ scheduleId, centre, departmentId = null, undeployedOnly = false, createdBy = null }) {
  await removeCentreOverride({ scheduleId, centre, departmentId, undeployedOnly })
  const { error } = await supabase
    .from('centre_overrides')
    .insert({
      schedule_id: scheduleId,
      centre,
      department_id: departmentId,
      undeployed_only: undeployedOnly,
      ...(createdBy ? { created_by: createdBy } : {}),
    })
  if (error) throw error
}

// Remove the override row matching the exact scope (centre + department +
// undeployed_only flag). Used to close a single override without disturbing
// any other scope that may coexist for the same centre.
export async function removeCentreOverride({ scheduleId, centre, departmentId = null, undeployedOnly = false }) {
  let q = supabase
    .from('centre_overrides')
    .delete()
    .eq('schedule_id', scheduleId)
    .eq('centre', centre)
  // PostgREST requires .is() for null comparisons — .eq('col', null) sends
  // "col=eq.null" which is a literal string match, not SQL IS NULL.
  q = departmentId == null ? q.is('department_id', null) : q.eq('department_id', departmentId)
  q = q.eq('undeployed_only', undeployedOnly)
  const { error } = await q
  if (error) throw error
}

// Remove every override row for the given schedule + centre (both
// department-scoped and centre-wide / wildcard rows, including undeployed-only).
// This is safe to call even when no row exists.
export async function removeAllCentreOverrides({ scheduleId, centre }) {
  const { error } = await supabase
    .from('centre_overrides')
    .delete()
    .eq('schedule_id', scheduleId)
    .eq('centre', centre)
  if (error) throw error
}

// Tri-state VSS knobs per centre ('*' = all): creation_open / deployment_open,
// null = inherit the global switch.
export async function fetchVssOverrides() {
  return fetchAllRows('centre_vss_overrides', '*', (q) => q.order('centre'))
}

export async function setVssOverride(centre, patch, updatedBy = null) {
  const { error } = await supabase
    .from('centre_vss_overrides')
    .upsert(
      { centre, ...patch, updated_at: new Date().toISOString(), ...(updatedBy ? { updated_by: updatedBy } : {}) },
      { onConflict: 'centre' }
    )
  if (error) throw error
}

// ── vss-photos (PRIVATE bucket — v16) ───────────────────────
// The bucket used to be public; photos stored then are full public URLs,
// new writes store the bare path (reg/...). This resolves either form to a
// time-limited signed URL so only authenticated users with access can view
// a photo. Results are cached for an hour per path.
const vssPhotoUrlCache = new Map() // path -> { url, expiresAt }

export async function vssPhotoUrl(photoUrlOrPath) {
  if (!photoUrlOrPath) return null
  const path = String(photoUrlOrPath).split('/vss-photos/')[1] || String(photoUrlOrPath)
  const cached = vssPhotoUrlCache.get(path)
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.url
  const { data, error } = await supabase.storage.from('vss-photos').createSignedUrl(path, 3600)
  if (error || !data?.signedUrl) return null
  vssPhotoUrlCache.set(path, { url: data.signedUrl, expiresAt: Date.now() + 3600_000 })
  return data.signedUrl
}

export { getParentCentres, getRootCentre, getSubtreeCentres, notElderlyFilter, eligibleBadgeStatusFilter, badgeStatusEligible, isAssoDepartment, canCentreDeploy, shouldHideFromConsent }
