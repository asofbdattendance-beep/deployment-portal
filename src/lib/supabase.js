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

export async function fetchSubtreeCentres(centreName) {
  const centres = await fetchCentres()
  return { centres, subtree: getSubtreeCentres(centres, centreName) }
}

export { getParentCentres, getRootCentre, getSubtreeCentres, notElderlyFilter }
