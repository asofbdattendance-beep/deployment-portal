import { createClient } from '@supabase/supabase-js'
import {
  getParentCentres,
  getRootCentre,
  getSubtreeCentres,
  notElderlyFilter,
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

export async function fetchPortalSettings() {
  const { data, error } = await supabase.from('portal_settings').select('*').eq('id', 1).maybeSingle()
  if (error) throw error
  return {
    sewadar_deployment_open: data?.sewadar_deployment_open !== false,
    vss_deployment_open: data?.vss_deployment_open === true,
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

export { getParentCentres, getRootCentre, getSubtreeCentres, notElderlyFilter }
