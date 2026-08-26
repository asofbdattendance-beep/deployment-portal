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
}

export const ROLE_LABELS = {
  centre_user: 'Centre User',
  centre_admin: 'Centre Admin',
  aso: 'ASO',
  super_admin: 'ASO',
}

export const ROLE_COLORS = {
  centre_user: '#6366f1',
  centre_admin: '#8b5cf6',
  aso: '#f59e0b',
  super_admin: '#ef4444',
}

export async function fetchCentres() {
  const { data, error } = await supabase.from('centres').select('id, name, parent_centre').order('name')
  if (error) throw error
  return data || []
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
  const { data, error } = await supabase
    .from('centre_overrides')
    .select('id, schedule_id, centre, department_id, undeployed_only, note, created_by, created_at')
    .eq('schedule_id', scheduleId)
  if (error) throw error
  return data || []
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
  const { data, error } = await supabase.from('centre_vss_overrides').select('*').order('centre')
  if (error) throw error
  return data || []
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
