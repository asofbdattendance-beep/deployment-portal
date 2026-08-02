import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'

const PortalAuthContext = createContext(null)

export function PortalAuthProvider({ children }) {
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [session, setSession] = useState(null)

  const fetchProfile = useCallback(async () => {
    const { data, error } = await supabase.rpc('get_portal_profile')

    if (error) {
      console.error('Error fetching portal profile:', error)
      return null
    }
    return data
  }, [])

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session: s } }) => {
      setSession(s)
      if (s?.user) {
        const p = await fetchProfile()
        setProfile(p)
      }
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, s) => {
      setSession(s)
      if (s?.user) {
        const p = await fetchProfile()
        setProfile(p)
      } else {
        setProfile(null)
      }
    })

    return () => subscription?.unsubscribe()
  }, [fetchProfile])

  const signIn = async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
  }

  const signOut = async () => {
    await supabase.auth.signOut()
    setProfile(null)
    setSession(null)
  }

  const hasPermission = useCallback((perm) => {
    if (!profile) return false
    if (profile.role === 'super_admin') return true
    return profile.permissions?.[perm] === true
  }, [profile])

  const value = {
    profile,
    session,
    loading,
    signIn,
    signOut,
    hasPermission,
    isAuthenticated: !!session,
  }

  return (
    <PortalAuthContext.Provider value={value}>
      {children}
    </PortalAuthContext.Provider>
  )
}

export function usePortalAuth() {
  const context = useContext(PortalAuthContext)
  if (!context) {
    throw new Error('usePortalAuth must be used within PortalAuthProvider')
  }
  return context
}
