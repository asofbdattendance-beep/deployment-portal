import { createClient } from '@supabase/supabase-js'

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
  super_admin: 'Super Admin',
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

export function getParentCentres(centres) {
  return (centres || []).filter(c => !c.parent_centre)
}

export function getRootCentre(centres, centreName) {
  if (!centreName) return null
  const byName = {}
  ;(centres || []).forEach(c => { byName[c.name] = c })
  let cur = byName[centreName]
  if (!cur) return centreName
  let guard = 0
  while (cur.parent_centre && byName[cur.parent_centre] && guard < 20) {
    cur = byName[cur.parent_centre]
    guard++
  }
  return cur.name
}

export function getSubtreeCentres(centres, centreName) {
  if (!centreName) return []
  const children = {}
  ;(centres || []).forEach(c => {
    if (!children[c.parent_centre]) children[c.parent_centre] = []
    children[c.parent_centre].push(c.name)
  })
  const result = []
  const stack = [centreName]
  let guard = 0
  while (stack.length && guard < 100) {
    const cur = stack.pop()
    result.push(cur)
    ;(children[cur] || []).forEach(ch => stack.push(ch))
    guard++
  }
  return result
}

export async function fetchSubtreeCentres(centreName) {
  const centres = await fetchCentres()
  return { centres, subtree: getSubtreeCentres(centres, centreName) }
}

export async function fetchRemainingQuota(scheduleId, departmentId) {
  const { data, error } = await supabase.rpc('get_remaining_quota', {
    p_schedule: scheduleId,
    p_department: departmentId,
  })
  if (error) throw error
  return data ?? 0
}
